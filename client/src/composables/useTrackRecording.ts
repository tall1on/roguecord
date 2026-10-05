import { onScopeDispose, ref, shallowRef } from 'vue'

type RecordingStopReason = 'track_finished' | 'track_abandoned' | 'camera_off' | 'timeout' | 'driver_left' | 'run_ended'

type TrackRecordingOptions = {
  getChannelId: () => string | null
  isJoined: () => boolean
  getCameraStream: () => MediaStream | null
  send: (type: string, payload: Record<string, unknown>) => void
  addMessageListener: (listener: (message: any) => void) => void
  removeMessageListener: (listener: (message: any) => void) => void
  storeRecording: (input: { runId: string; file: Blob; mimeType: string; durationMs: number }) => Promise<void>
}

const DEFAULT_MAX_DURATION_MS = 3 * 60 * 1000
const MIN_UPLOAD_DURATION_MS = 1000
const RECORDING_MIME_CANDIDATES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4']

const pickRecordingMimeType = (): string | null => {
  if (typeof MediaRecorder === 'undefined') return null
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate
    } catch (_error) {
      // Ignore unsupported candidate probes.
    }
  }
  return ''
}

/**
 * Records the driver's own camera feed while the server keeps a track recording session open.
 *
 * Capture happens on the driver's device (the only place the raw camera stream exists) and the
 * finished clip is uploaded to the server, which stores it in the data directory or S3 and links
 * it to the run for download from the leaderboard.
 */
export const useTrackRecording = (options: TrackRecordingOptions) => {
  const isRecording = ref(false)
  const error = ref<string | null>(null)
  const recordingRunId = ref<string | null>(null)
  const isUploading = ref(false)
  const recorder = shallowRef<MediaRecorder | null>(null)
  let chunks: Blob[] = []
  let startedAt = 0
  let capTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pendingRunId: string | null = null
  let maxDurationMs = DEFAULT_MAX_DURATION_MS

  const clearTimers = () => {
    if (capTimer !== null) { clearTimeout(capTimer); capTimer = null }
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
  }

  const finalize = async (): Promise<void> => {
    const activeRecorder = recorder.value
    const runId = recordingRunId.value
    const mimeType = activeRecorder?.mimeType || 'video/webm'
    const durationMs = Math.max(0, Date.now() - startedAt)
    const recordedChunks = chunks
    chunks = []
    recorder.value = null
    isRecording.value = false
    recordingRunId.value = null
    pendingRunId = null
    if (!runId) return
    const blob = new Blob(recordedChunks, { type: mimeType })
    if (blob.size <= 0 || durationMs < MIN_UPLOAD_DURATION_MS) return
    isUploading.value = true
    try {
      // Store durably first; the uploads store retries until the server acknowledges the clip.
      await options.storeRecording({ runId, file: blob, mimeType, durationMs })
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Could not store the recording for upload.'
      console.error('[Drive][recording] Failed to store recording:', cause)
    } finally {
      isUploading.value = false
    }
  }

  const stop = (reason: RecordingStopReason = 'run_ended'): void => {
    clearTimers()
    const activeRecorder = recorder.value
    if (!activeRecorder) return
    if (activeRecorder.state === 'inactive') {
      void finalize()
      return
    }
    try {
      activeRecorder.stop()
    } catch (cause) {
      console.error(`[Drive][recording] Failed to stop recorder (${reason}):`, cause)
      void finalize()
    }
  }

  const beginRecording = (runId: string, maxMs: number): boolean => {
    const stream = options.getCameraStream()
    const videoTrack = stream?.getVideoTracks()[0]
    if (!stream || !videoTrack || videoTrack.readyState !== 'live') return false
    const mimeType = pickRecordingMimeType()
    if (mimeType === null) {
      error.value = 'Camera recording is not supported by this browser.'
      return false
    }

    try {
      const nextRecorder = new MediaRecorder(stream, mimeType
        ? { mimeType, videoBitsPerSecond: 600_000 }
        : { videoBitsPerSecond: 600_000 })
      chunks = []
      startedAt = Date.now()
      recordingRunId.value = runId
      pendingRunId = null
      error.value = null

      nextRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data)
      }
      nextRecorder.onerror = (event) => {
        error.value = 'Camera recording failed unexpectedly.'
        console.error('[Drive][recording] Recorder error:', event)
        void finalize()
      }
      nextRecorder.onstop = () => {
        void finalize()
      }

      recorder.value = nextRecorder
      nextRecorder.start(1000)
      isRecording.value = true
      maxDurationMs = Number.isFinite(maxMs) && maxMs > 0 ? Math.min(maxMs, DEFAULT_MAX_DURATION_MS) : DEFAULT_MAX_DURATION_MS
      capTimer = setTimeout(() => stop('timeout'), maxDurationMs)
      return true
    } catch (cause) {
      error.value = 'Could not start camera recording.'
      console.error('[Drive][recording] Failed to start recorder:', cause)
      recorder.value = null
      recordingRunId.value = null
      return false
    }
  }

  const tryStart = (runId: string, maxMs: number): void => {
    if (isRecording.value) return
    if (beginRecording(runId, maxMs)) return
    // The local camera stream can lag the server's producer notification by a moment.
    pendingRunId = runId
    let attempts = 0
    const retry = () => {
      retryTimer = null
      if (pendingRunId !== runId || isRecording.value) return
      if (beginRecording(runId, maxMs)) return
      if (++attempts < 6) retryTimer = setTimeout(retry, 300)
      else pendingRunId = null
    }
    retryTimer = setTimeout(retry, 300)
  }

  const handleMessage = (message: any) => {
    const type = message?.type
    const payload = message?.payload
    if (!payload || payload.channel_id !== options.getChannelId()) return

    if (type === 'drive_recording_start' && typeof payload.run_id === 'string') {
      if (!options.isJoined() || isRecording.value) return
      // The server only starts a session once it has seen the camera producer, but the local
      // stream/producer can still be settling, so tryStart retries until the stream is live.
      const maxMs = typeof payload.max_duration_ms === 'number' ? payload.max_duration_ms : DEFAULT_MAX_DURATION_MS
      tryStart(payload.run_id, maxMs)
      return
    }

    if (type === 'drive_recording_stop' && typeof payload.run_id === 'string') {
      if (payload.run_id === recordingRunId.value || payload.run_id === pendingRunId) {
        pendingRunId = null
        stop((payload.reason as RecordingStopReason) || 'run_ended')
      }
    }
  }

  options.addMessageListener(handleMessage)
  const dispose = () => {
    options.removeMessageListener(handleMessage)
    clearTimers()
    pendingRunId = null
    if (recorder.value && recorder.value.state !== 'inactive') {
      try { recorder.value.stop() } catch (_error) { void finalize() }
    } else if (isRecording.value) {
      void finalize()
    }
  }
  onScopeDispose(dispose)

  return { isRecording, isUploading, error, recordingRunId, dispose }
}
