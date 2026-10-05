export type CameraRotation = 0 | 90 | 180 | 270

const MAX_OUTPUT_SIDE = 640
const ROTATION_STORAGE_KEY = 'roguecord.driveCameraRotation'
const CONFIGURED_STORAGE_KEY = 'roguecord.driveCameraRotationConfigured'

const readStorage = (key: string): string | null => {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch (_error) {
    return null
  }
}

const writeStorage = (key: string, value: string): void => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch (_error) {
    // Storage can be unavailable (private browsing or disabled cookies); the orientation then
    // only lasts for the current session.
  }
}

/** Snaps arbitrary degrees to the nearest quarter turn used by the camera pipeline. */
export const normalizeCameraRotation = (degrees: number): CameraRotation => {
  if (!Number.isFinite(degrees)) return 0
  return ((((Math.round(degrees / 90) * 90) % 360) + 360) % 360) as CameraRotation
}

export const loadCameraRotation = (): CameraRotation =>
  normalizeCameraRotation(Number(readStorage(ROTATION_STORAGE_KEY)) || 0)

export const saveCameraRotation = (rotation: CameraRotation): void => {
  writeStorage(ROTATION_STORAGE_KEY, String(normalizeCameraRotation(rotation)))
}

/** Whether the user already confirmed the camera orientation on this device. */
export const hasConfiguredCameraRotation = (): boolean =>
  readStorage(CONFIGURED_STORAGE_KEY) === 'true'

export const markCameraRotationConfigured = (): void => {
  writeStorage(CONFIGURED_STORAGE_KEY, 'true')
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
  setRotation: (rotation: CameraRotation) => void
  refresh: () => void
  dispose: () => void
}

/**
 * Wraps a raw camera stream in a canvas pipeline that applies a user-chosen rotation.
 *
 * The browser already delivers camera frames in the orientation of the display, so no automatic
 * correction is guessed here. The user picks a rotation once (first-run preview) and the canvas
 * bakes it into the encoded frames, so the live view, the recording and every remote viewer stay
 * consistent. When the device rotates, the frame shape changes and the canvas adapts while keeping
 * the chosen rotation.
 */
export const createOrientationAwareStream = (
  source: MediaStream, options: { frameRate?: number; rotation?: CameraRotation } = {}
): OrientationAwareStream | null => {
  // Non-browser environments (SSR/tests) cannot run the canvas pipeline; callers fall back to the raw track.
  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !document.body) return null
  const canvas = document.createElement('canvas')
  if (typeof canvas.captureStream !== 'function') return null

  const frameRate = options.frameRate && options.frameRate > 0 ? options.frameRate : 20
  let rotation: CameraRotation = normalizeCameraRotation(options.rotation ?? loadCameraRotation())
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
  let currentRotation: CameraRotation = rotation
  let timeout: ReturnType<typeof setTimeout> | null = null
  const frameIntervalMs = Math.max(1, Math.round(1000 / frameRate))
  let nextDrawAt = 0

  const targetDimensions = () => {
    const rawWidth = video.videoWidth
    const rawHeight = video.videoHeight
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
    const videoWithCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number
    }
    if (typeof videoWithCallback.requestVideoFrameCallback === 'function') {
      videoWithCallback.requestVideoFrameCallback((now) => {
        // requestVideoFrameCallback fires for every presented camera frame (often 30-60fps), but
        // the canvas is only captured at `frameRate`. Drawing the surplus frames wastes CPU/GPU
        // and heats mobile devices. Accumulate the schedule from the last target time (not the
        // actual draw time) so the rate averages out to `frameRate` even when the source frame
        // rate is not a multiple of it.
        if (now < nextDrawAt) {
          schedule()
          return
        }
        nextDrawAt += frameIntervalMs
        // If we fell far behind (e.g. the tab was suspended), do not burst-catch up.
        if (nextDrawAt <= now) nextDrawAt = now + frameIntervalMs
        drawFrame()
      })
    } else {
      timeout = setTimeout(drawFrame, frameIntervalMs)
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

  // Chrome swaps the reported frame size when the device rotates; redraw immediately so the canvas
  // matches the new shape without waiting for the next orientation event.
  const onFrameResize = () => { dirty = true }
  video.addEventListener('resize', onFrameResize)

  for (const track of output.getVideoTracks()) track.contentHint = 'motion'
  const unsubscribe = subscribeOrientationChange(() => { dirty = true })
  schedule()

  return {
    stream: output,
    setRotation: (next: CameraRotation) => {
      rotation = normalizeCameraRotation(next)
      dirty = true
    },
    refresh: () => { dirty = true },
    dispose: () => {
      disposed = true
      if (timeout !== null) { clearTimeout(timeout); timeout = null }
      video.removeEventListener('resize', onFrameResize)
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
