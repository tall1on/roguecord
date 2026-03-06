import { isTauri } from './isTauri'

export const openExternalUrl = async (url: string): Promise<boolean> => {
  const normalizedUrl = url.trim()
  if (!normalizedUrl) {
    return false
  }

  if (!isTauri()) {
    window.open(normalizedUrl, '_blank', 'noopener,noreferrer')
    return true
  }

  const { openUrl } = await import('@tauri-apps/plugin-opener')
  const targetUrl = new URL(normalizedUrl, window.location.origin).toString()
  await openUrl(targetUrl)
  return true
}
