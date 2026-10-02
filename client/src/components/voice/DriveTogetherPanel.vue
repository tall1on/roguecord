<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Car, Flag, Headphones, LocateFixed, MapPin, Mic, MicOff, Navigation, PhoneOff, Search, X } from 'lucide-vue-next'
import type { CircleMarker, Map as LeafletMap, Marker as LeafletMarker, Polyline } from 'leaflet'
import { useChatStore } from '../../stores/chat'
import { useWebRtcStore } from '../../stores/webrtc'
import { useDriveStore } from '../../stores/drive'
import { useDriveRoutes } from '../../composables/useDriveRoutes'
import { getDriveMapCoordinates, rankDriveParticipants, searchDriveDestinations, setDriveDestination, type DriveDestination } from '../../utils/driveNavigation'

const props = withDefaults(defineProps<{ channelId: string; channelName: string; phoneLayout?: boolean }>(), { phoneLayout: false })
const emit = defineEmits<{ (e: 'back'): void }>()
const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()
const driveStore = useDriveStore()
const mapElement = ref<HTMLElement | null>(null)
const mapError = ref<string | null>(null)
const navigationElement = ref<HTMLElement | null>(null)
const destinationKey = computed(() => `${chatStore.activeConnectionId}:${props.channelId}`)
const destination = computed<DriveDestination | null>(() => driveStore.destinations.get(destinationKey.value) ?? null)
const addressQuery = ref(destination.value?.label ?? '')
const searchResults = ref<DriveDestination[]>([])
const searchError = ref<string | null>(null)
const isSearching = ref(false)
const isSettingDestination = ref(false)
let destinationController: AbortController | null = null
let searchController: AbortController | null = null
let lastSearchAt = 0
const isJoined = computed(() => driveStore.joinedChannelId === props.channelId)
const participants = computed(() => webrtcStore.channelParticipants.get(props.channelId) || [])
const visibleLocations = computed(() => isJoined.value ? [...driveStore.locations.values()] : [])
const selfLocation = computed(() => {
  const userId = chatStore.currentUser?.id
  return userId ? visibleLocations.value.find((point) => point.user_id === userId) ?? null : null
})
const navMode = ref(false)
const canUseNav = computed(() => isJoined.value && driveStore.isSharing && !!selfLocation.value)
watch(canUseNav, (value) => { if (!value) navMode.value = false })
const rankedParticipants = computed(() => rankDriveParticipants(participants.value,
  isJoined.value ? driveStore.locations : new Map(), destination.value))
const podiumClasses = [
  'border-amber-400/50 bg-amber-400/10 text-amber-200',
  'border-slate-300/50 bg-slate-300/10 text-slate-200',
  'border-orange-400/50 bg-orange-700/15 text-orange-300'
]
const { routes, routeErrors, isRouting } = useDriveRoutes(chatStore, () => props.channelId,
  () => visibleLocations.value, () => destination.value, () => isJoined.value)
const renderedStreets = computed(() => {
  const entries = [...routes.value]
  const positions = entries.flatMap(([, route]) => route.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })))
  const coordinates = getDriveMapCoordinates([], destination.value, positions)
  const paths = new Map<string, [number, number][]>()
  let offset = destination.value ? 1 : 0
  for (const [userId, route] of entries) {
    paths.set(userId, coordinates.slice(offset, offset + route.coordinates.length))
    offset += route.coordinates.length
  }
  let minLatitude = Infinity, maxLatitude = -Infinity, minLongitude = Infinity, maxLongitude = -Infinity
  for (const [latitude, longitude] of coordinates) {
    minLatitude = Math.min(minLatitude, latitude)
    maxLatitude = Math.max(maxLatitude, latitude)
    minLongitude = Math.min(minLongitude, longitude)
    maxLongitude = Math.max(maxLongitude, longitude)
  }
  const bounds: [number, number][] = coordinates.length ? [
    [minLatitude, minLongitude], [minLatitude, maxLongitude], [maxLatitude, minLongitude], [maxLatitude, maxLongitude]
  ] : []
  return { target: coordinates[0], paths, bounds, centerLongitude: coordinates.length ? (minLongitude + maxLongitude) / 2 : 0 }
})
const renderedMap = computed(() => {
  const streets = renderedStreets.value
  const points = visibleLocations.value
  if (!destination.value || !streets.paths.size) return { coordinates: getDriveMapCoordinates(points, destination.value), paths: streets.paths }
  // Road geometry stays cached between route updates; GPS-only updates fit just markers and road bounds.
  const coordinates = points.map<[number, number]>((point) => [point.latitude,
    streets.centerLongitude + ((point.longitude - streets.centerLongitude) % 360 + 540) % 360 - 180])
  coordinates.push(streets.target!, ...streets.bounds)
  return { coordinates, paths: streets.paths }
})
const routingErrors = computed(() => [...routeErrors.value].map(([userId, error]) => ({
  userId, error, username: participants.value.find((participant) => participant.id === userId)?.username || 'Driver'
})))
let leaflet: typeof import('leaflet') | null = null
let map: LeafletMap | null = null
let resizeObserver: ResizeObserver | null = null
let disposed = false
const markers = new Map<string, CircleMarker>()
const destinationLines = new Map<string, Polyline>()
const linePositions = new Map<string, [number, number][]>()
let lastMapCoordinates: [number, number][] | null = null
let destinationMarker: CircleMarker | null = null
const NAV_ZOOM = 17
let directionArrow: LeafletMarker | null = null
let directionArrowHeading: number | null = null
const clearDirectionArrow = () => { directionArrow?.remove(); directionArrow = null; directionArrowHeading = null }
const headingCenter = (point: { latitude: number; longitude: number }, heading: number, size: { x: number; y: number }): [number, number] => {
  const latitude = point.latitude
  const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / 2 ** NAV_ZOOM
  const offsetMeters = Math.min(size.x, size.y) * 0.28 * metersPerPixel
  const radians = heading * Math.PI / 180
  const latitudeOffset = (Math.cos(radians) * offsetMeters) / 111320
  const longitudeOffset = (Math.sin(radians) * offsetMeters) / (111320 * Math.max(0.01, Math.cos(latitude * Math.PI / 180)))
  return [latitude + latitudeOffset, point.longitude + longitudeOffset]
}
const updateDirectionArrow = (point: { latitude: number; longitude: number }) => {
  if (!map || !leaflet) return
  const heading = driveStore.selfHeading
  if (heading === null) { clearDirectionArrow(); return }
  const latLng: [number, number] = [point.latitude, point.longitude]
  if (directionArrow) directionArrow.setLatLng(latLng)
  if (directionArrow && directionArrowHeading === heading) return
  const html = `<span style="display:block;width:100%;height:100%;transform:rotate(${heading}deg);transform-origin:50% 50%"><svg viewBox="0 0 24 24" width="100%" height="100%" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.65))"><path d="M12 2 L20.5 21 L12 16.5 L3.5 21 Z" fill="#818cf8" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg></span>`
  const icon = leaflet.divIcon({ className: 'drive-direction-icon', html, iconSize: [30, 30], iconAnchor: [15, 15] })
  directionArrowHeading = heading
  if (directionArrow) directionArrow.setIcon(icon)
  else directionArrow = leaflet.marker(latLng, { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map)
}

const cancelSearch = () => {
  searchController?.abort()
  searchController = null
  isSearching.value = false
  searchResults.value = []
  searchError.value = null
}
watch(addressQuery, cancelSearch, { flush: 'sync' })
watch(destination, () => {
  cancelSearch()
  addressQuery.value = destination.value?.label ?? ''
}, { flush: 'sync' })
const cancelDestinationChange = () => {
  destinationController?.abort()
  destinationController = null
  isSettingDestination.value = false
}
watch([destinationKey, isJoined], () => {
  cancelDestinationChange()
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
  try {
    const results = await searchDriveDestinations(chatStore, props.channelId, addressQuery.value, controller.signal)
    if (disposed || searchController !== controller) return
    searchResults.value = results
    if (!results.length) searchError.value = 'No matching address found. Try adding a city or postcode.'
  } catch (error) {
    if (disposed || searchController !== controller) return
    searchError.value = error instanceof Error ? error.message : 'Address search failed. Please try again.'
  } finally {
    if (searchController === controller) {
      searchController = null
      isSearching.value = false
    }
  }
}

const changeDestination = async (result: DriveDestination | null) => {
  if (!isJoined.value || isSettingDestination.value) return
  const controller = new AbortController()
  destinationController = controller
  isSettingDestination.value = true
  searchError.value = null
  try {
    await setDriveDestination(chatStore, props.channelId, result, controller.signal)
    if (disposed || destinationController !== controller) return
    cancelSearch()
    addressQuery.value = destination.value?.label ?? ''
  } catch (error) {
    if (!disposed && destinationController === controller) searchError.value = error instanceof Error ? error.message : 'Could not change the room destination.'
  } finally {
    if (destinationController === controller) {
      destinationController = null
      isSettingDestination.value = false
    }
  }
}

const leaveDriveChannel = () => {
  webrtcStore.leaveVoiceChannel()
  if (props.phoneLayout) emit('back')
}

const syncMap = (forceFit = false) => {
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
    if (!destination.value || !userIds.has(userId) || !renderedMap.value.paths.has(userId)) {
      line.remove()
      destinationLines.delete(userId)
      linePositions.delete(userId)
    }
  }
  const { coordinates, paths } = renderedMap.value
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
    const roadCoordinates = paths.get(point.user_id)
    if (target && roadCoordinates) {
      let line = destinationLines.get(point.user_id)
      if (!line) {
        line = leaflet.polyline(roadCoordinates, { weight: 4, opacity: 0.85, interactive: false }).addTo(map)
        destinationLines.set(point.user_id, line)
      }
      if (linePositions.get(point.user_id) !== roadCoordinates) {
        line.setLatLngs(roadCoordinates)
        linePositions.set(point.user_id, roadCoordinates)
      }
      line.setStyle({ color }).bringToBack()
    }
    let marker = markers.get(point.user_id)
    if (!marker) {
      marker = leaflet.circleMarker(latLng, { radius: 9, weight: 3, color: '#ffffff', fillOpacity: 1 }).addTo(map)
      markers.set(point.user_id, marker)
    }
    marker.setLatLng(latLng).setStyle({ fillColor: color })
    const label = document.createElement('span')
    const route = routes.value.get(point.user_id)
    const routeSummary = route ? ` - ${(route.distance_m / 1000).toFixed(1)} km, ${Math.ceil(route.duration_s / 60)} min to destination` : ''
    label.textContent = `${user?.username || 'Participant'}${isSelf ? ' (you)' : ''} - accuracy ${Math.round(point.accuracy)} m${routeSummary}`
    if (marker.getTooltip()) marker.setTooltipContent(label)
    else marker.bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -10] })
  }
  if (navMode.value) {
    const selfPoint = points.find((point) => point.user_id === chatStore.currentUser?.id)
    if (selfPoint) {
      updateDirectionArrow(selfPoint)
      const size = map.getSize()
      if (size.x <= 0 || size.y <= 0) return
      const heading = driveStore.selfHeading
      map.setView(heading === null ? [selfPoint.latitude, selfPoint.longitude] : headingCenter(selfPoint, heading, size), NAV_ZOOM, { animate: false })
      lastMapCoordinates = null
      return
    }
  }
  clearDirectionArrow()
  if (!forceFit && coordinates === lastMapCoordinates) return
  const size = map.getSize()
  if (size.x <= 0 || size.y <= 0) return
  const bounds = leaflet.latLngBounds(coordinates)
  if (bounds.isValid()) map.fitBounds(bounds, {
    paddingTopLeft: [Math.min(55, size.x / 4), Math.min((navigationElement.value?.offsetHeight ?? 0) + 30, size.y * 0.6)],
    paddingBottomRight: [Math.min(55, size.x / 4), Math.min(65, size.y / 4)], maxZoom: 16, animate: false
  })
  else map.setView([20, 0], 2, { animate: false })
  lastMapCoordinates = coordinates
}

watch([visibleLocations, destination, routes, participants, () => [...webrtcStore.speakingUserIds], navMode], () => syncMap(), { deep: true })
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
      syncMap(true)
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
  cancelDestinationChange()
  resizeObserver?.disconnect()
  clearDirectionArrow()
  map?.remove()
  map = null
  markers.clear()
  destinationLines.clear()
  linePositions.clear()
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
        <button type="button" class="inline-flex items-center justify-center rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40" :class="[navMode ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'text-zinc-300 hover:bg-zinc-800', phoneLayout ? 'h-11 w-11 shrink-0' : '']" :disabled="!canUseNav" :aria-pressed="navMode" :aria-label="canUseNav ? (navMode ? 'Exit navigation close-up' : 'Start navigation close-up of your position') : 'Navigation close-up needs active GPS sharing'" :title="canUseNav ? (navMode ? 'Exit navigation close-up' : 'Navigation close-up of your position') : 'Share your GPS to use navigation close-up'" @click="navMode = !navMode"><Navigation class="h-5 w-5" /></button>
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
          <li v-for="(result, index) in searchResults" :key="index"><button type="button" class="w-full rounded-lg px-2 py-2 text-left text-xs leading-relaxed text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="!isJoined || isSettingDestination" :title="!isJoined ? 'Join to set the room destination' : 'Set destination for everyone in the room'" @click="changeDestination(result)">{{ result.label }}</button></li>
        </ul>
        <div v-if="destination" class="mt-3 flex items-start gap-2 border-t border-white/10 pt-2">
          <Flag class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p class="min-w-0 flex-1 text-xs leading-relaxed text-zinc-200">{{ destination.label }}</p>
          <button type="button" class="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-50" :disabled="!isJoined || isSettingDestination" aria-label="Clear destination" title="Clear the destination for everyone in the room" @click="changeDestination(null)"><X class="h-3.5 w-3.5" /></button>
        </div>
        <p v-if="isSettingDestination" class="mt-2 text-[11px] text-indigo-300" role="status">Updating room destination...</p>
        <p v-else-if="destination" class="mt-2 text-[10px] text-zinc-500">Shared with everyone in this room.</p>
        <p v-if="destination && isJoined" class="mt-2 text-[11px] text-zinc-400" role="status">{{ routes.size }}/{{ visibleLocations.length }} street routes<span v-if="isRouting">, updating...</span></p>
        <div v-if="routingErrors.length" class="mt-2 max-h-24 space-y-1 overflow-y-auto" role="alert"><p v-for="entry in routingErrors" :key="entry.userId" class="text-xs text-amber-300">{{ entry.username }}: {{ entry.error }}</p></div>
      </div>
      <div v-if="(!visibleLocations.length && !destination) || mapError" class="pointer-events-none absolute inset-x-4 bottom-4 z-10 mx-auto max-w-md rounded-xl border border-white/10 bg-zinc-950/90 p-4 text-center shadow-xl backdrop-blur">
        <MapPin class="mx-auto mb-2 h-6 w-6 text-indigo-400" />
        <p class="text-sm font-medium text-white">{{ mapError || (isJoined ? 'Waiting for shared GPS locations' : 'Join to see and share live locations') }}</p>
        <p class="mt-1 text-xs text-zinc-400">Voice works even if you do not share your location. The map always fits all known positions.</p>
      </div>
    </div>
    <footer class="drive-footer shrink-0 border-t border-white/5 px-4 py-3">
      <div class="mb-2 flex max-h-24 flex-wrap gap-2 overflow-y-auto">
        <span v-for="entry in rankedParticipants" :key="entry.participant.id" class="driver-chip flex items-center gap-2 rounded-full border px-3 py-1 text-xs" :data-rank="entry.rank ?? undefined" :class="[entry.rank !== null && entry.rank <= 3 ? podiumClasses[entry.rank - 1] : webrtcStore.isUserSpeaking(entry.participant.id) ? 'border-green-500/50 text-green-300' : 'border-white/10 text-zinc-300', webrtcStore.isUserSpeaking(entry.participant.id) && entry.rank !== null && entry.rank <= 3 ? 'ring-1 ring-green-500/60' : '']" :title="entry.distance_m !== null ? `${Math.round(entry.distance_m)} m GPS distance to the shared destination` : undefined">
          <span v-if="entry.rank !== null" class="min-w-4 font-bold tabular-nums">{{ entry.rank }}.</span>
          <MicOff v-if="entry.participant.isMuted || entry.participant.isDeafened" class="h-3 w-3 text-red-400" />
          {{ entry.participant.username }}
          <MapPin v-if="isJoined && driveStore.locations.has(entry.participant.id)" class="h-3 w-3 text-indigo-400" />
          <span v-if="driveStore.getSpeedLabel(entry.participant.id, channelId)" class="tabular-nums text-indigo-300" title="Current GPS speed (approximate)">{{ driveStore.getSpeedLabel(entry.participant.id, channelId) }}</span>
        </span>
      </div>
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
.drive-map :deep(.drive-direction-icon) {
  background: transparent;
  border: 0;
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
