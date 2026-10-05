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

  const cleanup = (notifyServer = true) => {
    generation++
    starting.value = false
    detached.value = false
    previewing.value = false
    previewStream.value = null
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

  /** Re-publishes the preserved local capture on a new send transport after a reconnect. */
  const resume = async (): Promise<boolean> => {
    if (!detached.value || !localOutput) return false
    const outputTrack = localOutput.getVideoTracks()[0]
    if (!outputTrack || outputTrack.readyState !== 'live') return false
    const channelId = options.getChannelId()
    if (!channelId || !options.isDriveChannel()) return false
    const sendTransport = await options.waitForSendTransport()
    if (!sendTransport || !options.getDevice()?.canProduce('video')) return false
    try {
      const cameraProducer = await sendTransport.produce({
        track: outputTrack,
        ...getDriveCameraProducerOptions(),
        appData: { source: 'camera' }
      })
      producer.value = cameraProducer
      detached.value = false
      cameraProducer.on('transportclose', () => detach())
      const userId = options.getUserId()
      if (userId) options.setUserStream(userId, localOutput)
      return true
    } catch (cause) {
      // Keep the capture and the detached flag so a later reconnect can try again.
      console.warn('[WebRTC][camera] Failed to resume camera capture after reconnect:', cause)
      return false
    }
  }

  const start = async () => {
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
      videoTrack.onended = stop

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
        // First time on this device: show the live preview and let the user pick the rotation
        // before anything is published. No producer exists yet, so nothing leaves the device.
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
