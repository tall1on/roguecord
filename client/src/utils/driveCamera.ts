// The browser already delivers camera frames oriented to the display, so no orientation-specific
// size is requested. Keeping the request free of width/height lets the camera return a stable
// format that works in both portrait and landscape; the canvas pipeline applies the user's
// rotation choice and scales the output down.
export const getDriveCameraCaptureConstraints = (): MediaStreamConstraints => ({
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    frameRate: { ideal: 20, max: 24 }
  }
})

export const getDriveCameraProducerOptions = () => ({
  encodings: [{ maxBitrate: 650_000, maxFramerate: 20 }],
  codecOptions: { videoGoogleStartBitrate: 350 }
})
