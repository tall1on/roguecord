import type { App, DirectiveBinding, ObjectDirective, Plugin } from 'vue'

type TwemojiParser = {
  parse(node: Node, options?: Record<string, unknown>): void
  parse(text: string, options?: Record<string, unknown>): string
}

type TwemojiDirectiveOptions = {
  className?: string
  tag?: string
}

type TwemojiElement = HTMLElement & {
  __roguecordTwemojiSource?: string
  __roguecordTwemojiHtml?: string
  __roguecordTwemojiOptions?: TwemojiDirectiveOptions
}

type TwemojiRootElement = HTMLElement & {
  __roguecordTwemojiObserver?: MutationObserver
  __roguecordTwemojiFrame?: number
  __roguecordTwemojiParsing?: boolean
  __roguecordTwemojiInstalled?: boolean
}

const DEFAULT_OPTIONS: Required<TwemojiDirectiveOptions> = {
  className: 'rc-twemoji',
  tag: 'img'
}

const GLOBAL_IGNORE_SELECTOR = 'img, svg, canvas, textarea, input, select, option, [contenteditable="true"], [data-no-twemoji]'

let twemojiModulePromise: Promise<TwemojiParser | null> | null = null

const resolveTwemojiParser = (module: unknown): TwemojiParser | null => {
  if (module && typeof module === 'object') {
    const candidate = 'default' in module ? (module as { default?: unknown }).default : module
    if (candidate && typeof candidate === 'object' && typeof (candidate as { parse?: unknown }).parse === 'function') {
      return candidate as TwemojiParser
    }
  }

  return null
}

const loadTwemoji = async (): Promise<TwemojiParser | null> => {
  if (typeof window === 'undefined') {
    return null
  }

  if (!twemojiModulePromise) {
    twemojiModulePromise = import('twemoji')
      .then((module) => resolveTwemojiParser(module))
      .catch(() => null)
  }

  return twemojiModulePromise
}

const getNormalizedText = (value: unknown): string => {
  if (value == null) {
    return ''
  }

  return String(value)
}

const getOptions = (binding: DirectiveBinding<string | TwemojiDirectiveOptions | undefined>): Required<TwemojiDirectiveOptions> => {
  if (typeof binding.value === 'string') {
    return {
      ...DEFAULT_OPTIONS
    }
  }

  return {
    ...DEFAULT_OPTIONS,
    ...(binding.value || {})
  }
}

const getParseOptions = (options: Required<TwemojiDirectiveOptions>) => ({
  className: options.className,
  folder: 'svg',
  ext: '.svg'
})

const renderTwemoji = async (element: TwemojiElement, text: string, options: Required<TwemojiDirectiveOptions>) => {
  const twemoji = await loadTwemoji()
  if (!twemoji) {
    element.textContent = text
    element.__roguecordTwemojiSource = text
    element.__roguecordTwemojiOptions = options
    element.__roguecordTwemojiHtml = element.innerHTML
    return
  }

  const nextHtml = twemoji.parse(text, getParseOptions(options))

  if (
    element.__roguecordTwemojiSource === text &&
    element.__roguecordTwemojiHtml === nextHtml &&
    element.__roguecordTwemojiOptions?.className === options.className &&
    element.__roguecordTwemojiOptions?.tag === options.tag
  ) {
    return
  }

  element.innerHTML = nextHtml
  element.__roguecordTwemojiSource = text
  element.__roguecordTwemojiHtml = nextHtml
  element.__roguecordTwemojiOptions = options
}

const updateElement = (element: TwemojiElement, binding: DirectiveBinding<string | TwemojiDirectiveOptions | undefined>) => {
  const sourceText = getNormalizedText(binding.arg ? binding.arg : binding.value)
  const fallbackText = typeof binding.value === 'string' ? binding.value : ''
  const text = sourceText || fallbackText || getNormalizedText(element.textContent)
  const options = getOptions(binding)

  void renderTwemoji(element, text, options)
}

const twemojiDirective: ObjectDirective<TwemojiElement, string | TwemojiDirectiveOptions | undefined> = {
  mounted(element, binding) {
    updateElement(element, binding)
  },
  updated(element, binding) {
    updateElement(element, binding)
  }
}

const shouldSkipGlobalTwemoji = (node: Node): boolean => {
  if (!(node instanceof HTMLElement)) {
    return false
  }

  return node.matches(GLOBAL_IGNORE_SELECTOR) || Boolean(node.closest(GLOBAL_IGNORE_SELECTOR))
}

const scheduleGlobalParse = (root: TwemojiRootElement, parse: () => void) => {
  if (typeof window === 'undefined' || root.__roguecordTwemojiFrame != null) {
    return
  }

  root.__roguecordTwemojiFrame = window.requestAnimationFrame(() => {
    root.__roguecordTwemojiFrame = undefined
    parse()
  })
}

const installGlobalTwemoji = async (root: TwemojiRootElement) => {
  if (root.__roguecordTwemojiInstalled) {
    return
  }

  root.__roguecordTwemojiInstalled = true

  const twemoji = await loadTwemoji()
  if (!twemoji || typeof MutationObserver === 'undefined') {
    root.__roguecordTwemojiInstalled = false
    return
  }

  const parseRoot = () => {
    if (root.__roguecordTwemojiParsing) {
      return
    }

    root.__roguecordTwemojiParsing = true
    try {
      twemoji.parse(root, getParseOptions(DEFAULT_OPTIONS))
    } finally {
      root.__roguecordTwemojiParsing = false
    }
  }

  parseRoot()

  const observer = new MutationObserver((mutations) => {
    if (root.__roguecordTwemojiParsing) {
      return
    }

    const hasRelevantChange = mutations.some((mutation) => {
      if (mutation.type === 'characterData') {
        return !shouldSkipGlobalTwemoji(mutation.target.parentNode || mutation.target)
      }

      if (mutation.type === 'childList') {
        const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
        return changedNodes.some((node) => !shouldSkipGlobalTwemoji(node))
      }

      return false
    })

    if (hasRelevantChange) {
      scheduleGlobalParse(root, parseRoot)
    }
  })

  observer.observe(root, {
    childList: true,
    characterData: true,
    subtree: true
  })

  root.__roguecordTwemojiObserver = observer
}

const globalTwemojiPlugin: Plugin = {
  install(app: App) {
    app.directive('twemoji', twemojiDirective)

    const originalMount = app.mount
    app.mount = ((containerOrSelector: Element | string) => {
      const mounted = originalMount(containerOrSelector)
      let root: Element | null = null

      if (typeof containerOrSelector === 'string') {
        root = document.querySelector(containerOrSelector)
      } else {
        root = containerOrSelector
      }

      if (root instanceof HTMLElement) {
        void installGlobalTwemoji(root)
      }

      return mounted
    }) as typeof app.mount
  }
}

export const installTwemojiDirective = (app: App) => {
  app.use(globalTwemojiPlugin)
}
