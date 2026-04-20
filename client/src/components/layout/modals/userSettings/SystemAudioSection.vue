<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWebRtcStore } from '../../../../stores/webrtc'
import {
  isTauriRuntime,
  hasMediaStreamTrackGenerator
} from '../../../../audio/systemLoopback/featureDetect'
import type { DeviceInfo } from '../../../../audio/systemLoopback/types'

const webrtcStore = useWebRtcStore()

const supported = computed(() => isTauriRuntime() && hasMediaStreamTrackGenerator())
const devices = ref<DeviceInfo[]>([])
const devicesLoaded = ref(false)
const devicesLoading = ref(false)
const devicesError = ref<string | null>(null)
const selectedDeviceId = ref<string>('')

const DEFAULT_VALUE = '__default__'

const statusLabel = computed(() => {
  switch (webrtcStore.systemAudioStatus) {
    case 'idle':
      return 'Idle'
    case 'starting':
      return 'Starting…'
    case 'live':
      return 'Live'
    case 'error':
      return 'Error'
    default:
      return String(webrtcStore.systemAudioStatus)
  }
})

const canStart = computed(() => {
  return supported.value
    && webrtcStore.systemAudioStatus !== 'live'
    && webrtcStore.systemAudioStatus !== 'starting'
    && Boolean(webrtcStore.activeVoiceChannelId)
})

const canStop = computed(() => webrtcStore.systemAudioStatus === 'live')

let statsTimer: number | null = null

const startStatsPolling = () => {
  if (statsTimer !== null) return
  statsTimer = window.setInterval(() => {
    void webrtcStore.refreshSystemAudioStats()
  }, 2000)
}

const stopStatsPolling = () => {
  if (statsTimer !== null) {
    window.clearInterval(statsTimer)
    statsTimer = null
  }
}

watch(() => webrtcStore.systemAudioStatus, (status) => {
  if (status === 'live') {
    void webrtcStore.refreshSystemAudioStats()
    startStatsPolling()
  } else {
    stopStatsPolling()
  }
})

onMounted(async () => {
  if (!supported.value) return
  // Lazy device load on mount of an already-open panel; no-op if fails.
  await ensureDevicesLoaded()
})

onBeforeUnmount(() => {
  stopStatsPolling()
})

async function ensureDevicesLoaded() {
  if (!supported.value || devicesLoaded.value || devicesLoading.value) return
  devicesLoading.value = true
  devicesError.value = null
  try {
    const mod = await import('../../../../audio/systemLoopback')
    const list = await mod.listSystemAudioDevices()
    devices.value = list
    devicesLoaded.value = true
    if (!selectedDeviceId.value) {
      const def = list.find((d) => d.isDefaultOutput)
      selectedDeviceId.value = def ? def.id : DEFAULT_VALUE
    }
  } catch (err) {
    devicesError.value = err instanceof Error ? err.message : String(err)
  } finally {
    devicesLoading.value = false
  }
}

async function handleStart() {
  if (!canStart.value) return
  const deviceId = selectedDeviceId.value && selectedDeviceId.value !== DEFAULT_VALUE
    ? selectedDeviceId.value
    : undefined
  try {
    await webrtcStore.produceSystemAudio({ deviceId })
  } catch {
    // Error already captured into systemAudioError by the store.
  }
}

async function handleStop() {
  if (!canStop.value && webrtcStore.systemAudioStatus !== 'error') return
  try {
    await webrtcStore.stopSystemAudio()
  } catch {
    // no-op
  }
}

async function handleRefreshDevices() {
  devicesLoaded.value = false
  await ensureDevicesLoaded()
}
</script>

<template>
  <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
    <div class="flex items-start justify-between mb-4 pb-4 border-b border-white/5">
      <div>
        <h3 class="text-sm font-semibold text-zinc-200">System Audio (Desktop only)</h3>
        <p class="text-xs text-zinc-500 mt-1">
          Share your computer's audio output as a separate audio stream. Requires the RogueCord desktop app.
        </p>
      </div>
      <span
        class="text-xs font-medium px-2 py-1 rounded-md"
        :class="{
          'bg-zinc-800 text-zinc-400': webrtcStore.systemAudioStatus === 'idle',
          'bg-indigo-900/40 text-indigo-300': webrtcStore.systemAudioStatus === 'starting',
          'bg-green-900/40 text-green-300': webrtcStore.systemAudioStatus === 'live',
          'bg-red-900/40 text-red-300': webrtcStore.systemAudioStatus === 'error'
        }"
      >
        {{ statusLabel }}
      </span>
    </div>

    <div v-if="!supported" class="text-xs text-zinc-500 bg-zinc-950/50 rounded-lg border border-white/5 p-4">
      <p class="text-zinc-400">Not available in this environment.</p>
      <p class="mt-1">
        This feature requires the RogueCord desktop build (Tauri + WebView2) on Windows with
        Chromium's <code class="text-zinc-300">MediaStreamTrackGenerator</code> support.
      </p>
    </div>

    <div v-else class="space-y-4">
      <div>
        <label class="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wide">
          Capture Device
        </label>
        <div class="flex items-center gap-2">
          <select
            v-model="selectedDeviceId"
            :disabled="webrtcStore.systemAudioStatus === 'live' || webrtcStore.systemAudioStatus === 'starting'"
            class="flex-1 bg-zinc-950 text-sm font-medium text-white rounded-lg px-3 py-2.5 border border-white/10 appearance-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all disabled:opacity-50"
          >
            <option :value="DEFAULT_VALUE">System default output</option>
            <option v-for="d in devices" :key="d.id" :value="d.id">
              {{ d.name || `Output ${d.id.slice(0, 8)}` }}
            </option>
          </select>
          <button
            type="button"
            class="text-xs px-3 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
            :disabled="devicesLoading"
            @click="handleRefreshDevices"
          >{{ devicesLoading ? '…' : 'Refresh' }}</button>
        </div>
        <p v-if="devicesError" class="text-xs text-red-400 mt-2">{{ devicesError }}</p>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          class="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-200 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="!canStart"
          @click="handleStart"
        >Start</button>
        <button
          type="button"
          class="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-200 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="!canStop && webrtcStore.systemAudioStatus !== 'error'"
          @click="handleStop"
        >Stop</button>
        <p v-if="!webrtcStore.activeVoiceChannelId" class="text-xs text-zinc-500 ml-2">
          Join a voice channel to start.
        </p>
      </div>

      <p v-if="webrtcStore.systemAudioError" class="text-xs text-red-400">
        {{ webrtcStore.systemAudioError }}
      </p>

      <div
        v-if="webrtcStore.systemAudioStats"
        class="grid grid-cols-2 gap-3 text-xs bg-zinc-950/50 border border-white/5 rounded-lg p-3"
      >
        <div>
          <div class="text-zinc-500 uppercase tracking-wide">Frames emitted</div>
          <div class="text-zinc-200 font-mono">{{ webrtcStore.systemAudioStats.framesEmitted }}</div>
        </div>
        <div>
          <div class="text-zinc-500 uppercase tracking-wide">Dropped (ring / channel)</div>
          <div class="text-zinc-200 font-mono">
            {{ webrtcStore.systemAudioStats.framesDroppedRingOverflow }} /
            {{ webrtcStore.systemAudioStats.framesDroppedChannelFull }}
          </div>
        </div>
        <div>
          <div class="text-zinc-500 uppercase tracking-wide">Encoder p50 / p99 (µs)</div>
          <div class="text-zinc-200 font-mono">
            {{ webrtcStore.systemAudioStats.encoderLatencyUsP50 }} /
            {{ webrtcStore.systemAudioStats.encoderLatencyUsP99 }}
          </div>
        </div>
        <div>
          <div class="text-zinc-500 uppercase tracking-wide">Device rate / channels</div>
          <div class="text-zinc-200 font-mono">
            {{ webrtcStore.systemAudioStats.captureDeviceSampleRate }} Hz /
            {{ webrtcStore.systemAudioStats.captureDeviceChannels }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
