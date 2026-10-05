<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { ArrowLeft, Camera, CameraOff, Car, Check, Crosshair, Flag, Headphones, LocateFixed, MapPin, Mic, MicOff, Navigation, PhoneOff, Route, RotateCw, Search, Trophy, X } from 'lucide-vue-next'
import type { CircleMarker, LatLngBounds, Map as LeafletMap, Marker as LeafletMarker, Polyline } from 'leaflet'
import { useChatStore } from '../../stores/chat'
import { useWebRtcStore } from '../../stores/webrtc'
import { useDriveStore } from '../../stores/drive'
import { useDriveTracksStore } from '../../stores/driveTracks'
import { useDriveRoutes } from '../../composables/useDriveRoutes'
import { usePhoneLayout } from '../../composables/usePhoneLayout'
import { useTrackRecording } from '../../composables/useTrackRecording'
import { useTrackRecordingUploadsStore } from '../../stores/trackRecordingUploads'
import { DRIVE_SELF_COLOR, getDriveMapCoordinates, getDriveRoute, getRouteHeading, pickDriveColor, rankDriveParticipants, searchDriveDestinations, setDriveDestination, type DriveDestination } from '../../utils/driveNavigation'
import { distanceToGate, getTrackHeading, type DriveTrack, type DriveTrackGate } from '../../utils/driveTracks'

const DriveCameraStage = defineAsyncComponent(() => import('./DriveCameraStage.vue'))
const TrackEditor = defineAsyncComponent(() => import('../drive/TrackEditor.vue'))
const DriveTracksContent = defineAsyncComponent(() => import('../drive/DriveTracksContent.vue'))
const DriveLeaderboardStage = defineAsyncComponent(() => import('../drive/DriveLeaderboardStage.vue'))
const props = withDefaults(defineProps<{ channelId: string; channelName: string; phoneLayout?: boolean }>(), { phoneLayout: false })
const emit = defineEmits<{ (e: 'back'): void }>()
const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()
const driveStore = useDriveStore()
const isPhoneResponsive = usePhoneLayout()
const isPhoneLayout = computed(() => props.phoneLayout || isPhoneResponsive.value)
const cameraPhoneLayout = isPhoneLayout
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
const driveTracksStore = useDriveTracksStore()
const trackRecordingUploads = useTrackRecordingUploadsStore()
const tracksPanelOpen = ref(false)
const trackEditorOpen = ref(false)
const editingTrack = ref<DriveTrack | null>(null)
const activeTrack = computed<DriveTrack | null>(() => driveTracksStore.activeTrack(props.channelId))
const activeRun = computed(() => driveTracksStore.activeRun(props.channelId))
const trackGates = computed<DriveTrackGate[]>(() => activeTrack.value ? driveTracksStore.gatesFor(activeTrack.value) : [])
const trackMode = computed(() => isJoined.value && !!activeTrack.value)
const trackElapsedMs = ref(0)
const trackStarted = computed(() => !!activeRun.value && activeRun.value.gate_times.length > 0)
const trackElapsed = () => {
  const run = activeRun.value
  if (!run || run.gate_times.length === 0) return 0
  return Math.max(0, (run.finished_at ?? Date.now()) - run.gate_times[0]!)
}
let trackClockTimer: ReturnType<typeof setInterval> | null = null
watch(trackMode, (on) => {
  if (on) {
    trackElapsedMs.value = trackElapsed()
    trackClockTimer ??= setInterval(() => { trackElapsedMs.value = trackElapsed() }, 1000)
  } else if (trackClockTimer) {
    clearInterval(trackClockTimer)
    trackClockTimer = null
    trackElapsedMs.value = 0
  }
}, { immediate: true })
const formatDuration = (ms: number): string => {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`
}
const trackNextGate = computed(() => {
  const run = activeRun.value
  if (!run || run.status !== 'active') return null
  return trackGates.value[run.next_gate] ?? null
})
const trackNextGateDistance = computed(() => {
  const point = selfLocation.value
  const gate = trackNextGate.value
  return point && gate ? distanceToGate(point, gate) : null
})
// Before the start gate is passed, route to it like a normal destination; afterwards follow the track.
const navigationPersonal = computed(() => trackMode.value && !trackStarted.value && trackGates.value.length > 0)
const navigationTarget = computed<DriveDestination | null>(() => {
  if (!trackMode.value) return destination.value
  if (navigationPersonal.value) {
    const start = trackGates.value[0]!
    return { latitude: start.latitude, longitude: start.longitude, label: 'Track start' }
  }
  return null
})
const toggleTracksPanel = () => {
  tracksPanelOpen.value = !tracksPanelOpen.value
  if (tracksPanelOpen.value) { navPanelOpen.value = false; leaderboardPanelOpen.value = false; void driveTracksStore.load() }
}
const closeTracksPanel = () => { tracksPanelOpen.value = false }
const toggleNavPanel = () => {
  navPanelOpen.value = !navPanelOpen.value
  if (navPanelOpen.value) { tracksPanelOpen.value = false; leaderboardPanelOpen.value = false }
}
const openTrackEditor = (track: DriveTrack | null) => { editingTrack.value = track; trackEditorOpen.value = true }
const handleTrackSaved = () => { trackEditorOpen.value = false; editingTrack.value = null }
const toggleCameraShare = () => webrtcStore.cameraProducer ? webrtcStore.stopCameraShare() : webrtcStore.startCameraShare()
const rotateCamera = () => { webrtcStore.rotateCamera() }
const confirmCameraRotation = () => { void webrtcStore.confirmCameraRotation() }
const cancelCameraRotation = () => { webrtcStore.cancelCameraRotation() }
// The preview plays the rotated canvas output, which is exactly what gets published and recorded.
const setCameraPreviewVideo = (element: Element | ComponentPublicInstance | null) => {
  if (!(element instanceof HTMLVideoElement)) return
  const stream = webrtcStore.cameraSharePreviewStream
  if (element.srcObject !== stream) element.srcObject = stream
  if (stream) void element.play().catch(() => {})
}
const trackRecording = useTrackRecording({
  getChannelId: () => props.channelId,
  isJoined: () => isJoined.value,
  getCameraStream: () => {
    const userId = chatStore.currentUser?.id
    return userId ? webrtcStore.userCameraStreams.get(userId) ?? null : null
  },
  send: (type, payload) => chatStore.send(type, payload),
  addMessageListener: (listener) => chatStore.addMessageListener(listener),
  removeMessageListener: (listener) => chatStore.removeMessageListener(listener),
  storeRecording: (input) => trackRecordingUploads.enqueue(input)
})
const showRecordingBadge = computed(() => trackRecording.isRecording.value || trackRecording.isUploading.value)
const recordingUploading = computed(() => trackRecording.isUploading.value)
const recordingError = computed(() => trackRecording.error.value)
const cameraView = ref<'map' | 'split' | 'cameras' | 'leaderboard'>('map')
const desktopViews = [
  { value: 'map', label: 'Map', ariaLabel: 'Show map only' },
  { value: 'split', label: 'Map + cameras', ariaLabel: 'Show map and cameras side by side' },
  { value: 'cameras', label: 'Cameras', ariaLabel: 'Show cameras only' },
  { value: 'leaderboard', label: 'Leaderboard', ariaLabel: 'Show the track leaderboard' }
] as const
const workspaceElement = ref<HTMLElement | null>(null)
const splitRatio = ref(0.5)
const splitDragging = ref(false)
const SPLIT_MIN = 0.15
const SPLIT_MAX = 0.85
const SPLIT_HANDLE_WIDTH = 12
const clampSplitRatio = (value: number): number => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))
const splitGridStyle = computed(() => {
  if (cameraPhoneLayout.value || cameraView.value !== 'split') return undefined
  return { gridTemplateColumns: `${splitRatio.value}fr ${SPLIT_HANDLE_WIDTH}px ${1 - splitRatio.value}fr` }
})
const updateSplitFromClientX = (clientX: number) => {
  const element = workspaceElement.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const padding = 8
  const usable = rect.width - padding * 2 - SPLIT_HANDLE_WIDTH
  if (usable <= 0) return
  splitRatio.value = clampSplitRatio((clientX - rect.left - padding - SPLIT_HANDLE_WIDTH / 2) / usable)
}
const onSplitPointerMove = (event: PointerEvent) => {
  if (!splitDragging.value) return
  updateSplitFromClientX(event.clientX)
}
const stopSplitDrag = () => {
  if (!splitDragging.value) return
  splitDragging.value = false
  window.removeEventListener('pointermove', onSplitPointerMove)
  window.removeEventListener('pointerup', stopSplitDrag)
  window.removeEventListener('pointercancel', stopSplitDrag)
  document.body.classList.remove('drive-split-resizing')
}
const startSplitDrag = (event: PointerEvent) => {
  if (event.button !== 0) return
  splitDragging.value = true
  updateSplitFromClientX(event.clientX)
  window.addEventListener('pointermove', onSplitPointerMove)
  window.addEventListener('pointerup', stopSplitDrag)
  window.addEventListener('pointercancel', stopSplitDrag)
  document.body.classList.add('drive-split-resizing')
  event.preventDefault()
}
const resetSplit = () => { splitRatio.value = 0.5 }
const onSplitKeydown = (event: KeyboardEvent) => {
  if (event.key === 'ArrowLeft') splitRatio.value = clampSplitRatio(splitRatio.value - 0.05)
  else if (event.key === 'ArrowRight') splitRatio.value = clampSplitRatio(splitRatio.value + 0.05)
  else if (event.key === 'Home') splitRatio.value = SPLIT_MIN
  else if (event.key === 'End') splitRatio.value = SPLIT_MAX
  else return
  event.preventDefault()
}
watch(cameraView, () => stopSplitDrag())
const leaderboardPanelOpen = ref(false)
const toggleLeaderboardPanel = () => {
  leaderboardPanelOpen.value = !leaderboardPanelOpen.value
  if (leaderboardPanelOpen.value) { navPanelOpen.value = false; tracksPanelOpen.value = false; void driveTracksStore.load() }
}
const selfLocation = computed(() => {
  const userId = chatStore.currentUser?.id
  return userId ? visibleLocations.value.find((point) => point.user_id === userId) ?? null : null
})
const navMode = ref(false)
const navPanelOpen = ref(false)
const canUseNav = computed(() => isJoined.value && driveStore.isSharing && !!selfLocation.value)
watch(canUseNav, (value) => { if (!value) navMode.value = false })
const followUserId = ref<string | null>(null)
const isFollowingUser = (userId: string): boolean => followUserId.value === userId
const toggleFollowUser = (userId: string) => {
  const next = followUserId.value === userId ? null : userId
  followUserId.value = next
  if (next) navMode.value = false
}
watch([isJoined, () => props.channelId], () => { if (!isJoined.value) followUserId.value = null })
watch(participants, (list) => {
  if (followUserId.value && !list.some((participant) => participant.id === followUserId.value)) followUserId.value = null
})
const driverColors = new Map<string, string>()
const driverColor = (userId: string): string => {
  const existing = driverColors.get(userId)
  if (existing) return existing
  const color = pickDriveColor(new Set(driverColors.values()), userId === chatStore.currentUser?.id)
  driverColors.set(userId, color)
  return color
}
const selfColor = (): string => chatStore.currentUser ? driverColor(chatStore.currentUser.id) : DRIVE_SELF_COLOR
// Prefer the driver (car) avatar, then fall back to the RogueCord profile picture, then to the plain colored circle.
const driverAvatarUrlFor = (userId: string): string | null => {
  if (userId === chatStore.currentUser?.id) {
    return chatStore.getLocalDriverAvatar()
      ?? chatStore.currentUser?.driver_avatar_url
      ?? chatStore.currentUser?.avatar_url
      ?? chatStore.getLocalAvatar()
      ?? null
  }
  const participant = participants.value.find((entry) => entry.id === userId)
  return participant?.driver_avatar_url ?? participant?.avatar_url ?? null
}
const rankedParticipants = computed(() => rankDriveParticipants(participants.value,
  isJoined.value ? driveStore.locations : new Map(), destination.value))
const formatDistance = (meters: number): string => meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`
const podiumClasses = [
  'border-amber-400/50 bg-amber-400/10 text-amber-200',
  'border-slate-300/50 bg-slate-300/10 text-slate-200',
  'border-orange-400/50 bg-orange-700/15 text-orange-300'
]
const { routes, routeErrors, isRouting } = useDriveRoutes(chatStore, () => props.channelId,
  () => visibleLocations.value, () => navigationTarget.value, () => isJoined.value, getDriveRoute, () => navigationPersonal.value)
const renderedStreets = computed(() => {
  const entries = [...routes.value]
  const positions = entries.flatMap(([, route]) => route.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })))
  const coordinates = getDriveMapCoordinates([], navigationTarget.value, positions)
  const paths = new Map<string, [number, number][]>()
  let offset = navigationTarget.value ? 1 : 0
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
  const trackCoordinates = trackMode.value
    ? trackGates.value.map<[number, number]>((gate) => [gate.latitude, gate.longitude])
    : []
  if (!navigationTarget.value || !streets.paths.size) {
    return { coordinates: [...getDriveMapCoordinates(points, navigationTarget.value), ...trackCoordinates], paths: streets.paths }
  }
  // Road geometry stays cached between route updates; GPS-only updates fit just markers and road bounds.
  const coordinates = points.map<[number, number]>((point) => [point.latitude,
    streets.centerLongitude + ((point.longitude - streets.centerLongitude) % 360 + 540) % 360 - 180])
  coordinates.push(streets.target!, ...streets.bounds, ...trackCoordinates)
  return { coordinates, paths: streets.paths }
})
const routingErrors = computed(() => [...routeErrors.value].map(([userId, error]) => ({
  userId, error, username: participants.value.find((participant) => participant.id === userId)?.username || 'Driver'
})))
let leaflet: typeof import('leaflet') | null = null
let map: LeafletMap | null = null
let resizeObserver: ResizeObserver | null = null
let disposed = false
const markers = new Map<string, LeafletMarker>()
const driverMarkerSignatures = new Map<string, string>()
const destinationLines = new Map<string, Polyline>()
const linePositions = new Map<string, [number, number][]>()
let lastFittedBounds: LatLngBounds | null = null
let lastFitSignature = ''
let destinationMarker: CircleMarker | null = null
let trackLine: Polyline | null = null
const trackGateMarkers = new Map<string, LeafletMarker>()
let trackLayerSignature = ''
const buildTrackGateIcon = (gate: DriveTrackGate) => {
  const color = gate.kind === 'start' ? '#22c55e' : gate.kind === 'end' ? '#f59e0b' : '#a78bfa'
  const label = gate.kind === 'start' ? 'S' : gate.kind === 'end' ? 'F' : String(gate.index)
  const html = `<span style="display:flex;width:24px;height:24px;align-items:center;justify-content:center;border-radius:9999px;background:${color};color:#fff;font:700 11px/1 system-ui;border:2px solid #fff;box-shadow:0 1px 3px rgb(0 0 0/.6)">${label}</span>`
  return leaflet!.divIcon({ className: 'drive-track-gate-icon', html, iconSize: [24, 24], iconAnchor: [12, 12] })
}
const clearTrackLayer = () => {
  if (trackLine) { trackLine.remove(); trackLine = null }
  for (const marker of trackGateMarkers.values()) marker.remove()
  trackGateMarkers.clear()
  trackLayerSignature = ''
}
const syncTrackLayer = () => {
  if (!map || !leaflet) return
  const track = trackMode.value ? activeTrack.value : null
  if (!track) { clearTrackLayer(); return }
  const gates = trackGates.value
  const signature = `${track.id}|${gates.map((gate) => `${gate.latitude.toFixed(6)},${gate.longitude.toFixed(6)},${gate.kind}`).join(';')}`
  if (signature === trackLayerSignature) return
  clearTrackLayer()
  trackLayerSignature = signature
  const latLngs = gates.map((gate) => [gate.latitude, gate.longitude] as [number, number])
  if (latLngs.length >= 2) trackLine = leaflet.polyline(latLngs, { color: '#a78bfa', weight: 5, opacity: 0.85, interactive: false }).addTo(map)
  gates.forEach((gate) => {
    trackGateMarkers.set(`${gate.kind}-${gate.index}`, leaflet!.marker([gate.latitude, gate.longitude], { icon: buildTrackGateIcon(gate), interactive: false, keyboard: false }).addTo(map!))
  })
}
const driverAvatarSignature = (avatarUrl: string | null): string => {
  if (!avatarUrl) return ''
  return `${avatarUrl.length}:${avatarUrl.slice(0, 24)}:${avatarUrl.slice(-24)}`
}
const buildDriverIcon = (color: string, avatarUrl: string | null, speaking: boolean) => {
  const iconSize: [number, number] = avatarUrl ? [34, 34] : [18, 18]
  const element = document.createElement('span')
  if (avatarUrl) {
    element.className = `drive-avatar-marker${speaking ? ' drive-marker-speaking' : ''}`
    element.style.borderColor = color
    const image = document.createElement('img')
    image.src = avatarUrl
    image.alt = ''
    image.draggable = false
    element.appendChild(image)
  } else {
    element.className = `drive-dot-marker${speaking ? ' drive-marker-speaking' : ''}`
    element.style.backgroundColor = color
  }
  return leaflet!.divIcon({
    className: 'drive-driver-icon',
    html: element,
    iconSize,
    iconAnchor: [iconSize[0] / 2, iconSize[1] / 2]
  })
}
const NAV_ZOOM = 17
const FOLLOW_ZOOM = 16
const BEARING_EASING = 0.18
const NAV_LOOK_AHEAD_MIN_METERS = 25
const NAV_LOOK_AHEAD_MAX_METERS = 80
let directionArrow: LeafletMarker | null = null
let directionArrowHeading: number | null = null
let directionArrowElement: HTMLElement | null = null
let lastSelfPoint: { latitude: number; longitude: number } | null = null
let targetHeading = 0
let displayedHeading = 0
let bearingFrame: number | null = null
let bearingExitRefit = false
const normalizeHeading = (value: number): number => ((value % 360) + 360) % 360
const headingDelta = (from: number, to: number): number => ((to - from + 540) % 360) - 180
const headingCenter = (point: { latitude: number; longitude: number }, heading: number, size: { x: number; y: number }): [number, number] => {
  const latitude = point.latitude
  const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / 2 ** NAV_ZOOM
  const offsetMeters = Math.min(size.x, size.y) * 0.28 * metersPerPixel
  const radians = heading * Math.PI / 180
  const latitudeOffset = (Math.cos(radians) * offsetMeters) / 111320
  const longitudeOffset = (Math.sin(radians) * offsetMeters) / (111320 * Math.max(0.01, Math.cos(latitude * Math.PI / 180)))
  return [latitude + latitudeOffset, point.longitude + longitudeOffset]
}
// Prefer the street route's next waypoint over the noisy GPS compass so the view turns early and holds steady.
// An active track overrules the destination route so navigation follows the planned line.
const routeHeading = (point: { latitude: number; longitude: number; speed: number | null }): number | null => {
  const speed = typeof point.speed === 'number' && Number.isFinite(point.speed) ? point.speed : null
  const lookAhead = speed === null
    ? NAV_LOOK_AHEAD_MIN_METERS + 10
    : Math.min(NAV_LOOK_AHEAD_MAX_METERS, Math.max(NAV_LOOK_AHEAD_MIN_METERS, NAV_LOOK_AHEAD_MIN_METERS + speed * 2))
  if (trackMode.value && !navigationPersonal.value && activeTrack.value && trackGates.value.length >= 2) {
    const heading = getTrackHeading(point, trackGates.value, lookAhead)
    if (heading !== null) return heading
  }
  const userId = chatStore.currentUser?.id
  const route = userId ? routes.value.get(userId) : undefined
  if (route) {
    const heading = getRouteHeading(point, route.coordinates, lookAhead)
    if (heading !== null) return heading
  }
  return driveStore.selfHeading
}
const rotateDirectionArrow = () => {
  if (!directionArrowElement || directionArrowHeading === null) return
  directionArrowElement.style.transform = `rotate(${normalizeHeading(directionArrowHeading - displayedHeading)}deg)`
}
const clearDirectionArrow = () => { directionArrow?.remove(); directionArrow = null; directionArrowHeading = null; directionArrowElement = null }
const updateDirectionArrow = (point: { latitude: number; longitude: number }, heading: number) => {
  if (!map || !leaflet) return
  const latLng: [number, number] = [point.latitude, point.longitude]
  if (directionArrow) {
    directionArrow.setLatLng(latLng)
    directionArrowHeading = heading
    rotateDirectionArrow()
    return
  }
  const html = `<span style="display:block;width:100%;height:100%;transform-origin:50% 50%"><svg viewBox="0 0 24 24" width="100%" height="100%" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.65))"><path d="M12 2 L20.5 21 L12 16.5 L3.5 21 Z" fill="${selfColor()}" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg></span>`
  const icon = leaflet.divIcon({ className: 'drive-direction-icon', html, iconSize: [30, 30], iconAnchor: [15, 15] })
  directionArrowHeading = heading
  directionArrow = leaflet.marker(latLng, { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map)
  directionArrowElement = directionArrow.getElement()?.firstElementChild as HTMLElement | null
  rotateDirectionArrow()
}
const applyNavView = () => {
  if (!map) return
  map.setBearing(normalizeHeading(-displayedHeading))
  rotateDirectionArrow()
  if (!lastSelfPoint) return
  const size = map.getSize()
  if (size.x <= 0 || size.y <= 0) return
  map.setView(headingCenter(lastSelfPoint, displayedHeading, size), NAV_ZOOM, { animate: false })
}
const stepBearing = () => {
  bearingFrame = null
  if (disposed || !map) return
  const delta = headingDelta(displayedHeading, targetHeading)
  if (Math.abs(delta) < 0.05) {
    if (displayedHeading !== targetHeading) {
      displayedHeading = normalizeHeading(targetHeading)
      applyNavView()
    }
    if (bearingExitRefit) {
      bearingExitRefit = false
      syncMap(true)
    }
    return
  }
  displayedHeading = normalizeHeading(displayedHeading + delta * BEARING_EASING)
  applyNavView()
  bearingFrame = requestAnimationFrame(stepBearing)
}
const startBearingAnimation = () => {
  if (bearingFrame !== null) return
  if (displayedHeading === targetHeading && !bearingExitRefit) return
  bearingFrame = requestAnimationFrame(stepBearing)
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
  syncTrackLayer()
  const points = visibleLocations.value
  const userIds = new Set(points.map((point) => point.user_id))
  for (const [userId, marker] of markers) {
    if (!userIds.has(userId)) {
      marker.remove()
      markers.delete(userId)
      driverMarkerSignatures.delete(userId)
    }
  }
  for (const [userId, line] of destinationLines) {
    if (!navigationTarget.value || !userIds.has(userId) || !renderedMap.value.paths.has(userId)) {
      line.remove()
      destinationLines.delete(userId)
      linePositions.delete(userId)
    }
  }
  const participantIds = new Set(participants.value.map((participant) => participant.id))
  for (const userId of [...driverColors.keys()]) {
    if (!userIds.has(userId) && !participantIds.has(userId)) driverColors.delete(userId)
  }
  const { coordinates, paths } = renderedMap.value
  const target = navigationTarget.value ? coordinates[points.length]! : null
  if (target && !navigationPersonal.value) {
    if (!destinationMarker) {
      destinationMarker = leaflet.circleMarker(target, { radius: 11, weight: 3, color: '#fef3c7', fillColor: '#f59e0b', fillOpacity: 1 }).addTo(map)
    }
    destinationMarker.setLatLng(target)
    const label = document.createElement('span')
    label.textContent = `Destination: ${navigationTarget.value!.label}`
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
    const isSpeaking = webrtcStore.isUserSpeaking(point.user_id)
    const color = driverColor(point.user_id)
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
      line.setStyle({ color, opacity: isSpeaking ? 1 : 0.85 }).bringToBack()
    }
    // In navigation close-up the triangle replaces the driver entirely, so drop any avatar/dot marker.
    if (isSelf && navMode.value) {
      const selfMarker = markers.get(point.user_id)
      if (selfMarker) {
        selfMarker.remove()
        markers.delete(point.user_id)
        driverMarkerSignatures.delete(point.user_id)
      }
      continue
    }
    const avatarUrl = driverAvatarUrlFor(point.user_id)
    const signature = `${color}|${isSpeaking ? 1 : 0}|${driverAvatarSignature(avatarUrl)}`
    let marker = markers.get(point.user_id)
    if (!marker) {
      marker = leaflet.marker(latLng, { icon: buildDriverIcon(color, avatarUrl, isSpeaking), keyboard: false }).addTo(map)
      markers.set(point.user_id, marker)
      driverMarkerSignatures.set(point.user_id, signature)
    } else {
      marker.setLatLng(latLng)
      if (driverMarkerSignatures.get(point.user_id) !== signature) {
        marker.setIcon(buildDriverIcon(color, avatarUrl, isSpeaking))
        driverMarkerSignatures.set(point.user_id, signature)
      }
    }
    const label = document.createElement('span')
    const route = routes.value.get(point.user_id)
    const routeSummary = route ? ` - ${(route.distance_m / 1000).toFixed(1)} km, ${Math.ceil(route.duration_s / 60)} min to destination` : ''
    label.textContent = `${user?.username || 'Participant'}${isSelf ? ' (you)' : ''} - accuracy ${Math.round(point.accuracy)} m${routeSummary}`
    if (marker.getTooltip()) marker.setTooltipContent(label)
    else marker.bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -10] })
  }
  // Following a driver overrides both the navigation close-up and the fit-all overview.
  if (followUserId.value) {
    const followedIndex = points.findIndex((point) => point.user_id === followUserId.value)
    if (followedIndex !== -1) {
      lastSelfPoint = null
      clearDirectionArrow()
      if (displayedHeading !== 0) {
        targetHeading = 0
        bearingExitRefit = true
        startBearingAnimation()
      }
      map.setView(coordinates[followedIndex]!, FOLLOW_ZOOM, { animate: false })
      lastFittedBounds = map.getBounds()
      lastFitSignature = ''
      return
    }
  }
  if (navMode.value) {
    const selfPoint = points.find((point) => point.user_id === chatStore.currentUser?.id)
    if (selfPoint) {
      lastSelfPoint = selfPoint
      const heading = routeHeading(selfPoint)
      if (heading !== null) {
        targetHeading = heading
        updateDirectionArrow(selfPoint, heading)
      } else {
        clearDirectionArrow()
      }
      startBearingAnimation()
      applyNavView()
      lastFittedBounds = null
      return
    }
  }
  lastSelfPoint = null
  clearDirectionArrow()
  if (displayedHeading !== 0) bearingExitRefit = true
  targetHeading = 0
  startBearingAnimation()
  const size = map.getSize()
  if (size.x <= 0 || size.y <= 0) return
  const bounds = leaflet.latLngBounds(coordinates)
  if (!bounds.isValid()) {
    map.setView([20, 0], 2, { animate: false })
    lastFittedBounds = map.getBounds()
    lastFitSignature = ''
    return
  }
  // Refit only when the driver/destination set changes or someone leaves the current view.
  // GPS ticks that keep everyone visible just move the markers, avoiding per-second zoom/tile flashes.
  const fitSignature = `${navigationTarget.value?.label ?? ''}|${navigationPersonal.value ? 'start' : 'shared'}|${activeTrack.value?.id ?? ''}|${points.map((point) => point.user_id).sort().join(',')}`
  const shouldRefit = forceFit || !lastFittedBounds || fitSignature !== lastFitSignature || !lastFittedBounds.contains(bounds)
  if (!shouldRefit) return
  map.fitBounds(bounds, {
    paddingTopLeft: [Math.min(55, size.x / 4), Math.min((navigationElement.value?.offsetHeight ?? 0) + 30, size.y * 0.6)],
    paddingBottomRight: [Math.min(55, size.x / 4), Math.min(65, size.y / 4)], maxZoom: 16, animate: false
  })
  lastFittedBounds = map.getBounds()
  lastFitSignature = fitSignature
}

watch([cameraView, cameraPhoneLayout, isJoined], async ([view, isPhone, joined]) => {
  webrtcStore.setCameraReceivingEnabled(joined && !isPhone && (view === 'split' || view === 'cameras'))
  await nextTick()
  map?.invalidateSize({ animate: false, pan: false })
  syncMap(true)
}, { flush: 'post', immediate: true })

watch([visibleLocations, destination, routes, participants, () => [...webrtcStore.speakingUserIds], navMode, followUserId, activeTrack, trackGates, () => chatStore.getLocalDriverAvatar(), () => chatStore.currentUser?.driver_avatar_url], () => syncMap(), { deep: true })
onMounted(async () => {
  try {
    const [module] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')])
    if (disposed || !mapElement.value) return
    leaflet = module
    // leaflet-rotate patches the Leaflet instance from the global namespace, so expose the ESM build first.
    ;(window as Window & { L?: typeof import('leaflet') }).L = module
    await import('leaflet-rotate')
    if (disposed || !mapElement.value) return
    map = leaflet.map(mapElement.value, {
      zoomControl: true, attributionControl: false, minZoom: -10, zoomSnap: 0,
      rotate: true, bearing: 0, rotateControl: false, touchRotate: false, shiftKeyRotate: false
    }).setView([20, 0], 2)
    leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
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
  stopSplitDrag()
  webrtcStore.setCameraReceivingEnabled(false)
  if (bearingFrame !== null) cancelAnimationFrame(bearingFrame)
  bearingFrame = null
  lastSelfPoint = null
  cancelSearch()
  cancelDestinationChange()
  resizeObserver?.disconnect()
  clearDirectionArrow()
  clearTrackLayer()
  if (trackClockTimer) { clearInterval(trackClockTimer); trackClockTimer = null }
  map?.remove()
  map = null
  markers.clear()
  driverMarkerSignatures.clear()
  destinationLines.clear()
  linePositions.clear()
  driverColors.clear()
  destinationMarker = null
})
</script>

<template>
  <section class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-950" :class="{ 'phone-drive-panel': phoneLayout }">
    <header class="flex shrink-0 items-center gap-3 border-b border-white/5 px-4 py-3 md:px-6" :class="phoneLayout ? 'pl-12' : ''">
      <Car class="h-6 w-6 shrink-0 text-indigo-400" />
      <div class="min-w-0 flex-1">
        <h2 class="truncate font-bold text-white">{{ channelName }}</h2>
        <p class="text-xs text-zinc-400">Drive Together - {{ visibleLocations.length }} live locations</p>
      </div>
      <span
        v-if="showRecordingBadge"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-300"
        role="status"
        :title="recordingUploading ? 'Uploading the track recording' : 'Recording your camera for the active track run'"
        :aria-label="recordingUploading ? 'Uploading track recording' : 'Recording camera for the active track run'"
      >
        <span class="h-2 w-2 rounded-full" :class="recordingUploading ? 'bg-sky-400' : 'animate-pulse bg-red-500'" aria-hidden="true" />
        {{ recordingUploading ? 'Uploading' : 'Recording' }}
      </span>
      <button
        v-if="cameraPhoneLayout && isJoined"
        type="button"
        class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 p-2 transition-colors hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-50"
        :class="webrtcStore.cameraProducer ? 'text-indigo-300' : 'text-zinc-300'"
        :disabled="webrtcStore.cameraShareStarting"
        :aria-pressed="Boolean(webrtcStore.cameraProducer)"
        :aria-label="webrtcStore.cameraShareStarting ? 'Starting camera share' : webrtcStore.cameraProducer ? 'Stop camera sharing' : 'Share camera'"
        :title="webrtcStore.cameraShareStarting ? 'Starting camera...' : webrtcStore.cameraProducer ? 'Stop camera sharing' : 'Share your rear camera when available (low-bandwidth video)'"
        @click="toggleCameraShare"
      >
        <CameraOff v-if="webrtcStore.cameraProducer" class="h-5 w-5" />
        <Camera v-else class="h-5 w-5" :class="webrtcStore.cameraShareStarting ? 'animate-pulse' : ''" />
      </button>
      <button
        v-if="cameraPhoneLayout && isJoined && webrtcStore.cameraProducer"
        type="button"
        class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 p-2 text-zinc-300 transition-colors hover:bg-zinc-800"
        aria-label="Rotate shared camera 90 degrees"
        title="Rotate camera 90 degrees"
        @click="rotateCamera"
      >
        <RotateCw class="h-5 w-5" />
      </button>
      <div v-if="!cameraPhoneLayout" class="ml-auto flex shrink-0 items-center gap-1 rounded-xl border border-white/10 bg-zinc-900/80 p-1" role="group" aria-label="Drive Together view">
        <button
          v-for="view in desktopViews"
          :key="view.value"
          type="button"
          class="rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors"
          :class="cameraView === view.value ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:bg-white/5 hover:text-white'"
          :aria-pressed="cameraView === view.value"
          :aria-label="view.ariaLabel"
          @click="cameraView = view.value"
        >{{ view.label }}</button>
      </div>
    </header>
    <div class="drive-leaderboard shrink-0 border-b border-white/5 px-4 py-2 md:px-6">
      <div class="drive-leaderboard-list flex flex-col gap-1 overflow-y-auto" aria-label="Driver leaderboard">
        <span v-for="entry in rankedParticipants" :key="entry.participant.id" class="driver-row flex w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs" :data-rank="entry.rank ?? undefined" :class="[entry.rank !== null && entry.rank <= 3 ? podiumClasses[entry.rank - 1] : webrtcStore.isUserSpeaking(entry.participant.id) ? 'border-green-500/50 text-green-300' : 'border-white/10 text-zinc-300', webrtcStore.isUserSpeaking(entry.participant.id) && entry.rank !== null && entry.rank <= 3 ? 'ring-1 ring-green-500/60' : '']" :title="entry.distance_m !== null ? `${Math.round(entry.distance_m)} m GPS distance to the shared destination` : undefined">
          <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/20 text-[10px] font-bold tabular-nums" :class="entry.rank !== null ? '' : 'text-zinc-500'">{{ entry.rank ?? '-' }}</span>
          <span class="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/30" :style="{ backgroundColor: driverColor(entry.participant.id) }" aria-hidden="true" />
          <MicOff v-if="entry.participant.isMuted || entry.participant.isDeafened" class="h-3 w-3 shrink-0 text-red-400" />
          <span class="min-w-0 flex-1 truncate">{{ entry.participant.username }}</span>
          <MapPin v-if="isJoined && driveStore.locations.has(entry.participant.id)" class="h-3 w-3 shrink-0 text-indigo-400" />
          <span v-if="driveStore.getSpeedLabel(entry.participant.id, channelId)" class="shrink-0 tabular-nums text-indigo-300" title="Current GPS speed (approximate)">{{ driveStore.getSpeedLabel(entry.participant.id, channelId) }}</span>
          <span v-if="entry.distance_m !== null" class="shrink-0 tabular-nums text-zinc-400">{{ formatDistance(entry.distance_m) }}</span>
          <button type="button" class="ml-1 inline-flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-30" :class="[isFollowingUser(entry.participant.id) ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'text-zinc-400 hover:bg-white/10 hover:text-white', phoneLayout ? 'h-11 w-11' : 'h-8 w-8']" :disabled="!isJoined || !driveStore.locations.has(entry.participant.id)" :aria-pressed="isFollowingUser(entry.participant.id)" :aria-label="isFollowingUser(entry.participant.id) ? `Stop tracking ${entry.participant.username} on the map` : `Track ${entry.participant.username} on the map`" :title="isFollowingUser(entry.participant.id) ? 'Stop tracking on the map' : 'Track this driver on the map'" @click="toggleFollowUser(entry.participant.id)"><Crosshair :class="phoneLayout ? 'h-5 w-5' : 'h-4 w-4'" /></button>
        </span>
        <p v-if="!rankedParticipants.length" class="px-1 py-2 text-xs text-zinc-500">No drivers in this room yet.</p>
      </div>
    </div>
    <p v-if="driveStore.locationError && isJoined" class="drive-location-error shrink-0 bg-amber-950/30 px-4 py-3 text-sm text-amber-200" role="alert">{{ driveStore.locationError }}</p>
    <p v-if="webrtcStore.cameraShareError" class="drive-camera-error shrink-0 bg-amber-950/30 px-4 py-2 text-xs text-amber-200" role="alert">{{ webrtcStore.cameraShareError }}</p>
    <p v-if="recordingError" class="shrink-0 bg-amber-950/30 px-4 py-2 text-xs text-amber-200" role="alert">{{ recordingError }}</p>
    <div
      ref="workspaceElement"
      class="drive-workspace min-h-0 min-w-0 flex-1"
      :class="cameraPhoneLayout ? 'drive-workspace--phone' : `drive-workspace--${cameraView}`"
      :style="splitGridStyle"
    >
      <div v-show="cameraPhoneLayout || cameraView === 'map' || cameraView === 'split'" class="drive-map-area relative min-h-0 min-w-0 flex-1 isolate">
        <div ref="mapElement" class="drive-map absolute inset-0 z-0" aria-label="Dark OpenStreetMap showing participant GPS locations" />
        <div v-show="navPanelOpen" id="drive-navigation-panel" ref="navigationElement" class="drive-navigation absolute left-14 right-3 top-3 z-20 max-h-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/95 p-3 shadow-xl backdrop-blur md:right-auto md:w-80" @pointerdown.stop @dblclick.stop @wheel.stop>
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
        <div v-show="tracksPanelOpen && !isPhoneLayout" :id="isPhoneLayout ? undefined : 'drive-tracks-panel'" class="drive-tracks absolute left-14 right-3 top-3 z-20 max-h-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/95 p-3 shadow-xl backdrop-blur md:left-auto md:right-3 md:w-96" @pointerdown.stop @dblclick.stop @wheel.stop>
          <div class="mb-2 flex items-center gap-2">
            <Route class="h-4 w-4 shrink-0 text-indigo-400" />
            <h3 class="min-w-0 flex-1 text-xs font-bold uppercase tracking-wider text-zinc-300">Server tracks</h3>
            <button type="button" class="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50" :disabled="!isJoined" @click="openTrackEditor(null)">New</button>
          </div>
          <DriveTracksContent :channel-id="channelId" :joined="isJoined" :active-track="activeTrack" :active-run="activeRun" @edit="openTrackEditor" />
        </div>
        <div v-if="trackMode && activeTrack" class="drive-track-hud pointer-events-none absolute inset-x-3 bottom-3 z-10 mx-auto max-w-md rounded-xl border border-indigo-500/30 bg-zinc-950/90 px-3 py-2 text-center shadow-xl backdrop-blur">
          <p class="truncate text-xs font-bold text-white">{{ activeTrack.name }}</p>
          <p class="mt-0.5 text-[11px] text-zinc-300">
            <template v-if="trackNextGate">Next: {{ trackNextGate.name }}<span v-if="trackNextGateDistance !== null"> · {{ formatDistance(trackNextGateDistance) }}</span> · </template>
            <span v-if="trackStarted">{{ formatDuration(trackElapsedMs) }}</span><span v-else>heading to start</span><span v-if="activeRun?.avg_speed_mps"> · avg {{ (activeRun.avg_speed_mps * 3.6).toFixed(1) }} km/h</span>
          </p>
        </div>
        <div v-if="((!visibleLocations.length && !destination && !activeTrack) || mapError)" class="pointer-events-none absolute inset-x-4 bottom-4 z-10 mx-auto max-w-md rounded-xl border border-white/10 bg-zinc-950/90 p-4 text-center shadow-xl backdrop-blur">
          <MapPin class="mx-auto mb-2 h-6 w-6 text-indigo-400" />
          <p class="text-sm font-medium text-white">{{ mapError || (isJoined ? 'Waiting for shared GPS locations' : 'Join to see and share live locations') }}</p>
          <p class="mt-1 text-xs text-zinc-400">Voice works even if you do not share your location. The map always fits all known positions.</p>
        </div>
      </div>
      <div
        v-if="!cameraPhoneLayout && cameraView === 'split'"
        class="drive-split-handle"
        :class="{ 'drive-split-handle--active': splitDragging }"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize map and camera panels"
        aria-valuemin="15"
        aria-valuemax="85"
        :aria-valuenow="Math.round(splitRatio * 100)"
        tabindex="0"
        @pointerdown="startSplitDrag"
        @keydown="onSplitKeydown"
        @dblclick="resetSplit"
      >
        <span class="drive-split-handle-grip" aria-hidden="true" />
      </div>
      <DriveCameraStage
        v-if="!cameraPhoneLayout && (cameraView === 'split' || cameraView === 'cameras')"
        :streams="webrtcStore.userCameraStreams"
        :participants="participants"
      />
      <DriveLeaderboardStage
        v-if="!cameraPhoneLayout && cameraView === 'leaderboard'"
        :active-track-id="activeTrack?.id ?? null"
      />
    </div>
    <footer class="drive-controls shrink-0 border-t border-white/5 px-4 py-3 md:px-6">
      <div class="flex items-center gap-2" :class="phoneLayout ? 'w-full' : 'justify-end'">
        <button v-if="!isJoined" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500" :class="phoneLayout ? 'min-h-11 flex-1' : ''" @click="webrtcStore.joinVoiceChannel(channelId)">Join Drive Together</button>
        <template v-if="isJoined">
          <button class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold transition-colors hover:bg-zinc-800" :class="[driveStore.isSharing ? 'text-indigo-300' : 'text-zinc-300', phoneLayout ? 'min-h-11 min-w-0 flex-1' : '']" :aria-label="driveStore.isSharing ? 'Stop sharing GPS' : 'Share GPS'" :aria-pressed="driveStore.isSharing" @click="driveStore.isSharing ? driveStore.stopSharing() : driveStore.startSharing()">
            <LocateFixed class="mr-1 inline h-4 w-4" />{{ driveStore.isSharing ? (phoneLayout ? 'GPS on' : 'Stop sharing GPS') : 'Share GPS' }}
          </button>
          <button
            v-if="!cameraPhoneLayout"
            type="button"
            class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 p-2 transition-colors hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-50"
            :class="[
              webrtcStore.cameraProducer ? 'text-indigo-300' : 'text-zinc-300',
              cameraPhoneLayout ? 'h-11 w-11 shrink-0' : 'px-3 text-xs font-semibold'
            ]"
            :disabled="webrtcStore.cameraShareStarting"
            :aria-pressed="Boolean(webrtcStore.cameraProducer)"
            :aria-label="webrtcStore.cameraShareStarting ? 'Starting camera share' : webrtcStore.cameraProducer ? 'Stop camera sharing' : 'Share camera'"
            :title="webrtcStore.cameraShareStarting ? 'Starting camera...' : webrtcStore.cameraProducer ? 'Stop camera sharing' : 'Share your rear camera when available (low-bandwidth video)'"
            @click="toggleCameraShare"
          >
            <CameraOff v-if="webrtcStore.cameraProducer" class="h-5 w-5" />
            <Camera v-else class="h-5 w-5" :class="webrtcStore.cameraShareStarting ? 'animate-pulse' : ''" />
            <span v-if="!cameraPhoneLayout">{{ webrtcStore.cameraShareStarting ? 'Starting camera...' : webrtcStore.cameraProducer ? 'Stop camera' : 'Share camera' }}</span>
          </button>
          <button
            v-if="!cameraPhoneLayout && webrtcStore.cameraProducer"
            type="button"
            class="inline-flex items-center justify-center rounded-lg border border-white/10 p-2 text-zinc-300 transition-colors hover:bg-zinc-800"
            aria-label="Rotate shared camera 90 degrees"
            title="Rotate camera 90 degrees"
            @click="rotateCamera"
          >
            <RotateCw class="h-4 w-4" />
          </button>
          <button type="button" class="inline-flex items-center justify-center rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40" :class="[navMode ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'text-zinc-300 hover:bg-zinc-800', phoneLayout ? 'h-11 w-11 shrink-0' : '']" :disabled="!canUseNav" :aria-pressed="navMode" :aria-label="canUseNav ? (navMode ? 'Exit navigation close-up' : 'Start navigation close-up of your position') : 'Navigation close-up needs active GPS sharing'" :title="canUseNav ? (navMode ? 'Exit navigation close-up' : 'Navigation close-up of your position') : 'Share your GPS to use navigation close-up'" @click="navMode = !navMode"><Navigation class="h-5 w-5" /></button>
        </template>
        <button type="button" class="inline-flex items-center justify-center rounded-lg p-2 transition-colors" :class="[navPanelOpen ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'text-zinc-300 hover:bg-zinc-800', phoneLayout ? 'h-11 w-11 shrink-0' : '']" :aria-expanded="navPanelOpen" aria-controls="drive-navigation-panel" :aria-label="navPanelOpen ? 'Hide destination panel' : 'Show destination panel'" :title="navPanelOpen ? 'Hide destination panel' : 'Show destination panel'" @click="toggleNavPanel"><Flag class="h-5 w-5" /></button>
        <button type="button" class="inline-flex items-center justify-center rounded-lg p-2 transition-colors" :class="[tracksPanelOpen ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'text-zinc-300 hover:bg-zinc-800', phoneLayout ? 'h-11 w-11 shrink-0' : '']" :aria-expanded="tracksPanelOpen" :aria-controls="isPhoneLayout ? 'drive-tracks-panel-phone' : 'drive-tracks-panel'" :aria-label="tracksPanelOpen ? 'Hide shared tracks' : 'Show shared tracks'" :title="tracksPanelOpen ? 'Hide shared tracks' : 'Show shared tracks'" @click="toggleTracksPanel"><Route class="h-5 w-5" /></button>
        <button v-if="isPhoneLayout" type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg p-2 transition-colors" :class="leaderboardPanelOpen ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'text-zinc-300 hover:bg-zinc-800'" :aria-expanded="leaderboardPanelOpen" aria-controls="drive-leaderboard-panel-phone" aria-label="Show track leaderboard" title="Track leaderboard" @click="toggleLeaderboardPanel"><Trophy class="h-5 w-5" /></button>
        <template v-if="isJoined">
          <button class="inline-flex items-center justify-center rounded-lg p-2 hover:bg-zinc-800" :class="[webrtcStore.isMuted || webrtcStore.isDeafened ? 'text-red-400' : 'text-zinc-300', phoneLayout ? 'h-11 w-11 shrink-0' : '']" :aria-label="webrtcStore.isMuted || webrtcStore.isDeafened ? 'Unmute microphone' : 'Mute microphone'" @click="webrtcStore.toggleMute()">
            <MicOff v-if="webrtcStore.isMuted || webrtcStore.isDeafened" class="h-5 w-5" /><Mic v-else class="h-5 w-5" />
          </button>
          <button v-if="phoneLayout" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg p-2 hover:bg-zinc-800" :class="webrtcStore.isDeafened ? 'text-red-400' : 'text-zinc-300'" :aria-label="webrtcStore.isDeafened ? 'Undeafen' : 'Deafen'" @click="webrtcStore.toggleDeafen()"><Headphones class="h-5 w-5" /></button>
          <button class="inline-flex items-center justify-center rounded-lg p-2 text-red-400 hover:bg-red-500/10" :class="phoneLayout ? 'h-11 w-11 shrink-0' : ''" aria-label="Leave Drive Together" @click="leaveDriveChannel"><PhoneOff class="h-5 w-5" /></button>
        </template>
      </div>
    </footer>
    <div v-if="isPhoneLayout && tracksPanelOpen" id="drive-tracks-panel-phone" class="absolute inset-0 z-40 flex flex-col bg-zinc-950" role="dialog" aria-modal="true" aria-label="Shared tracks">
      <header class="flex shrink-0 items-center gap-1 border-b border-white/5 px-2 py-3">
        <button type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-300 hover:bg-zinc-800 hover:text-white" aria-label="Back to the drive map" @click="closeTracksPanel"><ArrowLeft class="h-5 w-5" /></button>
        <h3 class="min-w-0 flex-1 truncate text-lg font-bold text-white">Tracks</h3>
        <button type="button" class="mr-1 shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50" :disabled="!isJoined" @click="openTrackEditor(null)">New</button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-10 pt-3">
        <DriveTracksContent :channel-id="channelId" :joined="isJoined" :active-track="activeTrack" :active-run="activeRun" @edit="openTrackEditor" />
      </div>
    </div>
    <div v-if="isPhoneLayout && leaderboardPanelOpen" id="drive-leaderboard-panel-phone" class="absolute inset-0 z-40 flex flex-col bg-zinc-950" role="dialog" aria-modal="true" aria-label="Track leaderboard">
      <header class="flex shrink-0 items-center gap-1 border-b border-white/5 px-2 py-3">
        <button type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-300 hover:bg-zinc-800 hover:text-white" aria-label="Back to the drive map" @click="leaderboardPanelOpen = false"><ArrowLeft class="h-5 w-5" /></button>
        <h3 class="min-w-0 flex-1 truncate text-lg font-bold text-white">Leaderboard</h3>
      </header>
      <div class="min-h-0 flex-1 p-2">
        <DriveLeaderboardStage :active-track-id="activeTrack?.id ?? null" />
      </div>
    </div>
    <TrackEditor v-if="trackEditorOpen" :track="editingTrack" @close="trackEditorOpen = false" @saved="handleTrackSaved" />
    <div
      v-if="webrtcStore.cameraSharePreviewing"
      class="absolute inset-0 z-50 flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm camera orientation"
    >
      <header class="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
        <Camera class="h-5 w-5 shrink-0 text-indigo-400" />
        <div class="min-w-0 flex-1">
          <h3 class="truncate font-bold text-white">Camera orientation</h3>
          <p class="text-xs text-zinc-400">Rotate until the picture looks upright, then confirm.</p>
        </div>
      </header>
      <div class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-3">
        <video
          :ref="setCameraPreviewVideo"
          autoplay
          muted
          playsinline
          class="max-h-full max-w-full bg-black object-contain"
        />
      </div>
      <footer class="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/10 px-4 py-3">
        <button
          type="button"
          class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-zinc-900 px-4 text-sm font-semibold text-zinc-100 transition-colors hover:bg-zinc-800"
          :aria-label="`Rotate camera 90 degrees, currently ${webrtcStore.cameraShareRotation} degrees`"
          @click="rotateCamera"
        >
          <RotateCw class="h-4 w-4" /> Rotate 90&deg; ({{ webrtcStore.cameraShareRotation }}&deg;)
        </button>
        <button
          type="button"
          class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
          @click="confirmCameraRotation"
        >
          <Check class="h-4 w-4" /> Use this
        </button>
        <button
          type="button"
          class="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800"
          @click="cancelCameraRotation"
        >
          Cancel
        </button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.phone-drive-panel {
  overflow: hidden;
}
.phone-drive-panel .drive-map-area {
  min-height: 0;
}
.drive-workspace {
  display: flex;
}
.drive-workspace--map .drive-map-area {
  min-height: 16rem;
}
.drive-workspace--split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 0.75rem minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 0;
  padding: 0.5rem;
}
.drive-workspace--split > * {
  min-height: 0;
  min-width: 0;
}
.drive-split-handle {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
  outline: none;
  border-radius: 9999px;
}
.drive-split-handle-grip {
  width: 2px;
  height: 100%;
  border-radius: 9999px;
  background: rgb(255 255 255 / 12%);
  transition: background 0.15s ease, box-shadow 0.15s ease;
}
.drive-split-handle:hover .drive-split-handle-grip,
.drive-split-handle:focus-visible .drive-split-handle-grip,
.drive-split-handle--active .drive-split-handle-grip {
  background: #818cf8;
  box-shadow: 0 0 0 3px rgb(129 140 248 / 18%);
}
.drive-split-handle:focus-visible {
  background: rgb(129 140 248 / 10%);
}
:global(body.drive-split-resizing) {
  cursor: col-resize;
  user-select: none;
}
.drive-workspace--cameras {
  display: flex;
}
.drive-workspace--leaderboard {
  display: flex;
  padding: 0.5rem;
}
.drive-workspace--leaderboard > * {
  min-height: 0;
  min-width: 0;
}
.drive-workspace--phone .drive-map-area {
  min-height: 0;
}
.phone-drive-panel .drive-location-error {
  max-height: 5rem;
  overflow-y: auto;
}
.drive-camera-error {
  max-height: 5rem;
  overflow-y: auto;
}
.drive-leaderboard-list {
  max-height: 12rem;
}
.phone-drive-panel .drive-leaderboard-list {
  max-height: 30vh;
  max-height: 30dvh;
}
.phone-drive-panel .drive-navigation {
  max-height: max(0px, calc(60% - 30px));
}
@media (max-height: 500px) {
  .phone-drive-panel .drive-leaderboard-list {
    max-height: 24vh;
    max-height: 24dvh;
  }
}
.drive-map {
  background: #18181b;
}
.drive-map :deep(.drive-direction-icon) {
  background: transparent;
  border: 0;
}
.drive-map :deep(.drive-driver-icon) {
  background: transparent;
  border: 0;
}
.drive-map :deep(.drive-dot-marker) {
  display: block;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  border-radius: 9999px;
  border: 3px solid #ffffff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 55%);
}
.drive-map :deep(.drive-avatar-marker) {
  display: block;
  box-sizing: border-box;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  overflow: hidden;
  border: 2px solid #ffffff;
  background: #18181b;
  box-shadow: 0 1px 4px rgb(0 0 0 / 60%);
}
.drive-map :deep(.drive-avatar-marker img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.drive-map :deep(.drive-marker-speaking) {
  filter: drop-shadow(0 0 5px #22c55e) drop-shadow(0 0 3px #22c55e);
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
</style>
