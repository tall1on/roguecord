<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { Camera, Maximize2 } from 'lucide-vue-next'

type CameraParticipant = { id: string; username?: string }

const props = defineProps<{ streams: Map<string, MediaStream>; participants: CameraParticipant[] }>()
const videoElements = new Map<string, HTMLVideoElement>()
const tileElements = new Map<string, HTMLButtonElement>()
const cameraTiles = computed(() => [...props.streams].map(([userId, stream]) => ({
  userId,
  stream,
  username: props.participants.find((participant) => participant.id === userId)?.username || 'Driver'
})))

const syncVideo = (userId: string, video: HTMLVideoElement) => {
  const stream = props.streams.get(userId) || null
  if (video.srcObject === stream) return
  video.srcObject = stream
  if (stream) void video.play().catch(() => {})
}

const setVideoRef = (userId: string, video: HTMLVideoElement | null) => {
  const previous = videoElements.get(userId)
  if (previous && previous !== video) previous.srcObject = null
  if (!video) {
    videoElements.delete(userId)
    return
  }
  videoElements.set(userId, video)
  syncVideo(userId, video)
}

const setTileRef = (userId: string, tile: HTMLButtonElement | null) => {
  if (tile) tileElements.set(userId, tile)
  else tileElements.delete(userId)
}

const getFullscreenElement = () => document.fullscreenElement
  || (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement
  || null

const toggleFullscreen = async (userId: string) => {
  const tile = tileElements.get(userId)
  if (!tile) return

  if (getFullscreenElement() === tile) {
    const exitFullscreen = document.exitFullscreen
      ? () => document.exitFullscreen()
      : (document as Document & { webkitExitFullscreen?: () => Promise<void> | void }).webkitExitFullscreen
    if (!exitFullscreen) return
    try {
      await exitFullscreen.call(document)
    } catch (_error) {
      // Fullscreen can be unavailable or denied by the browser.
    }
    return
  }

  const requestFullscreen = tile.requestFullscreen
    ? () => tile.requestFullscreen()
    : (tile as HTMLButtonElement & { webkitRequestFullscreen?: () => Promise<void> | void }).webkitRequestFullscreen
  if (!requestFullscreen) return
  try {
    await requestFullscreen.call(tile)
  } catch (_error) {
    // Fullscreen can be unavailable or denied by the browser.
  }
}

watch(() => props.streams, () => {
  for (const [userId, video] of videoElements) syncVideo(userId, video)
}, { flush: 'post' })

onBeforeUnmount(() => {
  for (const video of videoElements.values()) video.srcObject = null
  videoElements.clear()
  tileElements.clear()
})
</script>

<template>
  <section class="drive-camera-stage flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Live driver cameras">
    <div v-if="!cameraTiles.length" class="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <Camera class="mb-3 h-8 w-8 text-indigo-300" />
      <p class="text-sm font-semibold text-white">No cameras are being shared</p>
      <p class="mt-1 max-w-sm text-xs leading-relaxed text-zinc-400">Drivers can share a low-bandwidth rear-camera feed from their Drive Together controls.</p>
    </div>

    <div v-else class="drive-camera-grid grid min-h-0 flex-1 gap-2 overflow-auto p-2">
      <button
        v-for="tile in cameraTiles"
        :key="tile.userId"
        :ref="(element) => setTileRef(tile.userId, element as HTMLButtonElement | null)"
        type="button"
        class="drive-camera-tile group relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
        :aria-label="`View ${tile.username}'s camera fullscreen`"
        :title="`Click to view ${tile.username}'s camera fullscreen`"
        @click="toggleFullscreen(tile.userId)"
      >
        <video
          :ref="(element) => setVideoRef(tile.userId, element as HTMLVideoElement | null)"
          autoplay
          muted
          playsinline
          class="drive-camera-video h-full w-full bg-black object-contain"
        />
        <span class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-3 pb-3 pt-8">
          <span class="min-w-0 flex-1 truncate text-xs font-semibold text-white">{{ tile.username }}</span>
          <span class="shrink-0 text-[10px] font-medium uppercase tracking-wide text-red-200">Live</span>
          <Maximize2 class="h-4 w-4 shrink-0 text-white/80 transition group-hover:text-white" aria-hidden="true" />
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.drive-camera-grid {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  grid-auto-rows: minmax(10rem, 1fr);
  align-content: stretch;
}

.drive-camera-tile:fullscreen,
.drive-camera-tile:-webkit-full-screen {
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
  background: #000;
}

.drive-camera-tile:fullscreen .drive-camera-video,
.drive-camera-tile:-webkit-full-screen .drive-camera-video {
  max-width: 100vw;
  max-height: 100vh;
  max-height: 100dvh;
  object-fit: contain;
}
</style>
