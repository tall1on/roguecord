export const isCachyOS = (): boolean => {
  return import.meta.env.TAURI_CACHYOS_BUILD === 'true'
}
