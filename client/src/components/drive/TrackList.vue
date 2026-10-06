<script setup lang="ts">
import { Navigation, Pencil, Route, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-vue-next'
import { useChatStore } from '../../stores/chat'
import type { DriveTrack, DriveTrackVote } from '../../utils/driveTracks'

withDefaults(defineProps<{
  tracks: DriveTrack[]
  canDelete?: boolean
  activeTrackId?: string | null
  showActions?: boolean
  emptyText?: string
  busy?: boolean
}>(), { canDelete: false, activeTrackId: null, showActions: false, emptyText: 'No shared tracks yet.', busy: false })

const emit = defineEmits<{
  (e: 'edit', track: DriveTrack): void
  (e: 'delete', track: DriveTrack): void
  (e: 'vote', track: DriveTrack, value: DriveTrackVote | 0): void
  (e: 'navigate', track: DriveTrack): void
  (e: 'clear-navigation'): void
}>()

const chatStore = useChatStore()
const formatDistance = (meters: number): string => meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`
const isOwn = (track: DriveTrack): boolean => track.owner_id === chatStore.currentUser?.id
const toggleVote = (track: DriveTrack, value: DriveTrackVote) => emit('vote', track, track.mine === value ? 0 : value)
</script>

<template>
  <ul class="space-y-2" aria-label="Shared tracks">
    <li v-for="track in tracks" :key="track.id" class="rounded-xl border border-white/10 bg-zinc-900/70 p-3">
      <div class="flex items-start gap-2">
        <Route class="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-white">
            {{ track.name }}
            <span v-if="track.version > 1" class="ml-1 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-300">V{{ track.version }}</span>
          </p>
          <p class="mt-0.5 text-[11px] text-zinc-500">{{ formatDistance(track.distance_m) }} · {{ isOwn(track) ? 'your track' : 'shared by a driver' }} · {{ track.payload.checkpoints.length }} checkpoint{{ track.payload.checkpoints.length === 1 ? '' : 's' }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button type="button" class="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors" :class="track.mine === 1 ? 'border-green-500/50 bg-green-500/15 text-green-300' : 'border-white/10 text-zinc-300 hover:bg-zinc-800'" :aria-pressed="track.mine === 1" :aria-label="`Upvote ${track.name}`" :disabled="busy" @click="toggleVote(track, 1)"><ThumbsUp class="h-3.5 w-3.5" />{{ track.up }}</button>
          <button type="button" class="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors" :class="track.mine === -1 ? 'border-red-500/50 bg-red-500/15 text-red-300' : 'border-white/10 text-zinc-300 hover:bg-zinc-800'" :aria-pressed="track.mine === -1" :aria-label="`Downvote ${track.name}`" :disabled="busy" @click="toggleVote(track, -1)"><ThumbsDown class="h-3.5 w-3.5" />{{ track.down }}</button>
        </div>
      </div>
      <div v-if="showActions || canDelete" class="mt-2 flex flex-wrap items-center gap-1.5">
        <template v-if="showActions">
          <button v-if="activeTrackId === track.id" type="button" class="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500" :disabled="busy" @click="emit('clear-navigation')"><X class="h-3.5 w-3.5" /> Stop navigation</button>
          <button v-else type="button" class="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800" :disabled="busy" @click="emit('navigate', track)"><Navigation class="h-3.5 w-3.5" /> Navigate</button>
        </template>
        <button type="button" class="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800" :disabled="busy" :title="`Edit creates a new version of ${track.name}`" @click="emit('edit', track)"><Pencil class="h-3.5 w-3.5" /> Edit (clone)</button>
        <button v-if="canDelete" type="button" class="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/10" :disabled="busy" @click="emit('delete', track)"><Trash2 class="h-3.5 w-3.5" /> Delete</button>
      </div>
    </li>
    <li v-if="!tracks.length" class="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-xs text-zinc-500">{{ emptyText }}</li>
  </ul>
</template>
