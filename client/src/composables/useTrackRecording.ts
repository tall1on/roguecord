import { onScopeDispose, ref, shallowRef } from 'vue'

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
 *
 * Sessions are modelled explicitly so a stop/start hand-off (which happens whenever the recorded
 * run finishes and another active run — for example the reversed layout of the same track — takes
 * over) cannot strand a recording: the next start is queued until the previous recorder has
 * delivered its final data, and every stop is idempotent and matched by run id.
 */
export const useTrackRecording = (options: TrackRecordingOptions) => {
  const isRecording = ref(false)
  const error = ref<string | null>(null)
  const recordingRunId = ref<string | null>(null)
  const isUploading = ref(false)
  const recorder = shallowRef<MediaRecorder | null>(null)
  let session: RecordingSession | null = null
  let pendingStart: PendingStart | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempts = 0
  let uploadsInFlight = 0

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
    if (session === target) {
      session = null
      recorder.value = null
      isRecording.value = false
      recordingRunId.value = null
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
      // is made synchronously so the clip reaches the queue before a queued next recording starts.
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

    // A start that arrived while this session was stopping now runs against an idle recorder.
    attemptPendingStart()
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
    if (session) return false
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

      session = created
      recorder.value = nextRecorder
      recordingRunId.value = runId
      error.value = null
      nextRecorder.start(1000)
      isRecording.value = true
      const effectiveMax = Number.isFinite(maxMs) && maxMs > 0 ? Math.min(maxMs, DEFAULT_MAX_DURATION_MS) : DEFAULT_MAX_DURATION_MS
      created.capTimer = setTimeout(() => stopSession(created, 'timeout'), effectiveMax)
      return true
    } catch (cause) {
      error.value = 'Could not start camera recording.'
      console.error('[Drive][recording] Failed to start recorder:', cause)
      session = null
      recorder.value = null
      recordingRunId.value = null
      isRecording.value = false
      return false
    }
  }

  const attemptPendingStart = (): void => {
    if (!pendingStart || session) return
    if (beginRecording(pendingStart.runId, pendingStart.maxMs)) {
      pendingStart = null
      retryAttempts = 0
      clearRetry()
      return
    }
    if (retryTimer !== null) return
    retryAttempts++
    if (retryAttempts > START_MAX_ATTEMPTS) {
      pendingStart = null
      retryAttempts = 0
      return
    }
    // The local camera stream can lag the server's producer notification by a moment.
    retryTimer = setTimeout(() => { retryTimer = null; attemptPendingStart() }, START_RETRY_DELAY_MS)
  }

  const tryStart = (runId: string, maxMs: number): void => {
    // Already recording this run: a duplicate start is a no-op.
    if (session?.runId === runId) return
    if (pendingStart?.runId !== runId) {
      pendingStart = { runId, maxMs }
      retryAttempts = 0
      clearRetry()
    }
    // While another run is being recorded (or is still finalizing) the start is queued and will
    // run as soon as the current session finishes; nothing is silently discarded.
    attemptPendingStart()
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
      if (pendingStart?.runId === payload.run_id) pendingStart = null
      const active = session
      if (active && active.runId === payload.run_id) {
        stopSession(active, (payload.reason as RecordingStopReason) || 'run_ended')
      }
      return
    }

    // Safety net: if a stop message was lost (reconnect, channel churn) the authoritative run
    // state still ends the matching recording instead of leaving it to the hard cap.
    if (type === 'drive_track_run_updated' && payload.run && typeof payload.run.id === 'string') {
      const run = payload.run
      const active = session
      if (active && run.status !== 'active' && active.runId === run.id) {
        stopSession(active, run.status === 'finished' ? 'track_finished' : 'track_abandoned')
      }
    }
  }

  options.addMessageListener(handleMessage)
  const dispose = () => {
    options.removeMessageListener(handleMessage)
    clearRetry()
    pendingStart = null
    retryAttempts = 0
    if (session && !session.finalized) stopSession(session, 'run_ended')
  }
  onScopeDispose(dispose)

  return { isRecording, isUploading, error, recordingRunId, dispose }
}
