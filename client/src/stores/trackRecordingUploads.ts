import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useChatStore } from './chat'
import { getDriveRecordingStatus } from '../utils/driveTracks'
import {
  countTrackRecordings,
  enqueueTrackRecording,
  listTrackRecordings,
  removeTrackRecording,
  type QueuedTrackRecording
} from '../utils/trackRecordingQueue'

export type TrackRecordingStoreInput = {
  runId: string
  file: Blob
  mimeType: string
  durationMs: number
}

const BASE_RETRY_DELAY_MS = 2_000
const MAX_RETRY_DELAY_MS = 60_000

/**
 * Durable upload pipeline for finished track recordings.
 *
 * Recordings are written to IndexedDB first, then uploaded with backoff. Retries resume whenever the
 * socket reconnects, and a run is skipped once the server reports it already has the recording, so a
 * clip is never lost to a short outage and never uploaded twice.
 */
export const useTrackRecordingUploadsStore = defineStore('trackRecordingUploads', () => {
  const chatStore = useChatStore()
  const pendingCount = ref(0)

  let processing = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempt = 0
  let initialized = false

  const refreshCount = async (): Promise<void> => {
    try { pendingCount.value = await countTrackRecordings() } catch { /* non-fatal */ }
  }

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleRetry = () => {
    if (retryTimer !== null) return
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** retryAttempt, MAX_RETRY_DELAY_MS)
    retryAttempt++
    retryTimer = setTimeout(() => {
      retryTimer = null
      void process()
    }, delay)
  }

  const isNonRetryable = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    return message.includes('not found')
      || message.includes('no longer exists')
      || message.includes('unsupported')
      || message.includes('invalid')
  }

  const process = async (): Promise<void> => {
    if (processing || !chatStore.isConnected) return
    processing = true
    try {
      // Re-list after each sweep so clips enqueued mid-run (or on reconnect) are also handled.
      const processed = new Set<string>()
      while (chatStore.isConnected) {
        const entries = await listTrackRecordings()
        if (!entries.length) break
        let progressed = false
        let scheduledRetry = false
        for (const entry of entries) {
          if (!chatStore.isConnected) break
          if (processed.has(entry.runId)) continue
          processed.add(entry.runId)
          try {
            const alreadyStored = await getDriveRecordingStatus(chatStore, entry.runId, new AbortController().signal)
            if (alreadyStored) {
              await removeTrackRecording(entry.runId)
              progressed = true
              continue
            }
            await chatStore.uploadTrackRecording({
              runId: entry.runId,
              file: entry.blob,
              mimeType: entry.mimeType,
              durationMs: entry.durationMs
            })
            await removeTrackRecording(entry.runId)
            retryAttempt = 0
            progressed = true
          } catch (error) {
            if (isNonRetryable(error)) {
              console.warn('[Drive][recording] Dropping un-uploadable recording:', entry.runId, error)
              await removeTrackRecording(entry.runId)
              retryAttempt = 0
              progressed = true
              continue
            }
            console.warn('[Drive][recording] Upload failed, retrying later:', error)
            scheduleRetry()
            scheduledRetry = true
            break
          }
        }
        if (scheduledRetry || !progressed) break
      }
    } finally {
      processing = false
      await refreshCount()
    }
  }

  const enqueue = async (input: TrackRecordingStoreInput): Promise<void> => {
    const entry: QueuedTrackRecording = {
      runId: input.runId,
      mimeType: input.mimeType,
      durationMs: input.durationMs,
      size: input.file.size,
      createdAt: Date.now(),
      blob: input.file
    }
    await enqueueTrackRecording(entry)
    await refreshCount()
    void process()
  }

  const init = (): void => {
    if (initialized) return
    initialized = true
    watch(() => chatStore.isConnected, (connected) => {
      if (!connected) return
      retryAttempt = 0
      clearRetry()
      void process()
    })
    void refreshCount()
    void process()
  }

  return { pendingCount, enqueue, process, init }
})
