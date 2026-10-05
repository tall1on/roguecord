export type CameraOrientation = 'portrait' | 'landscape'

const MAX_OUTPUT_SIDE = 640

/** The physical orientation of the device screen (not the browser window shape). */
export const getDeviceOrientation = (): CameraOrientation => {
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.type === 'string') {
    return screen.orientation.type.startsWith('portrait') ? 'portrait' : 'landscape'
  }
  const legacyOrientation = typeof window !== 'undefined' ? (window as any).orientation : undefined
  if (typeof legacyOrientation === 'number') {
    return Math.abs(legacyOrientation) === 90 ? 'landscape' : 'portrait'
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'
  }
  return 'landscape'
}

export const getScreenOrientationAngle = (): number => {
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
    return ((screen.orientation.angle % 360) + 360) % 360
  }
  const legacyOrientation = typeof window !== 'undefined' ? (window as any).orientation : undefined
  if (typeof legacyOrientation === 'number') {
    return ((legacyOrientation % 360) + 360) % 360
  }
  return 0
}

/**
 * Degrees (clockwise) needed to make the raw camera frame upright on screen.
 *
 * Some browsers rotate camera frames to match the device orientation and some deliver them in the
 * sensor's natural orientation. Comparing the frame aspect with the device orientation tells us
 * which case we are in, so the correction works either way.
 */
export const computeCameraRotation = (
  videoWidth: number, videoHeight: number, orientation: CameraOrientation, screenAngle: number
): number => {
  if (!videoWidth || !videoHeight) return 0
  const videoPortrait = videoHeight > videoWidth
  const devicePortrait = orientation === 'portrait'
  if (videoPortrait === devicePortrait) return screenAngle === 180 ? 180 : 0
  if (devicePortrait) return screenAngle === 180 ? 270 : 90
  return screenAngle === 180 ? 90 : 270
}

export const subscribeOrientationChange = (listener: () => void): (() => void) => {
  const handler = () => listener()
  const orientation = typeof screen !== 'undefined' ? screen.orientation : undefined
  orientation?.addEventListener?.('change', handler)
  window.addEventListener('orientationchange', handler)
  window.addEventListener('resize', handler)
  return () => {
    orientation?.removeEventListener?.('change', handler)
    window.removeEventListener('orientationchange', handler)
    window.removeEventListener('resize', handler)
  }
}

export type OrientationAwareStream = {
  stream: MediaStream
  refresh: () => void
  dispose: () => void
}

/**
 * Wraps a raw camera stream in a canvas pipeline that always outputs upright frames.
 *
 * Both the WebRTC producer (remote web UI display) and the recording composable consume this
 * output, so rotation is baked into the encoded frames instead of relying on CSS per viewer.
 */
export const createOrientationAwareStream = (
  source: MediaStream, options: { frameRate?: number } = {}
): OrientationAwareStream | null => {
  // Non-browser environments (SSR/tests) cannot run the canvas pipeline; callers fall back to the raw track.
  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !document.body) return null
  const canvas = document.createElement('canvas')
  if (typeof canvas.captureStream !== 'function') return null

  const frameRate = options.frameRate && options.frameRate > 0 ? options.frameRate : 20
  const video = document.createElement('video')
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.setAttribute('playsinline', 'true')
  video.srcObject = source
  Object.assign(video.style, {
    position: 'fixed', left: '-9999px', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none'
  })
  document.body.appendChild(video)
  void video.play().catch(() => { /* autoplay of a muted camera stream may still be rejected */ })

  const context = canvas.getContext('2d')
  const output = canvas.captureStream(frameRate)
  let disposed = false
  let dirty = true
  let currentRotation = 0
  let timeout: ReturnType<typeof setTimeout> | null = null

  const targetDimensions = () => {
    const rawWidth = video.videoWidth
    const rawHeight = video.videoHeight
    const rotation = computeCameraRotation(rawWidth, rawHeight, getDeviceOrientation(), getScreenOrientationAngle())
    const rotatedWidth = rotation % 180 === 0 ? rawWidth : rawHeight
    const rotatedHeight = rotation % 180 === 0 ? rawHeight : rawWidth
    const scale = rotatedWidth > 0 && rotatedHeight > 0
      ? Math.min(1, MAX_OUTPUT_SIDE / Math.max(rotatedWidth, rotatedHeight))
      : 1
    return {
      rotation,
      width: Math.max(2, Math.round((rotatedWidth * scale) / 2) * 2),
      height: Math.max(2, Math.round((rotatedHeight * scale) / 2) * 2)
    }
  }

  const schedule = () => {
    if (disposed) return
    const videoWithCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    if (typeof videoWithCallback.requestVideoFrameCallback === 'function') {
      videoWithCallback.requestVideoFrameCallback(() => drawFrame())
    } else {
      timeout = setTimeout(drawFrame, Math.max(16, Math.round(1000 / frameRate)))
    }
  }

  function drawFrame() {
    if (disposed) return
    if (context && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const dimensions = targetDimensions()
      if (dirty || canvas.width !== dimensions.width || canvas.height !== dimensions.height) {
        canvas.width = dimensions.width
        canvas.height = dimensions.height
        currentRotation = dimensions.rotation
        dirty = false
      }
      context.save()
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.translate(canvas.width / 2, canvas.height / 2)
      context.rotate((currentRotation * Math.PI) / 180)
      if (currentRotation % 180 === 0) {
        context.drawImage(video, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height)
      } else {
        context.drawImage(video, -canvas.height / 2, -canvas.width / 2, canvas.height, canvas.width)
      }
      context.restore()
    }
    schedule()
  }

  for (const track of output.getVideoTracks()) track.contentHint = 'motion'
  const unsubscribe = subscribeOrientationChange(() => { dirty = true })
  schedule()

  return {
    stream: output,
    refresh: () => { dirty = true },
    dispose: () => {
      disposed = true
      if (timeout !== null) { clearTimeout(timeout); timeout = null }
      unsubscribe()
      try { video.pause() } catch (_error) { /* no-op */ }
      video.srcObject = null
      video.remove()
      for (const track of output.getTracks()) {
        try { track.stop() } catch (_error) { /* no-op */ }
      }
    }
  }
}
