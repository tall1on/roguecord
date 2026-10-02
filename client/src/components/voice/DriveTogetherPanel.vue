<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Car, Flag, Headphones, LocateFixed, MapPin, Mic, MicOff, PhoneOff, Search, X } from 'lucide-vue-next'
import type { CircleMarker, Map as LeafletMap, Polyline } from 'leaflet'
import { useChatStore } from '../../stores/chat'
import { useWebRtcStore } from '../../stores/webrtc'
import { useDriveStore } from '../../stores/drive'
import { getDriveMapCoordinates, searchDriveDestinations, type DriveDestination } from '../../utils/driveNavigation'

const props = withDefaults(defineProps<{ channelId: string; channelName: string; phoneLayout?: boolean }>(), { phoneLayout: false })
const emit = defineEmits<{ (e: 'back'): void }>()
const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()
const driveStore = useDriveStore()
const mapElement = ref<HTMLElement | null>(null)
const mapError = ref<string | null>(null)
const navigationElement = ref<HTMLElement | null>(null)
const destinationKey = computed(() => `${chatStore.activeConnectionId}:${props.channelId}`)
const destination = computed<DriveDestination | null>({
  get: () => driveStore.destinations.get(destinationKey.value) ?? null,
  set: (value) => {
    if (value) driveStore.destinations.set(destinationKey.value, value)
    else driveStore.destinations.delete(destinationKey.value)
  }
})
const addressQuery = ref(destination.value?.label ?? '')
const searchResults = ref<DriveDestination[]>([])
const searchError = ref<string | null>(null)
const isSearching = ref(false)
let searchController: AbortController | null = null
let lastSearchAt = 0
const isJoined = computed(() => driveStore.joinedChannelId === props.channelId)
const participants = computed(() => webrtcStore.channelParticipants.get(props.channelId) || [])
const visibleLocations = computed(() => isJoined.value ? [...driveStore.locations.values()] : [])
let leaflet: typeof import('leaflet') | null = null
let map: LeafletMap | null = null
let resizeObserver: ResizeObserver | null = null
let disposed = false
const markers = new Map<string, CircleMarker>()
const destinationLines = new Map<string, Polyline>()
let destinationMarker: CircleMarker | null = null

const cancelSearch = () => {
  searchController?.abort()
  searchController = null
  isSearching.value = false
  searchResults.value = []
  searchError.value = null
}
watch(addressQuery, cancelSearch, { flush: 'sync' })
watch(destinationKey, () => {
  cancelSearch()
  addressQuery.value = destination.value?.label ?? ''
}, { flush: 'sync' })

const searchAddress = async () => {
  if (isSearching.value) return
  if (Date.now() - lastSearchAt < 1000) {
    searchError.value = 'Wait a moment before searching again.'
    return
  }
  lastSearchAt = Date.now()
  cancelSearch()
  const controller = new AbortController()
  searchController = controller
  isSearching.value = true
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
  try {
    const results = await searchDriveDestinations(addressQuery.value, controller.signal)
    if (disposed || searchController !== controller) return
    searchResults.value = results
    if (!results.length) searchError.value = 'No matching address found. Try adding a city or postcode.'
  } catch (error) {
    if (disposed || searchController !== controller) return
    searchError.value = timedOut ? 'Address search timed out. Please try again.'
      : error instanceof Error ? error.message : 'Address search failed. Please try again.'
  } finally {
    clearTimeout(timeout)
    if (searchController === controller) {
      searchController = null
      isSearching.value = false
    }
  }
}

const selectDestination = (result: DriveDestination) => {
  destination.value = result
  addressQuery.value = result.label
  cancelSearch()
}

const clearDestination = () => {
  destination.value = null
  addressQuery.value = ''
  cancelSearch()
}

const leaveDriveChannel = () => {
  webrtcStore.leaveVoiceChannel()
  if (props.phoneLayout) emit('back')
}

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
  for (const [userId, line] of destinationLines) {
    if (!destination.value || !userIds.has(userId)) {
      line.remove()
      destinationLines.delete(userId)
    }
  }
  const coordinates = getDriveMapCoordinates(points, destination.value)
  const bounds = leaflet.latLngBounds(coordinates)
  const target = destination.value ? coordinates[points.length]! : null
  if (target && destination.value) {
    if (!destinationMarker) {
      destinationMarker = leaflet.circleMarker(target, { radius: 11, weight: 3, color: '#fef3c7', fillColor: '#f59e0b', fillOpacity: 1 }).addTo(map)
    }
    destinationMarker.setLatLng(target)
    const label = document.createElement('span')
    label.textContent = `Destination: ${destination.value.label}`
    if (destinationMarker.getTooltip()) destinationMarker.setTooltipContent(label)
    else destinationMarker.bindTooltip(label, { permanent: true, direction: 'bottom', offset: [0, 12] })
  } else {
    destinationMarker?.remove()
    destinationMarker = null
  }
  for (const [index, point] of points.entries()) {
    const latLng = coordinates[index]!
    const user = participants.value.find((participant) => participant.id === point.user_id)
    const isSelf = point.user_id === chatStore.currentUser?.id
    const color = webrtcStore.isUserSpeaking(point.user_id) ? '#22c55e' : isSelf ? '#818cf8' : '#38bdf8'
    if (target) {
      let line = destinationLines.get(point.user_id)
      if (!line) {
        line = leaflet.polyline([latLng, target], { weight: 2, opacity: 0.8, dashArray: '6 8', interactive: false }).addTo(map)
        destinationLines.set(point.user_id, line)
      }
      line.setLatLngs([latLng, target]).setStyle({ color }).bringToBack()
    }
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
    paddingTopLeft: [Math.min(55, size.x / 4), Math.min((navigationElement.value?.offsetHeight ?? 0) + 30, size.y * 0.6)],
    paddingBottomRight: [Math.min(55, size.x / 4), Math.min(65, size.y / 4)], maxZoom: 16, animate: false
  })
  else map.setView([20, 0], 2, { animate: false })
}

watch([visibleLocations, destination, participants, () => [...webrtcStore.speakingUserIds]], syncMap, { deep: true })
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
    if (navigationElement.value) resizeObserver.observe(navigationElement.value)
    syncMap()
  } catch {
    mapError.value = 'The map could not be loaded. Voice and location sharing are still available.'
  }
})
onBeforeUnmount(() => {
  disposed = true
  cancelSearch()
  resizeObserver?.disconnect()
  map?.remove()
  map = null
  markers.clear()
  destinationLines.clear()
  destinationMarker = null
})
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-950" :class="{ 'phone-drive-panel': phoneLayout }">
    <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/5 px-4 py-3 md:px-6">
      <div class="flex min-w-0 items-center gap-3" :class="phoneLayout ? 'min-h-11 w-full pl-12' : ''">
        <Car class="h-6 w-6 shrink-0 text-indigo-400" />
        <div class="min-w-0">
          <h2 class="truncate font-bold text-white">{{ channelName }}</h2>
          <p class="text-xs text-zinc-400">Drive Together - {{ visibleLocations.length }} live locations</p>
        </div>
      </div>
      <div v-if="isJoined" class="flex items-center gap-2" :class="phoneLayout ? 'w-full' : ''">
        <button class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold transition-colors hover:bg-zinc-800" :class="[driveStore.isSharing ? 'text-indigo-300' : 'text-zinc-300', phoneLayout ? 'min-h-11 min-w-0 flex-1' : '']" :aria-label="driveStore.isSharing ? 'Stop sharing GPS' : 'Share GPS'" :aria-pressed="driveStore.isSharing" @click="driveStore.isSharing ? driveStore.stopSharing() : driveStore.startSharing()">
          <LocateFixed class="mr-1 inline h-4 w-4" />{{ driveStore.isSharing ? (phoneLayout ? 'GPS on' : 'Stop sharing GPS') : 'Share GPS' }}
        </button>
        <button class="inline-flex items-center justify-center rounded-lg p-2 hover:bg-zinc-800" :class="[webrtcStore.isMuted || webrtcStore.isDeafened ? 'text-red-400' : 'text-zinc-300', phoneLayout ? 'h-11 w-11 shrink-0' : '']" :aria-label="webrtcStore.isMuted || webrtcStore.isDeafened ? 'Unmute microphone' : 'Mute microphone'" @click="webrtcStore.toggleMute()">
          <MicOff v-if="webrtcStore.isMuted || webrtcStore.isDeafened" class="h-5 w-5" /><Mic v-else class="h-5 w-5" />
        </button>
        <button v-if="phoneLayout" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg p-2 hover:bg-zinc-800" :class="webrtcStore.isDeafened ? 'text-red-400' : 'text-zinc-300'" :aria-label="webrtcStore.isDeafened ? 'Undeafen' : 'Deafen'" @click="webrtcStore.toggleDeafen()"><Headphones class="h-5 w-5" /></button>
        <button class="inline-flex items-center justify-center rounded-lg p-2 text-red-400 hover:bg-red-500/10" :class="phoneLayout ? 'h-11 w-11 shrink-0' : ''" aria-label="Leave Drive Together" @click="leaveDriveChannel"><PhoneOff class="h-5 w-5" /></button>
      </div>
      <button v-else class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500" @click="webrtcStore.joinVoiceChannel(channelId)">Join Drive Together</button>
    </header>
    <p v-if="driveStore.locationError && isJoined" class="drive-location-error shrink-0 bg-amber-950/30 px-4 py-3 text-sm text-amber-200" role="alert">{{ driveStore.locationError }}</p>
    <div class="drive-map-area relative min-h-[16rem] flex-1 isolate">
      <div ref="mapElement" class="drive-map absolute inset-0 z-0" aria-label="Dark OpenStreetMap showing participant GPS locations" />
      <div ref="navigationElement" class="drive-navigation absolute left-14 right-3 top-3 z-20 max-h-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/95 p-3 shadow-xl backdrop-blur md:right-auto md:w-80" @pointerdown.stop @dblclick.stop @wheel.stop>
        <form class="flex items-center gap-2" @submit.prevent="searchAddress">
          <label for="drive-destination-address" class="sr-only">Destination address</label>
          <input id="drive-destination-address" v-model="addressQuery" type="search" maxlength="250" placeholder="Destination address" autocomplete="off" class="min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-white outline-none placeholder:text-zinc-500 focus:border-indigo-400" :class="phoneLayout ? 'min-h-11 text-base' : 'text-xs'" />
          <button type="submit" class="inline-flex shrink-0 items-center justify-center rounded-lg bg-indigo-600 p-2 text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50" :class="phoneLayout ? 'h-11 w-11' : ''" :disabled="isSearching || addressQuery.trim().length < 2" :aria-label="isSearching ? 'Searching for address' : 'Search address'"><Search class="h-4 w-4" :class="isSearching ? 'animate-pulse' : ''" /></button>
        </form>
        <p v-if="searchError" class="mt-2 text-xs text-amber-300" role="alert">{{ searchError }}</p>
        <ul v-if="searchResults.length" class="mt-2 max-h-40 space-y-1 overflow-y-auto" aria-label="Matching destination addresses">
          <li v-for="(result, index) in searchResults" :key="index"><button type="button" class="w-full rounded-lg px-2 py-2 text-left text-xs leading-relaxed text-zinc-300 hover:bg-zinc-800 hover:text-white" @click="selectDestination(result)">{{ result.label }}</button></li>
        </ul>
        <div v-if="destination" class="mt-3 flex items-start gap-2 border-t border-white/10 pt-2">
          <Flag class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p class="min-w-0 flex-1 text-xs leading-relaxed text-zinc-200">{{ destination.label }}</p>
          <button type="button" class="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white" aria-label="Clear destination" @click="clearDestination"><X class="h-3.5 w-3.5" /></button>
        </div>
        <p class="mt-2 text-[10px] leading-relaxed text-zinc-500">Straight lines, not road routes. Submitted addresses go to <a href="https://photon.komoot.io" target="_blank" rel="noopener noreferrer" class="text-indigo-300 hover:underline">Photon</a> (OpenStreetMap).</p>
      </div>
      <div v-if="(!visibleLocations.length && !destination) || mapError" class="pointer-events-none absolute inset-x-4 bottom-4 z-10 mx-auto max-w-md rounded-xl border border-white/10 bg-zinc-950/90 p-4 text-center shadow-xl backdrop-blur">
        <MapPin class="mx-auto mb-2 h-6 w-6 text-indigo-400" />
        <p class="text-sm font-medium text-white">{{ mapError || (isJoined ? 'Waiting for shared GPS locations' : 'Join to see and share live locations') }}</p>
        <p class="mt-1 text-xs text-zinc-400">Voice works even if you do not share your location. The map always fits all known positions.</p>
      </div>
    </div>
    <footer class="drive-footer shrink-0 border-t border-white/5 px-4 py-3">
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
.phone-drive-panel {
  overflow: hidden;
}
.phone-drive-panel .drive-map-area {
  min-height: 0;
}
.phone-drive-panel .drive-location-error {
  max-height: 5rem;
  overflow-y: auto;
}
.phone-drive-panel .drive-footer {
  max-height: 28vh;
  max-height: 28dvh;
  overflow-y: auto;
}
.phone-drive-panel .drive-footer > div {
  max-height: 4.5rem;
}
.phone-drive-panel .drive-navigation {
  max-height: max(0px, calc(60% - 30px));
}
@media (max-height: 500px) {
  .phone-drive-panel .drive-footer {
    max-height: 22vh;
    max-height: 22dvh;
  }
}
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
.drive-map :deep(.leaflet-tooltip-bottom::before) {
  border-bottom-color: #27272a;
}
.drive-map :deep(.leaflet-tooltip) {
  width: max-content;
  max-width: min(280px, 60vw);
  white-space: normal;
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
