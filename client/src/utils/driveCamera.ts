import { getDeviceOrientation } from './cameraOrientation'

// Ask the camera for the shape that matches how the phone is currently held; the orientation
// canvas pipeline corrects any device/sensor rotation on top of this.
export const getDriveCameraCaptureConstraints = (): MediaStreamConstraints => {
  const portrait = getDeviceOrientation() === 'portrait'
  return {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: portrait ? 360 : 640, max: portrait ? 540 : 960 },
      height: { ideal: portrait ? 640 : 360, max: portrait ? 960 : 540 },
      frameRate: { ideal: 20, max: 24 }
    }
  }
}

export const getDriveCameraProducerOptions = () => ({
  encodings: [{ maxBitrate: 650_000, maxFramerate: 20 }],
  codecOptions: { videoGoogleStartBitrate: 350 }
})
