<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  src: string
  title?: string
  poster?: string
}>(), {
  title: 'Video attachment',
  poster: ''
})

const videoRef = ref<HTMLVideoElement | null>(null)
const playerRef = ref<HTMLElement | null>(null)
const animationFrameId = ref<number | null>(null)
const isPlaying = ref(false)
const isMuted = ref(false)
const isFullscreen = ref(false)
const isSeeking = ref(false)
const isVolumePopoverOpen = ref(false)
const isPlayerInteractionHovered = ref(false)
const hasLoadedMetadata = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const seekValue = ref(0)
const volumePercent = ref(100)
const lastNonZeroVolumePercent = ref(100)

const clampedVolumePercent = computed(() => Math.min(100, Math.max(0, volumePercent.value)))
const normalizedVolume = computed(() => clampedVolumePercent.value / 100)
const progressPercent = computed(() => {
  if (!duration.value) return 0
  return Math.min(100, (currentTime.value / duration.value) * 100)
})
const bufferedPercent = computed(() => {
  const video = videoRef.value
  if (!video || !duration.value || video.buffered.length === 0) return 0

  try {
    return Math.min(100, (video.buffered.end(video.buffered.length - 1) / duration.value) * 100)
  } catch {
    return 0
  }
})
const displayedVolumePercent = computed(() => `${clampedVolumePercent.value}%`)
const volumeIcon = computed(() => {
  if (isMuted.value || clampedVolumePercent.value === 0) return VolumeX
  return Volume2
})
const formattedCurrentTime = computed(() => formatTime(currentTime.value))
const formattedDuration = computed(() => formatTime(duration.value))
const canToggleFullscreen = computed(() => typeof document !== 'undefined' && !!document.fullscreenEnabled)

const cancelAnimationFrameLoop = () => {
  if (animationFrameId.value !== null) {
    window.cancelAnimationFrame(animationFrameId.value)
    animationFrameId.value = null
  }
}

const updatePlaybackProgress = () => {
  const video = videoRef.value
  if (!video) return

  currentTime.value = video.currentTime
  if (!isSeeking.value) {
    seekValue.value = video.currentTime
  }

  if (!video.paused && !video.ended) {
    animationFrameId.value = window.requestAnimationFrame(updatePlaybackProgress)
  } else {
    cancelAnimationFrameLoop()
  }
}

const startProgressLoop = () => {
  cancelAnimationFrameLoop()
  animationFrameId.value = window.requestAnimationFrame(updatePlaybackProgress)
}

const applyVolume = async () => {
  const video = videoRef.value
  if (!video) return

  const effectivelyMuted = isMuted.value || clampedVolumePercent.value === 0
  video.muted = effectivelyMuted
  video.volume = effectivelyMuted ? 0 : normalizedVolume.value
}

const syncFromVideo = () => {
  const video = videoRef.value
  if (!video) return

  isPlaying.value = !video.paused && !video.ended
  isMuted.value = clampedVolumePercent.value === 0 || video.muted || video.volume === 0
  currentTime.value = video.currentTime
  if (!isSeeking.value) {
    seekValue.value = video.currentTime
  }
  if (Number.isFinite(video.duration)) {
    duration.value = video.duration
    hasLoadedMetadata.value = video.duration > 0
  }
}

const togglePlayback = async () => {
  const video = videoRef.value
  if (!video) return

  if (video.paused || video.ended) {
    await applyVolume()
    await video.play()
    startProgressLoop()
    return
  }

  video.pause()
}

const handleLoadedMetadata = () => {
  const video = videoRef.value
  if (!video) return

  duration.value = Number.isFinite(video.duration) ? video.duration : 0
  currentTime.value = video.currentTime
  seekValue.value = video.currentTime
  hasLoadedMetadata.value = duration.value > 0
}

const commitSeek = () => {
  const video = videoRef.value
  if (!video) return

  video.currentTime = seekValue.value
  currentTime.value = seekValue.value
  isSeeking.value = false
}

const handleSeekInput = (event: Event) => {
  const target = event.target as HTMLInputElement
  isSeeking.value = true
  seekValue.value = Number(target.value)
}

const handleSeekChange = (event: Event) => {
  const target = event.target as HTMLInputElement
  seekValue.value = Number(target.value)
  commitSeek()
}

const handleVolumeInput = async (event: Event) => {
  const target = event.target as HTMLInputElement
  const nextVolume = Math.min(100, Math.max(0, Number(target.value)))
  volumePercent.value = nextVolume
  if (nextVolume > 0) {
    lastNonZeroVolumePercent.value = nextVolume
    isMuted.value = false
  } else {
    isMuted.value = true
  }
  await applyVolume()
}

const toggleMute = async () => {
  if (isMuted.value || clampedVolumePercent.value === 0) {
    volumePercent.value = Math.max(1, lastNonZeroVolumePercent.value)
    isMuted.value = false
  } else {
    lastNonZeroVolumePercent.value = clampedVolumePercent.value
    volumePercent.value = 0
    isMuted.value = true
  }

  await applyVolume()
}

const toggleFullscreen = async () => {
  if (!playerRef.value || typeof document === 'undefined' || !document.fullscreenEnabled) return

  if (document.fullscreenElement === playerRef.value) {
    await document.exitFullscreen()
    return
  }

  await playerRef.value.requestFullscreen()
}

const handleFullscreenChange = () => {
  if (typeof document === 'undefined') return
  isFullscreen.value = document.fullscreenElement === playerRef.value
}

const closeVolumePopover = () => {
  isVolumePopoverOpen.value = false
}

const toggleVolumePopover = () => {
  isVolumePopoverOpen.value = !isVolumePopoverOpen.value
}

const showOverlay = computed(() => isPlayerInteractionHovered.value || isVolumePopoverOpen.value)

const handleDocumentPointerDown = (event: Event) => {
  const target = event.target as Node | null
  if (!target || !playerRef.value?.contains(target)) {
    closeVolumePopover()
  }
}

const handleDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closeVolumePopover()
  }
}

const formatTime = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const roundedValue = Math.floor(value)
  const hours = Math.floor(roundedValue / 3600)
  const minutes = Math.floor((roundedValue % 3600) / 60)
  const seconds = roundedValue % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

watch(() => props.src, () => {
  hasLoadedMetadata.value = false
  currentTime.value = 0
  duration.value = 0
  seekValue.value = 0
  isPlaying.value = false
  isMuted.value = clampedVolumePercent.value === 0
  cancelAnimationFrameLoop()
})

watch(clampedVolumePercent, async (value) => {
  if (value > 0) {
    lastNonZeroVolumePercent.value = value
  }
  await nextTick()
  await applyVolume()
}, { immediate: true })

onMounted(() => {
  if (typeof document === 'undefined') return
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleDocumentKeydown)
})

onBeforeUnmount(() => {
  cancelAnimationFrameLoop()
  if (typeof document !== 'undefined') {
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    document.removeEventListener('pointerdown', handleDocumentPointerDown)
    document.removeEventListener('keydown', handleDocumentKeydown)
  }
})
</script>

<template>
  <div
    ref="playerRef"
    class="video-player group relative flex w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/80 shadow-[0_8px_30px_rgba(0,0,0,0.28)]"
    @mouseenter="isPlayerInteractionHovered = true"
    @mouseleave="isPlayerInteractionHovered = false"
  >
    <video
      ref="videoRef"
      :src="src"
      :poster="poster || undefined"
      :title="title"
      class="video-player__media block max-h-[420px] w-full max-w-full flex-1 bg-black"
      preload="metadata"
      controlslist="nodownload noplaybackrate"
      disablepictureinpicture
      @click="togglePlayback"
      @loadedmetadata="handleLoadedMetadata"
      @play="isPlaying = true; startProgressLoop()"
      @pause="isPlaying = false; cancelAnimationFrameLoop(); syncFromVideo()"
      @ended="isPlaying = false; cancelAnimationFrameLoop(); syncFromVideo()"
      @timeupdate="syncFromVideo"
      @volumechange="syncFromVideo"
    ></video>

    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-zinc-950/95 via-zinc-950/70 to-transparent px-2.5 pb-2.5 pt-10 transition-opacity duration-150"
      :class="showOverlay ? 'opacity-100' : 'opacity-0'"
    >
      <div class="pointer-events-auto rounded-2xl border border-white/10 bg-zinc-900/55 px-2.5 py-2 backdrop-blur-md">
        <div class="flex min-w-0 items-center gap-2 text-zinc-100">
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/8 text-zinc-100 transition hover:bg-white/14 disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:w-9"
            :disabled="!src"
            :aria-label="isPlaying ? 'Pause video' : 'Play video'"
            @click="togglePlayback"
          >
            <Pause v-if="isPlaying" class="h-4 w-4" />
            <Play v-else class="ml-0.5 h-4 w-4" />
          </button>

          <div class="min-w-0 flex-1">
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-[10px] font-medium tracking-wide text-zinc-200 sm:text-[11px]">
                <span>{{ formattedCurrentTime }}</span>
                <span>{{ formattedDuration }}</span>
              </div>
              <input
                class="video-player-range video-player-range--timeline w-full"
                type="range"
                min="0"
                :max="duration || 0"
                :step="0.01"
                :value="isSeeking ? seekValue : currentTime"
                :disabled="!hasLoadedMetadata"
                @input="handleSeekInput"
                @change="handleSeekChange"
                @mouseup="commitSeek"
                @touchend="commitSeek"
              />
            </div>
          </div>

          <div class="relative shrink-0">
            <button
              type="button"
              class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/8 text-zinc-100 transition hover:bg-white/14 sm:h-9 sm:w-9"
              :aria-label="isVolumePopoverOpen ? 'Close volume controls' : 'Open volume controls'"
              :aria-expanded="isVolumePopoverOpen"
              @click.stop="toggleVolumePopover"
            >
              <component :is="volumeIcon" class="h-4 w-4" />
            </button>

            <div
              v-if="isVolumePopoverOpen"
              class="absolute bottom-full right-0 mb-2 w-44 rounded-2xl border border-white/10 bg-zinc-950/95 p-2 shadow-[0_12px_30px_rgba(0,0,0,0.4)] backdrop-blur-md"
              @click.stop
            >
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-100 transition hover:bg-white/10"
                  :aria-label="isMuted || clampedVolumePercent === 0 ? 'Unmute video' : 'Mute video'"
                  @click="toggleMute"
                >
                  <component :is="volumeIcon" class="h-4 w-4" />
                </button>

                <div class="min-w-0 flex-1">
                  <input
                    class="video-player-range w-full"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    :value="clampedVolumePercent"
                    aria-label="Video volume"
                    @input="handleVolumeInput"
                  />
                </div>

                <div class="w-9 shrink-0 text-right text-[10px] font-medium text-zinc-300 sm:text-[11px]">{{ displayedVolumePercent }}</div>
              </div>
            </div>
          </div>

          <div class="ml-auto shrink-0">
            <button
              v-if="canToggleFullscreen"
              type="button"
              class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/8 text-zinc-100 transition hover:bg-white/14 sm:h-9 sm:w-9"
              :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
              @click="toggleFullscreen"
            >
              <Minimize v-if="isFullscreen" class="h-4 w-4" />
              <Maximize v-else class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="pointer-events-none absolute inset-x-0 bottom-0 h-1.5 overflow-hidden bg-white/5">
      <div class="absolute inset-y-0 left-0 bg-white/15" :style="{ width: `${bufferedPercent}%` }"></div>
      <div class="absolute inset-y-0 left-0 bg-indigo-400/90" :style="{ width: `${progressPercent}%` }"></div>
    </div>
  </div>
</template>

<style scoped>
.video-player-range {
  appearance: none;
  height: 0.36rem;
  border-radius: 9999px;
  background: linear-gradient(90deg, rgba(244, 244, 245, 0.22), rgba(244, 244, 245, 0.08));
  outline: none;
}

.video-player-range--timeline {
  width: 100%;
}

.video-player:fullscreen {
  display: flex;
  height: 100vh;
  width: 100vw;
  max-width: 100vw;
  max-height: 100vh;
  flex-direction: column;
  justify-content: flex-start;
  border-radius: 0;
  border: 0;
  background: rgb(0 0 0);
}

.video-player:fullscreen .video-player__media {
  width: 100%;
  height: 100%;
  max-height: 100vh;
  min-height: 0;
  flex: 1 1 100%;
  object-fit: contain;
}

.video-player:fullscreen .pointer-events-none.absolute.inset-x-0.bottom-0.bg-gradient-to-t {
  padding-bottom: 1rem;
}

.video-player:fullscreen .pointer-events-none.absolute.inset-x-0.bottom-0.h-1\.5 {
  display: none;
}

.video-player-range::-webkit-slider-thumb {
  appearance: none;
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 9999px;
  border: 0;
  background: rgb(248 250 252);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
  cursor: pointer;
}

.video-player-range::-moz-range-thumb {
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 9999px;
  border: 0;
  background: rgb(248 250 252);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
  cursor: pointer;
}

.video-player-range::-moz-range-track {
  height: 0.36rem;
  border-radius: 9999px;
  background: linear-gradient(90deg, rgba(244, 244, 245, 0.22), rgba(244, 244, 245, 0.08));
}

</style>
