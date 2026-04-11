const EMOJI_PREWARM_START_DELAY_MS = 1800
const EMOJI_PREWARM_ITEM_DELAY_MS = 300
const EMOJI_PREWARM_CONCURRENCY = 2
const EMOJI_PREWARM_TIMEOUT_MS = 8000
const EMOJI_PREWARM_REQUEST_TIMEOUT_MS = 15000
const EMOJI_PREWARM_MANIFEST_PATH = '/svg/index.json'
const EMOJI_PREWARM_FILENAME_PATTERN = /^[0-9a-f-]+\.svg$/i
const EMOJI_PREWARM_FRAME_WAIT_TIMEOUT_MS = 2000
const EMOJI_PREWARM_STORAGE_KEY = 'emojiPrewarmCache'
const EMOJI_PREWARM_STORAGE_VERSION = 1
const MAX_EMOJI_PREWARM_CACHE_ENTRIES = 5000

let emojiAssetUrlsPromise: Promise<string[]> | null = null
let emojiPrewarmStarted = false
let persistedPrewarmedEmojiUrls: Set<string> | null = null

type IdleDeadlineLike = {
  didTimeout: boolean
  timeRemaining(): number
}

type WindowWithIdleCallback = Window & typeof globalThis & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout?: number }
  ) => number
  cancelIdleCallback?: (handle: number) => void
}

type EmojiPrewarmCacheRecord = {
  version: number
  urls: string[]
}

const sortEmojiUrls = (urls: string[]) => {
  return [...urls].sort((left, right) => left.localeCompare(right))
}

const isValidEmojiFilename = (value: unknown): value is string => {
  return typeof value === 'string' && EMOJI_PREWARM_FILENAME_PATTERN.test(value)
}

const toEmojiAssetUrl = (filename: string) => `/svg/${filename}`

const readPersistedPrewarmedEmojiUrls = () => {
  if (persistedPrewarmedEmojiUrls) {
    return persistedPrewarmedEmojiUrls
  }

  const initialUrls = new Set<string>()

  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(EMOJI_PREWARM_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<EmojiPrewarmCacheRecord> | string[] | null
        const urls = Array.isArray(parsed)
          ? parsed
          : parsed?.version === EMOJI_PREWARM_STORAGE_VERSION && Array.isArray(parsed.urls)
            ? parsed.urls
            : []

        for (const url of urls) {
          if (typeof url === 'string') {
            initialUrls.add(url)
          }
        }
      }
    } catch {
      // Ignore invalid persisted cache content.
    }
  }

  persistedPrewarmedEmojiUrls = initialUrls
  return persistedPrewarmedEmojiUrls
}

const writePersistedPrewarmedEmojiUrls = (urls: Set<string>) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const serializedUrls = Array.from(urls).sort().slice(-MAX_EMOJI_PREWARM_CACHE_ENTRIES)
    const payload: EmojiPrewarmCacheRecord = {
      version: EMOJI_PREWARM_STORAGE_VERSION,
      urls: serializedUrls
    }

    window.localStorage.setItem(EMOJI_PREWARM_STORAGE_KEY, JSON.stringify(payload))

    if (serializedUrls.length !== urls.size) {
      persistedPrewarmedEmojiUrls = new Set(serializedUrls)
    }
  } catch {
    // Ignore storage quota and serialization errors.
  }
}

const markEmojiPrewarmed = (assetUrl: string) => {
  const prewarmedUrls = readPersistedPrewarmedEmojiUrls()
  if (prewarmedUrls.has(assetUrl)) {
    return
  }

  prewarmedUrls.add(assetUrl)
  writePersistedPrewarmedEmojiUrls(prewarmedUrls)
}

const getEmojiAssetUrls = async (): Promise<string[]> => {
  if (!emojiAssetUrlsPromise) {
    emojiAssetUrlsPromise = (async () => {
      const response = await fetch(EMOJI_PREWARM_MANIFEST_PATH, {
        cache: 'force-cache'
      })

      if (!response.ok) {
        return []
      }

      const manifest = await response.json() as unknown
      const assetUrls = Array.isArray(manifest)
        ? manifest.filter(isValidEmojiFilename).map(toEmojiAssetUrl)
        : []

      return sortEmojiUrls(assetUrls)
    })()
  }

  return emojiAssetUrlsPromise
}

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

const waitForAnimationFrame = () => new Promise<void>((resolve) => {
  let settled = false

  const settle = () => {
    if (settled) {
      return
    }

    settled = true
    window.clearTimeout(timeoutId)
    resolve()
  }

  const timeoutId = window.setTimeout(settle, EMOJI_PREWARM_FRAME_WAIT_TIMEOUT_MS)
  window.requestAnimationFrame(() => settle())
})

const scheduleIdle = (callback: () => void, timeout = EMOJI_PREWARM_TIMEOUT_MS) => {
  const idleWindow = window as WindowWithIdleCallback

  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(() => callback(), { timeout })
    return
  }

  window.setTimeout(callback, timeout)
}

const isDocumentHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

const isInputPending = () => {
  const schedulingNavigator = navigator as Navigator & {
    scheduling?: {
      isInputPending?: () => boolean
    }
  }

  return schedulingNavigator.scheduling?.isInputPending?.() === true
}

const waitForVisibleTab = async () => {
  while (isDocumentHidden()) {
    await delay(1000)
  }
}

const waitForBrowserIdle = async () => {
  while (isInputPending()) {
    await delay(500)
  }
}

const prewarmEmojiAsset = (assetUrl: string): Promise<void> => {
  return new Promise((resolve) => {
    const image = new Image()
    let settled = false

    const settle = () => {
      if (settled) {
        return
      }

      settled = true
      window.clearTimeout(timeoutId)
      image.onload = null
      image.onerror = null
      resolve()
    }

    const timeoutId = window.setTimeout(() => {
      image.src = ''
      settle()
    }, EMOJI_PREWARM_REQUEST_TIMEOUT_MS)

    image.decoding = 'async'
    image.loading = 'eager'

    image.onload = () => settle()
    image.onerror = () => settle()
    image.src = assetUrl
  })
}

const runPrewarmSlot = async (assetUrl: string) => {
  while (true) {
    await waitForVisibleTab()
    await waitForBrowserIdle()

    const didPrewarm = await new Promise<boolean>((resolve) => {
      scheduleIdle(() => {
        if (isDocumentHidden() || isInputPending()) {
          resolve(false)
          return
        }

        void prewarmEmojiAsset(assetUrl).then(
          () => resolve(true),
          () => resolve(true)
        )
      })
    })

    if (didPrewarm) {
      await delay(EMOJI_PREWARM_ITEM_DELAY_MS)
      return
    }

    await delay(250)
  }
}

const runEmojiPrewarm = async () => {
  await waitForAnimationFrame()
  await waitForAnimationFrame()
  await delay(EMOJI_PREWARM_START_DELAY_MS)

  const prewarmedUrls = readPersistedPrewarmedEmojiUrls()
  const assetUrls = (await getEmojiAssetUrls().catch(() => []))
    .filter((assetUrl) => !prewarmedUrls.has(assetUrl))

  let nextIndex = 0
  const workers = Array.from({ length: EMOJI_PREWARM_CONCURRENCY }, async () => {
    while (nextIndex < assetUrls.length) {
      const assetUrl = assetUrls[nextIndex]
      nextIndex += 1

      await runPrewarmSlot(assetUrl)
      markEmojiPrewarmed(assetUrl)
    }
  })

  for (const worker of workers) {
    await worker
  }
}

export const startEmojiPrewarm = () => {
  if (emojiPrewarmStarted || typeof window === 'undefined') {
    return
  }

  emojiPrewarmStarted = true
  void runEmojiPrewarm()
}
