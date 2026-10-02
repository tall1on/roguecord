<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Car, LocateFixed, MapPin, Mic, MicOff, PhoneOff } from 'lucide-vue-next'
import type { CircleMarker, Map as LeafletMap } from 'leaflet'
import { useChatStore } from '../../stores/chat'
import { useWebRtcStore } from '../../stores/webrtc'
import { useDriveStore } from '../../stores/drive'

const props = defineProps<{ channelId: string; channelName: string }>()
const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()
const driveStore = useDriveStore()
const mapElement = ref<HTMLElement | null>(null)
const mapError = ref<string | null>(null)
const isJoined = computed(() => driveStore.joinedChannelId === props.channelId)
const participants = computed(() => webrtcStore.channelParticipants.get(props.channelId) || [])
const visibleLocations = computed(() => isJoined.value ? [...driveStore.locations.values()] : [])
let leaflet: typeof import('leaflet') | null = null
let map: LeafletMap | null = null
let resizeObserver: ResizeObserver | null = null
let disposed = false
const markers = new Map<string, CircleMarker>()

const syncMap = () => {
  if (!map || !leaflet) return
  const points = visibleLocations.value
  const userIds = new Set(points.map((point) => point.user_id))
  for (const [userId, marker] of markers) {
    if (!userIds.has(userId)) {
      marker.remove()
      markers.delete(userId)
    }
  }

  // Unwrap around the largest empty longitude gap so trips across the date line stay together.
  const longitudes = points.map((point) => (point.longitude + 360) % 360).sort((a, b) => a - b)
  let startLongitude = longitudes[0] ?? 0
  let largestGap = -1
  for (let index = 0; index < longitudes.length; index++) {
    const next = longitudes[(index + 1) % longitudes.length]! + (index === longitudes.length - 1 ? 360 : 0)
    const gap = next - longitudes[index]!
    if (gap > largestGap) {
      largestGap = gap
      startLongitude = next % 360
    }
  }
  const bounds = leaflet.latLngBounds([])
  for (const point of points) {
    let longitude = (point.longitude + 360) % 360
    if (longitude < startLongitude) longitude += 360
    const latLng = leaflet.latLng(point.latitude, longitude)
    bounds.extend(latLng)
    const user = participants.value.find((participant) => participant.id === point.user_id)
    const isSelf = point.user_id === chatStore.currentUser?.id
    const color = webrtcStore.isUserSpeaking(point.user_id) ? '#22c55e' : isSelf ? '#818cf8' : '#38bdf8'
    let marker = markers.get(point.user_id)
    if (!marker) {
      marker = leaflet.circleMarker(latLng, { radius: 9, weight: 3, color: '#ffffff', fillOpacity: 1 }).addTo(map)
      markers.set(point.user_id, marker)
    }
    marker.setLatLng(latLng).setStyle({ fillColor: color })
    const label = document.createElement('span')
    label.textContent = `${user?.username || 'Participant'}${isSelf ? ' (you)' : ''} - accuracy ${Math.round(point.accuracy)} m`
    if (marker.getTooltip()) marker.setTooltipContent(label)
    else marker.bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -10] })
  }
  const size = map.getSize()
  if (size.x <= 0 || size.y <= 0) return
  if (bounds.isValid()) map.fitBounds(bounds, {
    padding: [Math.min(55, size.x / 4), Math.min(65, size.y / 4)], maxZoom: 16, animate: false
  })
  else map.setView([20, 0], 2, { animate: false })
}

watch([visibleLocations, participants, () => [...webrtcStore.speakingUserIds]], syncMap, { deep: true })
onMounted(async () => {
  try {
    const [module] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')])
    if (disposed || !mapElement.value) return
    leaflet = module
    map = leaflet.map(mapElement.value, { zoomControl: true, attributionControl: true, minZoom: -10, zoomSnap: 0 }).setView([20, 0], 2)
    leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      minZoom: -10,
      minNativeZoom: 0,
      maxZoom: 19
    }).addTo(map)
    resizeObserver = new ResizeObserver(() => {
      map?.invalidateSize({ animate: false, pan: false })
      syncMap()
    })
    resizeObserver.observe(mapElement.value)
    syncMap()
  } catch {
    mapError.value = 'The map could not be loaded. Voice and location sharing are still available.'
  }
})
onBeforeUnmount(() => {
  disposed = true
  resizeObserver?.disconnect()
  map?.remove()
  map = null
  markers.clear()
})
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col bg-zinc-950">
    <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/5 px-4 py-3 md:px-6">
      <div class="flex min-w-0 items-center gap-3">
        <Car class="h-6 w-6 shrink-0 text-indigo-400" />
        <div class="min-w-0">
          <h2 class="truncate font-bold text-white">{{ channelName }}</h2>
          <p class="text-xs text-zinc-400">Drive Together - {{ visibleLocations.length }} live locations</p>
        </div>
      </div>
      <div v-if="isJoined" class="flex items-center gap-2">
        <button class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold transition-colors hover:bg-zinc-800" :class="driveStore.isSharing ? 'text-indigo-300' : 'text-zinc-300'" @click="driveStore.isSharing ? driveStore.stopSharing() : driveStore.startSharing()">
          <LocateFixed class="mr-1 inline h-4 w-4" />{{ driveStore.isSharing ? 'Stop sharing GPS' : 'Share GPS' }}
        </button>
        <button class="rounded-lg p-2 hover:bg-zinc-800" :class="webrtcStore.isMuted || webrtcStore.isDeafened ? 'text-red-400' : 'text-zinc-300'" :aria-label="webrtcStore.isMuted || webrtcStore.isDeafened ? 'Unmute microphone' : 'Mute microphone'" @click="webrtcStore.toggleMute()">
          <MicOff v-if="webrtcStore.isMuted || webrtcStore.isDeafened" class="h-5 w-5" /><Mic v-else class="h-5 w-5" />
        </button>
        <button class="rounded-lg p-2 text-red-400 hover:bg-red-500/10" aria-label="Leave Drive Together" @click="webrtcStore.leaveVoiceChannel()"><PhoneOff class="h-5 w-5" /></button>
      </div>
      <button v-else class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500" @click="webrtcStore.joinVoiceChannel(channelId)">Join Drive Together</button>
    </header>
    <p v-if="driveStore.locationError && isJoined" class="shrink-0 bg-amber-950/30 px-4 py-3 text-sm text-amber-200" role="alert">{{ driveStore.locationError }}</p>
    <div class="relative min-h-[16rem] flex-1 isolate">
      <div ref="mapElement" class="drive-map absolute inset-0 z-0" aria-label="Dark OpenStreetMap showing participant GPS locations" />
      <div v-if="!visibleLocations.length || mapError" class="pointer-events-none absolute inset-x-4 top-4 z-10 mx-auto max-w-md rounded-xl border border-white/10 bg-zinc-950/90 p-4 text-center shadow-xl backdrop-blur">
        <MapPin class="mx-auto mb-2 h-6 w-6 text-indigo-400" />
        <p class="text-sm font-medium text-white">{{ mapError || (isJoined ? 'Waiting for shared GPS locations' : 'Join to see and share live locations') }}</p>
        <p class="mt-1 text-xs text-zinc-400">Voice works even if you do not share your location. The map always fits all known positions.</p>
      </div>
    </div>
    <footer class="shrink-0 border-t border-white/5 px-4 py-3">
      <div class="mb-2 flex max-h-24 flex-wrap gap-2 overflow-y-auto">
        <span v-for="participant in participants" :key="participant.id" class="flex items-center gap-2 rounded-full border px-3 py-1 text-xs" :class="webrtcStore.isUserSpeaking(participant.id) ? 'border-green-500/50 text-green-300' : 'border-white/10 text-zinc-300'">
          <MicOff v-if="participant.isMuted || participant.isDeafened" class="h-3 w-3 text-red-400" />
          {{ participant.username }}
          <MapPin v-if="isJoined && driveStore.locations.has(participant.id)" class="h-3 w-3 text-indigo-400" />
          <span v-if="driveStore.getSpeedLabel(participant.id, channelId)" class="tabular-nums text-indigo-300" title="Current GPS speed (approximate)">{{ driveStore.getSpeedLabel(participant.id, channelId) }}</span>
        </span>
      </div>
      <p class="text-[11px] leading-relaxed text-zinc-500">GPS is shared only with people in this call and stops when you leave. Locations are not saved. Map tiles are loaded from OpenStreetMap. Screen sharing is disabled.</p>
    </footer>
  </section>
</template>

<style scoped>
.drive-map {
  background: #18181b;
}
.drive-map :deep(.leaflet-tile-pane) {
  filter: invert(1) hue-rotate(180deg) brightness(0.75) saturate(0.65) contrast(1.1);
}
.drive-map :deep(.leaflet-tooltip),
.drive-map :deep(.leaflet-bar a) {
  background: #27272a;
  border-color: #3f3f46;
  color: #f4f4f5;
}
.drive-map :deep(.leaflet-tooltip-top::before) {
  border-top-color: #27272a;
}
.drive-map :deep(.leaflet-bar a:hover) {
  background: #3f3f46;
}
.drive-map :deep(.leaflet-control-attribution) {
  background: rgb(24 24 27 / 90%);
  color: #a1a1aa;
}
.drive-map :deep(.leaflet-control-attribution a) {
  color: #a5b4fc;
}
</style>
