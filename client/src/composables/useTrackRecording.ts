import { onScopeDispose, ref } from 'vue'

type RecordingStopReason = 'track_finished' | 'track_abandoned' | 'camera_off' | 'timeout' | 'driver_left' | 'run_ended'

type TrackRecordingOptions = {
  getChannelId: () => string | null
  isJoined: () => boolean
  getCameraStream: () => MediaStream | null
  /** Identifies the guild connection so a finished clip is only ever uploaded to its own server. */
  getConnectionId?: () => string | null
  send: (type: string, payload: Record<string, unknown>) => void
  addMessageListener: (listener: (message: any) => void) => void
  removeMessageListener: (listener: (message: any) => void) => void
  storeRecording: (input: {
    runId: string
    file: Blob
    mimeType: string
    durationMs: number
    connectionId: string | null
  }) => Promise<void> | void
}

/** One in-flight MediaRecorder plus everything owned by that recording. */
type RecordingSession = {
  runId: string
  recorder: MediaRecorder
  chunks: Blob[]
  startedAt: number
  capTimer: ReturnType<typeof setTimeout> | null
  stopping: boolean
  finalized: boolean
}

type PendingStart = { runId: string; maxMs: number }

const DEFAULT_MAX_DURATION_MS = 3 * 60 * 1000
const MIN_UPLOAD_DURATION_MS = 1000
const START_RETRY_DELAY_MS = 300
const START_MAX_ATTEMPTS = 6
const RECORDING_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm'
]

const DEFAULT_RECORDING_WIDTH = 640
const DEFAULT_RECORDING_HEIGHT = 480
const DEFAULT_RECORDING_FRAME_RATE = 20
const MIN_RECORDING_VIDEO_BITRATE = 3_000_000
const MAX_RECORDING_VIDEO_BITRATE = 12_000_000
// ~0.2 bits per pixel per frame is visually transparent for webcam footage while staying below the
// point where the encoder wastes bits on sensor noise. The old fixed 600 kbps budget was far lower
// (roughly 0.05 bpp at 640x480@20), which is what made saved MP4 clips look blocky.
const RECORDING_BITS_PER_PIXEL = 0.2

/**
 * Derives the recording bitrate from the camera track's real output so a high-resolution capture is
 * never starved by a fixed budget. Only the MediaRecorder consumes this value, so raising it never
 * affects the live video that remote viewers receive (that stays on the separate producer bitrate).
 */
const resolveRecordingVideoBitrate = (track: MediaStreamTrack): number => {
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
  const width = typeof settings.width === 'number' && settings.width > 0 ? settings.width : DEFAULT_RECORDING_WIDTH
  const height = typeof settings.height === 'number' && settings.height > 0 ? settings.height : DEFAULT_RECORDING_HEIGHT
  const frameRate = typeof settings.frameRate === 'number' && settings.frameRate > 0
    ? Math.min(settings.frameRate, 60)
    : DEFAULT_RECORDING_FRAME_RATE
  const target = Math.round(width * height * frameRate * RECORDING_BITS_PER_PIXEL)
  return Math.min(MAX_RECORDING_VIDEO_BITRATE, Math.max(MIN_RECORDING_VIDEO_BITRATE, target))
}

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
 * Records the driver's own camera feed while the server keeps track recording sessions open.
 *
 * Capture happens on the driver's device (the only place the raw camera stream exists) and each
 * finished clip is uploaded to the server, which stores it in the data directory or S3 and links
 * it to its run for download from the leaderboard.
 *
 * A driver can time several overlapping tracks at once, so one session (and one MediaRecorder) is
 * kept per run id. Every session is independent: its own cap timer, its own chunks and its own
 * upload, so a stop for one run never disturbs another. Starts are idempotent and matched by run
 * id, and a start that arrives before the camera stream is live is retried rather than dropped.
 */
export const useTrackRecording = (options: TrackRecordingOptions) => {
  const isRecording = ref(false)
  const error = ref<string | null>(null)
  const recordingRunIds = ref<string[]>([])
  const isUploading = ref(false)
  const sessions = new Map<string, RecordingSession>()
  const pendingStarts = new Map<string, PendingStart>()
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempts = 0
  let uploadsInFlight = 0

  const syncRecordingState = () => {
    const ids = [...sessions.keys()]
    recordingRunIds.value = ids
    isRecording.value = ids.length > 0
  }

  const clearRetry = () => {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
  }

  const clearCap = (target: RecordingSession) => {
    if (target.capTimer !== null) { clearTimeout(target.capTimer); target.capTimer = null }
  }

  const finalize = (target: RecordingSession): void => {
    if (target.finalized) return
    target.finalized = true
    clearCap(target)
    if (sessions.get(target.runId) === target) {
      sessions.delete(target.runId)
      syncRecordingState()
    }

    const runId = target.runId
    const mimeType = target.recorder.mimeType || 'video/webm'
    const durationMs = Math.max(0, Date.now() - target.startedAt)
    const recordedChunks = target.chunks
    target.chunks = []
    const blob = new Blob(recordedChunks, { type: mimeType })
    if (blob.size > 0 && durationMs >= MIN_UPLOAD_DURATION_MS) {
      let connectionId: string | null = null
      try { connectionId = options.getConnectionId?.() ?? null } catch { connectionId = null }
      uploadsInFlight++
      isUploading.value = true
      const uploadFinished = () => {
        uploadsInFlight = Math.max(0, uploadsInFlight - 1)
        if (uploadsInFlight === 0) isUploading.value = false
      }
      // Store durably; the uploads store retries until the server acknowledges the clip. The call
      // is made synchronously so the clip reaches the queue before anything else finalizes.
      try {
        const pending = options.storeRecording({ runId, file: blob, mimeType, durationMs, connectionId })
        Promise.resolve(pending).then(undefined, (cause) => {
          error.value = cause instanceof Error ? cause.message : 'Could not store the recording for upload.'
          console.error('[Drive][recording] Failed to store recording:', cause)
        }).finally(uploadFinished)
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : 'Could not store the recording for upload.'
        console.error('[Drive][recording] Failed to store recording:', cause)
        uploadFinished()
      }
    }

    // A start that arrived while the camera stream was not live yet gets another chance.
    attemptPendingStarts()
  }

  const stopSession = (target: RecordingSession, reason: RecordingStopReason): void => {
    if (!target || target.finalized || target.stopping) return
    target.stopping = true
    clearCap(target)
    if (target.recorder.state === 'inactive') {
      finalize(target)
      return
    }
    // MediaRecorder.stop() flushes a final dataavailable before onstop, so finalization must wait
    // for that callback rather than running inline and losing the tail of the clip.
    try {
      target.recorder.stop()
    } catch (cause) {
      console.error(`[Drive][recording] Failed to stop recorder (${reason}):`, cause)
      finalize(target)
    }
  }

  const beginRecording = (runId: string, maxMs: number): boolean => {
    // Already recording this run: nothing to do.
    if (sessions.has(runId)) return true
    const stream = options.getCameraStream()
    const videoTrack = stream?.getVideoTracks()[0]
    if (!stream || !videoTrack || videoTrack.readyState !== 'live') return false
    const mimeType = pickRecordingMimeType()
    if (mimeType === null) {
      error.value = 'Camera recording is not supported by this browser.'
      return false
    }

    try {
      const recorderOptions: MediaRecorderOptions = {
        videoBitsPerSecond: resolveRecordingVideoBitrate(videoTrack)
      }
      if (mimeType) recorderOptions.mimeType = mimeType
      const nextRecorder = new MediaRecorder(stream, recorderOptions)
      const created: RecordingSession = {
        runId,
        recorder: nextRecorder,
        chunks: [],
        startedAt: Date.now(),
        capTimer: null,
        stopping: false,
        finalized: false
      }
      nextRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) created.chunks.push(event.data)
      }
      nextRecorder.onerror = (event) => {
        error.value = 'Camera recording failed unexpectedly.'
        console.error('[Drive][recording] Recorder error:', event)
        // Do not finalize inline: the browser may still deliver dataavailable/onstop. An inactive
        // recorder finalizes immediately, otherwise stop() flushes the tail first.
        stopSession(created, 'run_ended')
      }
      nextRecorder.onstop = () => { finalize(created) }

      sessions.set(runId, created)
      syncRecordingState()
      error.value = null
      nextRecorder.start(1000)
      const effectiveMax = Number.isFinite(maxMs) && maxMs > 0 ? Math.min(maxMs, DEFAULT_MAX_DURATION_MS) : DEFAULT_MAX_DURATION_MS
      created.capTimer = setTimeout(() => stopSession(created, 'timeout'), effectiveMax)
      return true
    } catch (cause) {
      error.value = 'Could not start camera recording.'
      console.error('[Drive][recording] Failed to start recorder:', cause)
      sessions.delete(runId)
      syncRecordingState()
      return false
    }
  }

  const attemptPendingStarts = (): void => {
    if (!pendingStarts.size) { clearRetry(); retryAttempts = 0; return }
    let anyPending = false
    for (const [runId, pending] of [...pendingStarts]) {
      if (sessions.has(runId)) { pendingStarts.delete(runId); continue }
      if (beginRecording(runId, pending.maxMs)) { pendingStarts.delete(runId); continue }
      anyPending = true
    }
    if (!anyPending) { clearRetry(); retryAttempts = 0; return }
    if (retryTimer !== null) return
    retryAttempts++
    if (retryAttempts > START_MAX_ATTEMPTS) {
      // Give up until the run changes; the server keeps the session but the local camera never
      // produced a track, so there is nothing more to record here.
      pendingStarts.clear()
      retryAttempts = 0
      return
    }
    // The local camera stream can lag the server's producer notification by a moment.
    retryTimer = setTimeout(() => { retryTimer = null; attemptPendingStarts() }, START_RETRY_DELAY_MS)
  }

  const tryStart = (runId: string, maxMs: number): void => {
    // Already recording this run: a duplicate start is a no-op.
    if (sessions.has(runId)) return
    if (!pendingStarts.has(runId)) retryAttempts = 0
    pendingStarts.set(runId, { runId, maxMs })
    clearRetry()
    attemptPendingStarts()
  }

  const handleMessage = (message: any) => {
    const type = message?.type
    const payload = message?.payload
    if (!payload || payload.channel_id !== options.getChannelId()) return

    if (type === 'drive_recording_start' && typeof payload.run_id === 'string') {
      if (!options.isJoined()) return
      const maxMs = typeof payload.max_duration_ms === 'number' ? payload.max_duration_ms : DEFAULT_MAX_DURATION_MS
      tryStart(payload.run_id, maxMs)
      return
    }

    if (type === 'drive_recording_stop' && typeof payload.run_id === 'string') {
      pendingStarts.delete(payload.run_id)
      const active = sessions.get(payload.run_id)
      if (active) stopSession(active, (payload.reason as RecordingStopReason) || 'run_ended')
      return
    }

    // Safety net: if a stop message was lost (reconnect, channel churn) the authoritative run
    // state still ends the matching recording instead of leaving it to the hard cap.
    if (type === 'drive_track_run_updated' && payload.run && typeof payload.run.id === 'string') {
      const run = payload.run
      if (run.status !== 'active') pendingStarts.delete(run.id)
      const active = sessions.get(run.id)
      if (active && run.status !== 'active') {
        stopSession(active, run.status === 'finished' ? 'track_finished' : 'track_abandoned')
      }
    }
  }

  options.addMessageListener(handleMessage)
  const dispose = () => {
    options.removeMessageListener(handleMessage)
    clearRetry()
    pendingStarts.clear()
    retryAttempts = 0
    for (const session of [...sessions.values()]) {
      if (!session.finalized) stopSession(session, 'run_ended')
    }
  }
  onScopeDispose(dispose)

  return { isRecording, isUploading, error, recordingRunIds, dispose }
}
