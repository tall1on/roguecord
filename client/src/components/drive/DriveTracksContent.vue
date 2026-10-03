<script setup lang="ts">
import { useChatStore } from '../../stores/chat'
import { useDriveTracksStore } from '../../stores/driveTracks'
import type { DriveTrack, DriveTrackRun } from '../../utils/driveTracks'
import TrackList from './TrackList.vue'

const props = defineProps<{
  channelId: string
  joined: boolean
  activeTrack: DriveTrack | null
  activeRun: DriveTrackRun | null
}>()
const emit = defineEmits<{ (e: 'edit', track: DriveTrack): void }>()

const chatStore = useChatStore()
const driveTracksStore = useDriveTracksStore()

const handleActivate = async (track: DriveTrack) => {
  if (!props.joined) return
  await driveTracksStore.activate(props.channelId, track.id)
}
const handleDeactivate = async () => { await driveTracksStore.deactivate(props.channelId) }
const handleVote = (track: DriveTrack, value: 1 | -1 | 0) => { void driveTracksStore.vote(track.id, value) }
const handleDelete = async (track: DriveTrack) => {
  if (!window.confirm(`Delete “${track.name}” from the server? This cannot be undone.`)) return
  await driveTracksStore.remove(track.id)
}
</script>

<template>
  <div class="space-y-2">
    <p v-if="!joined" class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Join the drive channel to activate or create tracks.</p>
    <p v-if="driveTracksStore.lastError" class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300" role="alert">{{ driveTracksStore.lastError }}</p>
    <p v-if="activeTrack && activeRun" class="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200" role="status">{{ activeTrack.name }} · checkpoint {{ Math.min(activeRun.gate_times.length, activeRun.gates_total) }}/{{ activeRun.gates_total }}<span v-if="activeRun.status === 'finished'"> · finished</span></p>
    <TrackList
      :tracks="driveTracksStore.trackList"
      :can-delete="chatStore.currentUserIsAdmin"
      :active-track-id="activeTrack?.id ?? null"
      :show-actions="true"
      :busy="driveTracksStore.isSaving"
      empty-text="No tracks have been shared yet."
      @activate="handleActivate"
      @deactivate="handleDeactivate"
      @edit="emit('edit', $event)"
      @delete="handleDelete"
      @vote="handleVote"
    />
  </div>
</template>
