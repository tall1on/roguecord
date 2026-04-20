// Pure environment checks for the system-audio loopback feature. No side effects.

export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    // Tauri v2 exposes IPC internals on the global `window` object.
    '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>)
  );
}

export function hasMediaStreamTrackGenerator(): boolean {
  return typeof (globalThis as any).MediaStreamTrackGenerator === 'function';
}

export function hasAudioData(): boolean {
  return typeof (globalThis as any).AudioData === 'function';
}

export function assertSupport(): void {
  if (!isTauriRuntime()) {
    throw new Error('system-audio loopback requires the Tauri desktop app');
  }
  if (!hasMediaStreamTrackGenerator()) {
    throw new Error(
      'MediaStreamTrackGenerator not available — Chromium 94+/WebView2 required'
    );
  }
  if (!hasAudioData()) {
    throw new Error('AudioData (WebCodecs) not available — Chromium 94+/WebView2 required');
  }
}
