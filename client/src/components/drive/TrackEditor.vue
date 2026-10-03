<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ChevronDown, ChevronUp, Loader2, MapPin, Route, Save, Trash2, X } from 'lucide-vue-next'
import type { Map as LeafletMap, Marker as LeafletMarker, Polyline } from 'leaflet'
import { useDriveTracksStore } from '../../stores/driveTracks'
import type { MapPosition } from '../../utils/driveNavigation'
import { displayTrackBaseName, trackGates, type DriveTrack, type DriveTrackCheckpoint, type DriveTrackGate } from '../../utils/driveTracks'

const props = defineProps<{ track?: DriveTrack | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', track: DriveTrack): void }>()
const store = useDriveTracksStore()

const mapElement = ref<HTMLElement | null>(null)
const name = ref(props.track ? displayTrackBaseName(props.track.name) : '')
const start = ref<MapPosition | null>(null)
const end = ref<MapPosition | null>(null)
const checkpoints = ref<Array<{ id: number; latitude: number; longitude: number; name: string | null }>>([])
const placing = ref<'start' | 'checkpoint' | 'end'>('start')
const mapError = ref<string | null>(null)
const error = ref<string | null>(null)
let nextCheckpointId = 1
let leaflet: typeof import('leaflet') | null = null
const map = shallowRef<LeafletMap | null>(null)
const markers = new Map<string, LeafletMarker>()
let routeLine: Polyline | null = null
let disposed = false

if (props.track) {
  start.value = { ...props.track.payload.start }
  end.value = { ...props.track.payload.end }
  checkpoints.value = props.track.payload.checkpoints.map((checkpoint) => ({
    id: nextCheckpointId++, latitude: checkpoint.latitude, longitude: checkpoint.longitude, name: checkpoint.name
  }))
  placing.value = 'checkpoint'
}

const gates = computed<DriveTrackGate[]>(() => trackGates({
  start: start.value ?? { latitude: 0, longitude: 0 },
  end: end.value ?? { latitude: 0, longitude: 0 },
  checkpoints: checkpoints.value.map((checkpoint) => ({ latitude: checkpoint.latitude, longitude: checkpoint.longitude, name: checkpoint.name }))
}))
const placementModes = [
  { key: 'start', label: 'Start' },
  { key: 'checkpoint', label: 'Checkpoint' },
  { key: 'end', label: 'Finish' }
] as const
const hasGeometry = computed(() => !!start.value && !!end.value)

const haversine = (a: MapPosition, b: MapPosition): number => {
  const radians = Math.PI / 180
  const value = Math.sin((b.latitude - a.latitude) * radians / 2) ** 2
    + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin((b.longitude - a.longitude) * radians / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, value)))
}

const distanceLabel = computed(() => {
  if (!hasGeometry.value) return '—'
  let total = 0
  const ordered = [start.value!, ...checkpoints.value, end.value!]
  for (let index = 1; index < ordered.length; index++) total += haversine(ordered[index - 1]!, ordered[index]!)
  return total < 1000 ? `${Math.round(total)} m` : `${(total / 1000).toFixed(1)} km`
})
const canSave = computed(() => !!start.value && !!end.value && name.value.trim().length > 0 && !store.isSaving)

const gateIcon = (gate: DriveTrackGate) => {
  const color = gate.kind === 'start' ? '#22c55e' : gate.kind === 'end' ? '#f59e0b' : '#818cf8'
  const label = gate.kind === 'start' ? 'S' : gate.kind === 'end' ? 'F' : String(gate.index)
  const html = `<span style="display:flex;width:26px;height:26px;align-items:center;justify-content:center;border-radius:9999px;background:${color};color:#fff;font:700 12px/1 system-ui;border:2px solid #fff;box-shadow:0 1px 3px rgb(0 0 0/.6)">${label}</span>`
  return leaflet!.divIcon({ className: 'track-gate-icon', html, iconSize: [26, 26], iconAnchor: [13, 13] })
}

const syncMap = () => {
  if (!map.value || !leaflet) return
  const desired: Array<{ key: string; gate: DriveTrackGate; position: MapPosition }> = []
  gates.value.forEach((gate) => {
    if (gate.kind === 'start' && start.value) desired.push({ key: 'start', gate, position: start.value })
    if (gate.kind === 'end' && end.value) desired.push({ key: 'end', gate, position: end.value })
    if (gate.kind === 'checkpoint') {
      const checkpoint = checkpoints.value[gate.index - 1]
      if (checkpoint) desired.push({ key: `cp-${checkpoint.id}`, gate, position: checkpoint })
    }
  })
  const wanted = new Set(desired.map((entry) => entry.key))
  for (const [key, marker] of markers) {
    if (!wanted.has(key)) { marker.remove(); markers.delete(key) }
  }
  for (const entry of desired) {
    const latLng: [number, number] = [entry.position.latitude, entry.position.longitude]
    let marker = markers.get(entry.key)
    if (!marker) {
      marker = leaflet.marker(latLng, { icon: gateIcon(entry.gate), draggable: true }).addTo(map.value)
      marker.on('drag', () => {
        const moved = marker!.getLatLng()
        if (entry.key === 'start') start.value = { latitude: moved.lat, longitude: moved.lng }
        else if (entry.key === 'end') end.value = { latitude: moved.lat, longitude: moved.lng }
        else {
          const id = Number(entry.key.slice(3))
          checkpoints.value = checkpoints.value.map((checkpoint) => checkpoint.id === id ? { ...checkpoint, latitude: moved.lat, longitude: moved.lng } : checkpoint)
        }
        syncRouteLine()
      })
      markers.set(entry.key, marker)
    } else {
      const current = marker.getLatLng()
      if (Math.abs(current.lat - latLng[0]) > 1e-7 || Math.abs(current.lng - latLng[1]) > 1e-7) marker.setLatLng(latLng)
      marker.setIcon(gateIcon(entry.gate))
    }
  }
  syncRouteLine()
}

const syncRouteLine = () => {
  if (!map.value || !leaflet) return
  const positions: [number, number][] = []
  if (start.value) positions.push([start.value.latitude, start.value.longitude])
  for (const checkpoint of checkpoints.value) positions.push([checkpoint.latitude, checkpoint.longitude])
  if (end.value) positions.push([end.value.latitude, end.value.longitude])
  if (positions.length < 2) {
    routeLine?.remove()
    routeLine = null
    return
  }
  if (!routeLine) routeLine = leaflet.polyline(positions, { color: '#818cf8', weight: 4, opacity: 0.9, dashArray: '6 6' }).addTo(map.value)
  else routeLine.setLatLngs(positions)
}

const handleMapClick = (event: { latlng: { lat: number; lng: number } }) => {
  const position = { latitude: event.latlng.lat, longitude: event.latlng.lng }
  if (placing.value === 'start') { start.value = position; placing.value = 'checkpoint' }
  else if (placing.value === 'end') { end.value = position }
  else if (checkpoints.value.length < 50) checkpoints.value = [...checkpoints.value, { id: nextCheckpointId++, ...position, name: null }]
}

const removeCheckpoint = (id: number) => { checkpoints.value = checkpoints.value.filter((checkpoint) => checkpoint.id !== id) }
const moveCheckpoint = (index: number, delta: number) => {
  const next = [...checkpoints.value]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [entry] = next.splice(index, 1)
  next.splice(target, 0, entry!)
  checkpoints.value = next
}
const clearAll = () => { start.value = null; end.value = null; checkpoints.value = []; placing.value = 'start' }

const submit = async () => {
  error.value = null
  if (!start.value) { error.value = 'Place the start point on the map.'; return }
  if (!end.value) { error.value = 'Place the end point on the map.'; return }
  if (!name.value.trim()) { error.value = 'Enter a track name.'; return }
  const checkpointsPayload: DriveTrackCheckpoint[] = checkpoints.value.map((checkpoint) => ({ latitude: checkpoint.latitude, longitude: checkpoint.longitude, name: checkpoint.name }))
  const track = await store.save({
    name: name.value,
    start: start.value,
    checkpoints: checkpointsPayload,
    end: end.value
  }, props.track?.id ?? null)
  if (!track) { error.value = store.lastError ?? 'Could not save the track.'; return }
  emit('saved', track)
  emit('close')
}

onMounted(async () => {
  try {
    const [module] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')])
    if (disposed || !mapElement.value) return
    leaflet = module
    map.value = leaflet.map(mapElement.value, { zoomControl: true, attributionControl: false, minZoom: 2 }).setView([20, 0], 2)
    leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map.value)
    map.value.on('click', handleMapClick)
    const positions: [number, number][] = []
    if (start.value) positions.push([start.value.latitude, start.value.longitude])
    if (end.value) positions.push([end.value.latitude, end.value.longitude])
    for (const checkpoint of checkpoints.value) positions.push([checkpoint.latitude, checkpoint.longitude])
    if (positions.length) map.value.fitBounds(leaflet.latLngBounds(positions), { padding: [40, 40], maxZoom: 15 })
    syncMap()
    await nextTick()
    map.value.invalidateSize({ animate: false })
  } catch {
    mapError.value = 'The track map could not be loaded.'
  }
})

watch([start, end, checkpoints], () => syncMap(), { deep: true })
onBeforeUnmount(() => {
  disposed = true
  map.value?.remove()
  map.value = null
  markers.clear()
  routeLine = null
})
</script>

<template>
  <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Track editor" @click.self="emit('close')">
    <div class="flex h-full max-h-none w-full max-w-5xl flex-col overflow-hidden border border-white/10 bg-zinc-950 shadow-2xl sm:max-h-[880px] sm:rounded-2xl">
      <header class="flex shrink-0 items-center gap-3 border-b border-white/5 px-4 py-3">
        <Route class="h-5 w-5 shrink-0 text-indigo-400" />
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-bold text-white">Track editor</h2>
          <p class="text-xs text-zinc-500">Click the map to set the start, checkpoints and finish. Drag markers to fine-tune.</p>
        </div>
        <button type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white" aria-label="Close track editor" @click="emit('close')"><X class="h-5 w-5" /></button>
      </header>
      <div class="flex min-h-0 flex-1 flex-col md:flex-row">
        <div class="relative min-h-0 flex-1 md:min-h-72">
          <div ref="mapElement" class="track-editor-map absolute inset-0" aria-label="Track planning map" />
          <p v-if="mapError" class="absolute inset-0 flex items-center justify-center bg-zinc-950/90 p-4 text-center text-sm text-amber-300">{{ mapError }}</p>
          <div class="pointer-events-none absolute left-2 top-2 z-10 rounded-lg bg-zinc-950/80 px-2.5 py-1 text-xs font-semibold text-zinc-200 backdrop-blur">Distance: {{ distanceLabel }}</div>
        </div>
        <aside class="drive-track-scroll flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-white/5 p-3 md:w-80 md:border-l md:border-t-0">
          <div>
            <label for="track-editor-name" class="mb-1 block text-xs font-bold uppercase tracking-wider text-zinc-400">Track name</label>
            <input id="track-editor-name" v-model="name" type="text" :maxlength="80" :disabled="!!props.track" placeholder="Mountain loop" class="w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-400 disabled:opacity-60" />
            <p v-if="props.track" class="mt-1 text-[11px] text-zinc-500">Saving creates a new version of “{{ displayTrackBaseName(props.track.name) }}” (V{{ props.track.version + 1 }}).</p>
          </div>
          <div class="grid grid-cols-3 gap-1.5" role="group" aria-label="Placement mode">
            <button v-for="mode in placementModes" :key="mode.key" type="button" class="rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors" :class="placing === mode.key ? 'bg-indigo-600 text-white' : 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'" :aria-pressed="placing === mode.key" @click="placing = mode.key">{{ mode.label }}</button>
          </div>
          <div class="space-y-1">
            <div class="flex items-center gap-2 rounded-lg border border-white/10 px-2 py-1.5 text-xs text-zinc-300">
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-500 text-[10px] font-bold text-white">S</span>
              <span class="min-w-0 flex-1 truncate">{{ start ? `${start.latitude.toFixed(5)}, ${start.longitude.toFixed(5)}` : 'Not set' }}</span>
              <button v-if="start" type="button" class="rounded p-1 text-zinc-500 hover:text-red-400" aria-label="Remove start" @click="start = null"><Trash2 class="h-3.5 w-3.5" /></button>
            </div>
            <div v-for="(checkpoint, index) in checkpoints" :key="checkpoint.id" class="flex items-center gap-2 rounded-lg border border-white/10 px-2 py-1.5 text-xs text-zinc-300">
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-400 text-[10px] font-bold text-white">{{ index + 1 }}</span>
              <span class="min-w-0 flex-1 truncate">{{ checkpoint.latitude.toFixed(5) }}, {{ checkpoint.longitude.toFixed(5) }}</span>
              <button type="button" class="rounded p-1 text-zinc-500 hover:text-white disabled:opacity-30" :disabled="index === 0" aria-label="Move checkpoint up" @click="moveCheckpoint(index, -1)"><ChevronUp class="h-3.5 w-3.5" /></button>
              <button type="button" class="rounded p-1 text-zinc-500 hover:text-white disabled:opacity-30" :disabled="index === checkpoints.length - 1" aria-label="Move checkpoint down" @click="moveCheckpoint(index, 1)"><ChevronDown class="h-3.5 w-3.5" /></button>
              <button type="button" class="rounded p-1 text-zinc-500 hover:text-red-400" aria-label="Remove checkpoint" @click="removeCheckpoint(checkpoint.id)"><Trash2 class="h-3.5 w-3.5" /></button>
            </div>
            <div class="flex items-center gap-2 rounded-lg border border-white/10 px-2 py-1.5 text-xs text-zinc-300">
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">F</span>
              <span class="min-w-0 flex-1 truncate">{{ end ? `${end.latitude.toFixed(5)}, ${end.longitude.toFixed(5)}` : 'Not set' }}</span>
              <button v-if="end" type="button" class="rounded p-1 text-zinc-500 hover:text-red-400" aria-label="Remove finish" @click="end = null"><Trash2 class="h-3.5 w-3.5" /></button>
            </div>
          </div>
          <button type="button" class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800" @click="clearAll"><Trash2 class="h-3.5 w-3.5" /> Clear all points</button>
          <p v-if="checkpoints.length" class="text-[11px] text-zinc-500">{{ checkpoints.length }} checkpoint{{ checkpoints.length === 1 ? '' : 's' }} between start and finish.</p>
        </aside>
      </div>
      <footer class="flex shrink-0 items-center gap-2 border-t border-white/5 px-4 py-3">
        <p v-if="error" class="min-w-0 flex-1 truncate text-xs text-red-400" role="alert">{{ error }}</p>
        <span v-else class="min-w-0 flex-1 text-xs text-zinc-500"><MapPin class="mr-1 inline h-3.5 w-3.5" />{{ props.track ? 'Editing creates a clone with the next version number.' : 'Shared tracks can be voted on and activated by everyone.' }}</span>
        <button type="button" class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800" @click="emit('close')">Cancel</button>
        <button type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50" :disabled="!canSave" @click="submit">
          <Loader2 v-if="store.isSaving" class="h-4 w-4 animate-spin" /><Save v-else class="h-4 w-4" /> {{ props.track ? `Save as V${props.track.version + 1}` : 'Save track' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.track-editor-map {
  background: #18181b;
}
.track-editor-map :deep(.leaflet-tile-pane) {
  filter: invert(1) hue-rotate(180deg) brightness(0.75) saturate(0.65) contrast(1.1);
}
.track-editor-map :deep(.track-gate-icon) {
  background: transparent;
  border: 0;
}
.track-editor-map :deep(.leaflet-bar a) {
  background: #27272a;
  border-color: #3f3f46;
  color: #f4f4f5;
}
.track-editor-map :deep(.leaflet-bar a:hover) {
  background: #3f3f46;
}
.drive-track-scroll {
  max-height: 100%;
}
@media (max-width: 767px) {
  .drive-track-scroll {
    max-height: 40vh;
  }
}
</style>
