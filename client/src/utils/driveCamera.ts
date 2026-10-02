export const getDriveCameraCaptureConstraints = (): MediaStreamConstraints => ({
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 640, max: 960 },
    height: { ideal: 360, max: 540 },
    frameRate: { ideal: 20, max: 24 }
  }
})

export const getDriveCameraProducerOptions = () => ({
  encodings: [{ maxBitrate: 650_000, maxFramerate: 20 }],
  codecOptions: { videoGoogleStartBitrate: 350 }
})
