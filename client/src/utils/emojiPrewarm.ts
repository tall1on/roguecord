const EMOJI_PREWARM_START_DELAY_MS = 2500
const EMOJI_PREWARM_ITEM_DELAY_MS = 500
const EMOJI_PREWARM_CONCURRENCY = 2
const EMOJI_PREWARM_TIMEOUT_MS = 8000
const EMOJI_PREWARM_MANIFEST_PATH = '/svg/index.json'
const EMOJI_PREWARM_FILENAME_PATTERN = /^[0-9a-f-]+\.svg$/i
const EMOJI_PREWARM_MAX_ITEMS = 48

let emojiAssetUrlsPromise: Promise<string[]> | null = null
let emojiPrewarmStarted = false

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

const sortEmojiUrls = (urls: string[]) => {
  return [...urls].sort((left, right) => left.localeCompare(right))
}

const isValidEmojiFilename = (value: unknown): value is string => {
  return typeof value === 'string' && EMOJI_PREWARM_FILENAME_PATTERN.test(value)
}

const toEmojiAssetUrl = (filename: string) => `/svg/${filename}`

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

      return sortEmojiUrls(assetUrls).slice(0, EMOJI_PREWARM_MAX_ITEMS)
    })()
  }

  return emojiAssetUrlsPromise
}

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

const waitForAnimationFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

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

    image.decoding = 'async'
    image.loading = 'eager'

    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = assetUrl
  })
}

const runPrewarmSlot = async (assetUrl: string) => {
  await waitForVisibleTab()
  await waitForBrowserIdle()

  await new Promise<void>((resolve) => {
    scheduleIdle(() => {
      if (isDocumentHidden() || isInputPending()) {
        resolve()
        return
      }

      void prewarmEmojiAsset(assetUrl).finally(resolve)
    })
  })

  await delay(EMOJI_PREWARM_ITEM_DELAY_MS)
}

const runEmojiPrewarm = async () => {
  await waitForAnimationFrame()
  await waitForAnimationFrame()
  await delay(EMOJI_PREWARM_START_DELAY_MS)

  const assetUrls = await getEmojiAssetUrls()

  let nextIndex = 0
  const workers = Array.from({ length: EMOJI_PREWARM_CONCURRENCY }, async () => {
    while (nextIndex < assetUrls.length) {
      const assetUrl = assetUrls[nextIndex]
      nextIndex += 1

      await runPrewarmSlot(assetUrl)
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
