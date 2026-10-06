import { ref, shallowRef } from 'vue'
import { getDriveCameraCaptureConstraints, getDriveCameraProducerOptions } from '../utils/driveCamera'
import {
  createOrientationAwareStream,
  hasConfiguredCameraRotation,
  loadCameraRotation,
  markCameraRotationConfigured,
  normalizeCameraRotation,
  saveCameraRotation,
  type CameraRotation,
  type OrientationAwareStream
} from '../utils/cameraOrientation'

type CameraShareOptions = {
  getChannelId: () => string | null
  isDriveChannel: () => boolean
  getSendTransport: () => any | null
  getDevice: () => { canProduce: (kind: 'video') => boolean } | null
  waitForSendTransport: () => Promise<any | null>
  getUserId: () => string | null | undefined
  setUserStream: (userId: string, stream: MediaStream) => void
  deleteUserStream: (userId: string) => void
  send: (type: string, payload: Record<string, unknown>) => void
}

// Bounded retries so a persistent failure (no camera, no transport) cannot spin forever.
const MAX_RESUME_ATTEMPTS = 4
const RESUME_RETRY_MS = 1000
const MAX_CAPTURE_RECOVERY_ATTEMPTS = 3
const CAPTURE_RECOVERY_RETRY_MS = 1000
const RECOVERY_STABLE_MS = 5000

export const useDriveCameraShare = (options: CameraShareOptions) => {
  const producer = shallowRef<any | null>(null)
  const stream = shallowRef<MediaStream | null>(null)
  const error = ref<string | null>(null)
  const starting = ref(false)
  const detached = ref(false)
  const rotation = ref<CameraRotation>(loadCameraRotation())
  const previewing = ref(false)
  const previewStream = shallowRef<MediaStream | null>(null)
  let generation = 0
  let orientationStream: OrientationAwareStream | null = null
  let localOutput: MediaStream | null = null
  // Set when the user explicitly stops so environmental recovery never fights a deliberate stop.
  let userStopped = false
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let resumeAttempts = 0
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  let recoveryAttempts = 0
  let recoveryResetTimer: ReturnType<typeof setTimeout> | null = null
  let visibilityBound = false

  const clearResumeRetry = () => {
    if (resumeTimer !== null) { clearTimeout(resumeTimer); resumeTimer = null }
  }

  const unbindVisibilityRecovery = () => {
    if (visibilityBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      visibilityBound = false
    }
  }

  const clearRecovery = () => {
    if (recoveryTimer !== null) { clearTimeout(recoveryTimer); recoveryTimer = null }
    unbindVisibilityRecovery()
  }

  const clearRecoveryReset = () => {
    if (recoveryResetTimer !== null) { clearTimeout(recoveryResetTimer); recoveryResetTimer = null }
  }

  // Once the capture has been healthy for a while, restore the recovery budget so a later,
  // unrelated outage can recover again without allowing a tight failure loop.
  const markCaptureHealthy = () => {
    clearRecoveryReset()
    recoveryResetTimer = setTimeout(() => { recoveryResetTimer = null; recoveryAttempts = 0 }, RECOVERY_STABLE_MS)
  }

  const cleanup = (notifyServer = true) => {
    generation++
    starting.value = false
    detached.value = false
    previewing.value = false
    previewStream.value = null
    clearResumeRetry()
    clearRecovery()
    clearRecoveryReset()
    const producerId = producer.value?.id as string | undefined
    try {
      producer.value?.close()
    } catch (_error) {
      // no-op
    }
    producer.value = null

    const channelId = options.getChannelId()
    if (notifyServer && producerId && channelId) {
      options.send('close_producer', { channel_id: channelId, producer_id: producerId })
    }

    orientationStream?.dispose()
    orientationStream = null
    localOutput = null

    stream.value?.getVideoTracks().forEach((track) => {
      // Detach the handler before stopping so an expected teardown never looks like an unexpected
      // camera end (which would trigger the recovery path).
      track.onended = null
    })
    stream.value?.getTracks().forEach((track) => {
      try {
        track.stop()
      } catch (_error) {
        // no-op
      }
    })
    stream.value = null

    const userId = options.getUserId()
    if (userId) options.deleteUserStream(userId)
  }

  const stop = () => {
    userStopped = true
    resumeAttempts = 0
    recoveryAttempts = 0
    error.value = null
    cleanup()
  }

  const isCaptureCurrent = (
    requestGeneration: number, channelId: string, sendTransport: any | null
  ): boolean => generation === requestGeneration
    && options.getChannelId() === channelId
    && options.isDriveChannel()
    && options.getSendTransport() === sendTransport

  /**
   * Closes the SFU producer but keeps the local capture (camera stream + orientation pipeline)
   * alive so a short websocket/WebRTC outage does not interrupt an in-progress recording.
   */
  const detach = () => {
    if (previewing.value) return
    if (!localOutput && !producer.value) return
    const current = producer.value
    producer.value = null
    try {
      current?.close()
    } catch (_error) {
      // no-op
    }
    detached.value = true
  }

  const publish = async (
    requestGeneration: number,
    channelId: string,
    sendTransport: any,
    outputStream: MediaStream,
    outputTrack: MediaStreamTrack
  ): Promise<boolean> => {
    const cameraProducer = await sendTransport.produce({
      track: outputTrack,
      ...getDriveCameraProducerOptions(),
      appData: { source: 'camera' }
    })
    if (!isCaptureCurrent(requestGeneration, channelId, sendTransport)) {
      cameraProducer.close()
      options.send('close_producer', { channel_id: channelId, producer_id: cameraProducer.id })
      return false
    }

    producer.value = cameraProducer
    localOutput = outputStream
    previewing.value = false
    previewStream.value = null
    // A successful re-publish is a fresh resume cycle.
    resumeAttempts = 0
    clearResumeRetry()
    markCaptureHealthy()
    const userId = options.getUserId()
    if (userId) options.setUserStream(userId, outputStream)
    // Keep the capture alive on transport loss so a short outage does not stop the recording.
    cameraProducer.on('transportclose', () => detach())
    return true
  }

  const reportStartError = (cause: unknown) => {
    const errorName = cause instanceof DOMException ? cause.name : ''
    error.value = errorName === 'NotAllowedError' || errorName === 'SecurityError'
      ? 'Camera permission was denied. Allow camera access in your browser or system settings to share your view.'
      : errorName === 'NotFoundError' || errorName === 'OverconstrainedError'
        ? 'No compatible camera is available on this device.'
        : 'Could not start camera sharing. Check your connection and try again.'
    console.error('[WebRTC][camera] Failed to start camera share:', cause)
  }

  /**
   * Re-acquires a fresh camera after the OS/browser ended the capture (screen lock, the phone
   * reclaiming the camera, a mobile background pause). The canvas pipeline keeps the published
   * track (and any in-progress recording) alive by swapping in the new source; only when no
   * pipeline exists is the producer re-created. Retries are bounded and deferred while the page is
   * hidden so a locked phone does not spin up the camera in the background.
   */
  const recoverPipelineSource = async (pipeline: OrientationAwareStream) => {
    if (userStopped) return
    try {
      const next = await navigator.mediaDevices.getUserMedia(getDriveCameraCaptureConstraints())
      if (userStopped || orientationStream !== pipeline) {
        next.getTracks().forEach((track) => track.stop())
        return
      }
      const nextTrack = next.getVideoTracks()[0]
      if (!nextTrack) {
        next.getTracks().forEach((track) => track.stop())
        scheduleCaptureRecovery()
        return
      }
      nextTrack.contentHint = 'motion'
      nextTrack.onended = onCaptureEnded
      const previous = stream.value
      stream.value = next
      pipeline.replaceSource(next)
      markCaptureHealthy()
      previous?.getVideoTracks().forEach((track) => { track.onended = null })
      previous?.getTracks().forEach((track) => {
        try { track.stop() } catch (_error) { /* no-op */ }
      })
      console.info('[WebRTC][camera] Re-acquired the camera source after an unexpected end')
    } catch (cause) {
      console.warn('[WebRTC][camera] Failed to re-acquire the camera source:', cause)
      scheduleCaptureRecovery()
    }
  }

  const attemptCaptureRecovery = () => {
    if (userStopped) return
    const pipeline = orientationStream
    if (pipeline) {
      void recoverPipelineSource(pipeline)
      return
    }
    cleanup()
    void beginCapture()
  }

  const scheduleCaptureRecovery = () => {
    if (userStopped || recoveryTimer !== null || recoveryAttempts >= MAX_CAPTURE_RECOVERY_ATTEMPTS) return
    const channelId = options.getChannelId()
    if (!channelId || !options.isDriveChannel()) return
    // A new failure means the capture is not healthy: cancel the pending budget reset.
    clearRecoveryReset()
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      bindVisibilityRecovery()
      return
    }
    recoveryAttempts++
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      if (userStopped) return
      // The screen may have locked again while waiting; defer until the page is visible.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        bindVisibilityRecovery()
        return
      }
      attemptCaptureRecovery()
    }, CAPTURE_RECOVERY_RETRY_MS)
  }

  function onVisibilityChange() {
    if (userStopped) return
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
    unbindVisibilityRecovery()
    scheduleCaptureRecovery()
  }

  const bindVisibilityRecovery = () => {
    if (visibilityBound || typeof document === 'undefined') return
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = true
  }

  const onCaptureEnded = () => {
    if (userStopped) return
    console.warn('[WebRTC][camera] Camera capture ended unexpectedly; attempting to recover')
    scheduleCaptureRecovery()
  }

  const scheduleResumeRetry = () => {
    if (resumeTimer !== null || !detached.value || userStopped) return
    if (resumeAttempts >= MAX_RESUME_ATTEMPTS) return
    resumeAttempts++
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      void resume()
    }, RESUME_RETRY_MS)
  }

  /** Re-publishes the preserved local capture on a new send transport after a reconnect. */
  const resume = async (): Promise<boolean> => {
    if (!detached.value || !localOutput) return false
    const channelId = options.getChannelId()
    if (!channelId || !options.isDriveChannel()) return false
    const outputTrack = localOutput.getVideoTracks()[0]
    if (!outputTrack || outputTrack.readyState !== 'live') {
      // The preserved capture died while detached (for example the OS ended the camera track):
      // fall back to a fresh capture instead of leaving the camera silently off.
      cleanup(false)
      scheduleCaptureRecovery()
      return false
    }
    const sendTransport = await options.waitForSendTransport()
    if (!sendTransport || !options.getDevice()?.canProduce('video')) {
      scheduleResumeRetry()
      return false
    }
    try {
      const cameraProducer = await sendTransport.produce({
        track: outputTrack,
        ...getDriveCameraProducerOptions(),
        appData: { source: 'camera' }
      })
      producer.value = cameraProducer
      detached.value = false
      resumeAttempts = 0
      clearResumeRetry()
      cameraProducer.on('transportclose', () => detach())
      const userId = options.getUserId()
      if (userId) options.setUserStream(userId, localOutput)
      return true
    } catch (cause) {
      // Keep the capture and the detached flag so a later reconnect/retry can try again.
      console.warn('[WebRTC][camera] Failed to resume camera capture after reconnect:', cause)
      scheduleResumeRetry()
      return false
    }
  }

  const beginCapture = async () => {
    const channelId = options.getChannelId()
    if (!channelId) {
      error.value = 'Join Drive Together before sharing your camera.'
      return
    }
    if (!options.isDriveChannel()) {
      error.value = 'Camera sharing is available in Drive Together channels.'
      return
    }
    if (producer.value || starting.value || previewing.value) return
    // A preserved capture from before a reconnect is re-published, never captured twice.
    if (detached.value && localOutput) {
      void resume()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      error.value = 'Camera access requires HTTPS (or localhost) and a browser that supports camera capture.'
      return
    }

    error.value = null
    starting.value = true
    const requestGeneration = ++generation
    let requestedStream: MediaStream | null = null
    let sendTransport: any | null = null

    try {
      sendTransport = await options.waitForSendTransport()
      if (!isCaptureCurrent(requestGeneration, channelId, sendTransport)) return
      if (!sendTransport) {
        error.value = 'Camera sharing is not ready yet. Please try again in a moment.'
        return
      }
      if (!options.getDevice()?.canProduce('video')) {
        error.value = 'This connection cannot publish camera video.'
        return
      }

      requestedStream = await navigator.mediaDevices.getUserMedia(getDriveCameraCaptureConstraints())
      const videoTrack = requestedStream.getVideoTracks()[0]
      if (!videoTrack) {
        requestedStream.getTracks().forEach((track) => track.stop())
        error.value = 'No camera video track was provided by the browser.'
        return
      }
      if (!isCaptureCurrent(requestGeneration, channelId, sendTransport)) {
        requestedStream.getTracks().forEach((track) => track.stop())
        return
      }

      videoTrack.contentHint = 'motion'
      stream.value = requestedStream
      // An unexpected end (screen lock, another app claiming the camera) is recovered automatically
      // instead of silently dropping the driver's feed.
      videoTrack.onended = onCaptureEnded

      console.info('[WebRTC][camera] Captured stream', {
        settings: typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : null,
        rotation: rotation.value
      })

      // Normalise the user's rotation choice into the encoded frames so every viewer and the
      // recording see the same picture without per-client CSS transforms. Falls back to the raw
      // track when the canvas pipeline is unavailable.
      orientationStream = createOrientationAwareStream(requestedStream, { frameRate: 20, rotation: rotation.value })
      const outputTrack = orientationStream?.stream.getVideoTracks()[0] ?? videoTrack
      outputTrack.contentHint = 'motion'
      const outputStream = orientationStream?.stream ?? requestedStream
      localOutput = outputStream

      if (!hasConfiguredCameraRotation()) {
        // The orientation is unknown for this device/orientation: show the live preview and let the
        // user pick the rotation before anything is published. No producer exists yet, so nothing
        // leaves the device.
        previewing.value = true
        previewStream.value = outputStream
        return
      }

      await publish(requestGeneration, channelId, sendTransport, outputStream, outputTrack)
    } catch (cause) {
      if (!isCaptureCurrent(requestGeneration, channelId, sendTransport)) {
        requestedStream?.getTracks().forEach((track) => track.stop())
        if (requestedStream && stream.value === requestedStream) cleanup(false)
        return
      }
      reportStartError(cause)
      cleanup()
    } finally {
      if (generation === requestGeneration) starting.value = false
    }
  }

  /** Starts or retries a camera share. A deliberate start resets the automatic recovery budget. */
  const start = (): Promise<void> => {
    userStopped = false
    recoveryAttempts = 0
    resumeAttempts = 0
    clearRecovery()
    clearResumeRetry()
    return beginCapture()
  }

  /** Confirms the first-run orientation preview and publishes the camera. */
  const confirmRotation = async (): Promise<boolean> => {
    if (!previewing.value || !localOutput) return false
    const requestGeneration = generation
    const channelId = options.getChannelId()
    if (!channelId || !options.isDriveChannel()) {
      cleanup(false)
      return false
    }

    starting.value = true
    try {
      const sendTransport = await options.waitForSendTransport()
      if (!sendTransport || generation !== requestGeneration || !options.isDriveChannel()) {
        error.value = 'Camera sharing is not ready yet. Please try again in a moment.'
        cleanup(false)
        return false
      }
      if (!options.getDevice()?.canProduce('video')) {
        error.value = 'This connection cannot publish camera video.'
        cleanup(false)
        return false
      }
      const outputTrack = localOutput.getVideoTracks()[0]
      if (!outputTrack || outputTrack.readyState !== 'live') {
        cleanup(false)
        return false
      }

      const published = await publish(requestGeneration, channelId, sendTransport, localOutput, outputTrack)
      if (published) {
        saveCameraRotation(rotation.value)
        markCameraRotationConfigured()
      }
      return published
    } catch (cause) {
      reportStartError(cause)
      cleanup(false)
      return false
    } finally {
      starting.value = false
    }
  }

  /** Cancels the first-run orientation preview without publishing. */
  const cancelRotation = () => {
    if (!previewing.value) return
    error.value = null
    cleanup(false)
  }

  /** Cycles the camera rotation by 90 degrees and applies it to the live capture. */
  const rotate = (): CameraRotation => {
    rotation.value = normalizeCameraRotation(rotation.value + 90)
    orientationStream?.setRotation(rotation.value)
    // Persist live adjustments, but keep first-run changes pending until the user confirms.
    if (hasConfiguredCameraRotation()) saveCameraRotation(rotation.value)
    return rotation.value
  }

  return {
    producer,
    error,
    starting,
    detached,
    rotation,
    previewing,
    previewStream,
    cleanup,
    detach,
    resume,
    start,
    stop,
    confirmRotation,
    cancelRotation,
    rotate
  }
}
