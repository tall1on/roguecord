import { ref, shallowRef } from 'vue'
import { getDriveCameraCaptureConstraints, getDriveCameraProducerOptions } from '../utils/driveCamera'

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
  let generation = 0

  const cleanup = (notifyServer = true) => {
    generation++
    starting.value = false
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
    if (producer.value || starting.value) return
    if (!navigator.mediaDevices?.getUserMedia) {
      error.value = 'Camera access requires HTTPS (or localhost) and a browser that supports camera capture.'
      return
    }

    error.value = null
    starting.value = true
    const requestGeneration = ++generation
    let requestedStream: MediaStream | null = null
    let sendTransport: any | null = null
    const isRequestCurrent = () => generation === requestGeneration
      && options.getChannelId() === channelId
      && options.isDriveChannel()
      && options.getSendTransport() === sendTransport

    try {
      sendTransport = await options.waitForSendTransport()
      if (!isRequestCurrent()) return
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
      if (!isRequestCurrent()) {
        requestedStream.getTracks().forEach((track) => track.stop())
        return
      }

      videoTrack.contentHint = 'motion'
      stream.value = requestedStream
      videoTrack.onended = stop

      const cameraProducer = await sendTransport.produce({
        track: videoTrack,
        ...getDriveCameraProducerOptions(),
        appData: { source: 'camera' }
      })
      if (!isRequestCurrent()) {
        cameraProducer.close()
        options.send('close_producer', { channel_id: channelId, producer_id: cameraProducer.id })
        requestedStream.getTracks().forEach((track) => track.stop())
        if (stream.value === requestedStream) cleanup(false)
        return
      }

      producer.value = cameraProducer
      const userId = options.getUserId()
      if (userId) options.setUserStream(userId, requestedStream)
      producer.value.on('transportclose', () => cleanup(false))
    } catch (cause) {
      if (!isRequestCurrent()) {
        requestedStream?.getTracks().forEach((track) => track.stop())
        if (requestedStream && stream.value === requestedStream) cleanup(false)
        return
      }

      const errorName = cause instanceof DOMException ? cause.name : ''
      error.value = errorName === 'NotAllowedError' || errorName === 'SecurityError'
        ? 'Camera permission was denied. Allow camera access in your browser or system settings to share your view.'
        : errorName === 'NotFoundError' || errorName === 'OverconstrainedError'
          ? 'No compatible camera is available on this device.'
          : 'Could not start camera sharing. Check your connection and try again.'
      console.error('[WebRTC][camera] Failed to start camera share:', cause)
      cleanup()
    } finally {
      if (generation === requestGeneration) starting.value = false
    }
  }

  return { producer, error, starting, cleanup, start, stop }
}
