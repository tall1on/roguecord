// The browser already delivers camera frames oriented to the display, so no orientation-specific
// size is forced. The width/height caps only bound how large a frame the camera may hand over:
// without them a phone can deliver an oversized (e.g. 1080p+) frame that the canvas has to
// downscale on every tick, which is a large, avoidable CPU/GPU and battery cost. `max` leaves the
// browser free to pick the orientation-appropriate shape, so portrait and landscape both keep
// working while the canvas pipeline scales the output down to its own limit.
export const MAX_DRIVE_CAMERA_CAPTURE_SIDE = 1280

export const getDriveCameraCaptureConstraints = (): MediaStreamConstraints => ({
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    frameRate: { ideal: 20, max: 24 },
    width: { max: MAX_DRIVE_CAMERA_CAPTURE_SIDE },
    height: { max: MAX_DRIVE_CAMERA_CAPTURE_SIDE }
  }
})

export const getDriveCameraProducerOptions = () => ({
  encodings: [{ maxBitrate: 650_000, maxFramerate: 20 }],
  codecOptions: { videoGoogleStartBitrate: 350 }
})
