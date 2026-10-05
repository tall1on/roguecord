// Durable on-device queue for finished track recordings. Clips are written here before any upload
// attempt so they survive a disconnect, a failed upload, or a page reload, and can be retried until
// the server confirms it has the recording.

export type QueuedTrackRecording = {
  runId: string
  mimeType: string
  durationMs: number
  size: number
  createdAt: number
  blob: Blob
}

const DB_NAME = 'roguecord-track-recordings'
const STORE_NAME = 'pending'
const DB_VERSION = 1

const memoryFallback = new Map<string, QueuedTrackRecording>()

const hasIndexedDb = () => typeof indexedDB !== 'undefined'

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'runId' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Could not open the recording queue'))
})

const withStore = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const request = operation(transaction.objectStore(STORE_NAME))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Recording queue operation failed'))
    transaction.oncomplete = () => db.close()
    transaction.onabort = () => db.close()
  })
}

export const enqueueTrackRecording = async (entry: QueuedTrackRecording): Promise<void> => {
  if (!hasIndexedDb()) {
    memoryFallback.set(entry.runId, entry)
    return
  }
  try {
    await withStore('readwrite', (store) => store.put(entry))
  } catch {
    // IndexedDB can fail (private mode, quota); fall back to memory so the clip is still retried now.
    memoryFallback.set(entry.runId, entry)
  }
}

export const listTrackRecordings = async (): Promise<QueuedTrackRecording[]> => {
  if (!hasIndexedDb()) return [...memoryFallback.values()].sort((a, b) => a.createdAt - b.createdAt)
  try {
    const all = await withStore<QueuedTrackRecording[]>('readonly', (store) => store.getAll() as IDBRequest<QueuedTrackRecording[]>)
    const merged = new Map(all.map((entry) => [entry.runId, entry]))
    for (const [runId, entry] of memoryFallback) if (!merged.has(runId)) merged.set(runId, entry)
    return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return [...memoryFallback.values()].sort((a, b) => a.createdAt - b.createdAt)
  }
}

export const removeTrackRecording = async (runId: string): Promise<void> => {
  memoryFallback.delete(runId)
  if (!hasIndexedDb()) return
  try {
    await withStore('readwrite', (store) => store.delete(runId))
  } catch {
    // The in-memory entry is already cleared; a stale IndexedDB entry is skipped by the status check.
  }
}

export const countTrackRecordings = async (): Promise<number> => {
  if (!hasIndexedDb()) return memoryFallback.size
  try {
    const stored = await withStore<number>('readonly', (store) => store.count())
    return Math.max(stored, memoryFallback.size)
  } catch {
    return memoryFallback.size
  }
}

/** Test-only: clears the in-memory fallback used when IndexedDB is unavailable. */
export const clearTrackRecordingMemoryFallback = (): void => {
  memoryFallback.clear()
}
