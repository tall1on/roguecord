<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ListOrdered, Loader2, RefreshCw, Trophy } from 'lucide-vue-next'
import { useChatStore } from '../../stores/chat'
import { useDriveTracksStore } from '../../stores/driveTracks'
import { formatDriveDistance, formatDriveDuration, formatDriveSpeed } from '../../utils/driveTracks'

const props = withDefaults(defineProps<{ activeTrackId?: string | null }>(), { activeTrackId: null })
const chatStore = useChatStore()
const driveTracksStore = useDriveTracksStore()
const selectedTrackId = ref<string | null>(null)
const allTimes = ref(false)
const scrollContainer = ref<HTMLElement | null>(null)

const view = computed(() => selectedTrackId.value
  ? driveTracksStore.leaderboardView(selectedTrackId.value, allTimes.value)
  : null)
const entries = computed(() => view.value?.entries ?? [])
const loading = computed(() => view.value?.loading ?? false)
const loadingMore = computed(() => view.value?.loadingMore ?? false)
const hasMore = computed(() => view.value?.hasMore ?? false)
const username = (userId: string) => chatStore.users.find((user) => user.id === userId)?.username ?? 'Driver'
const finishedLabel = (at: number) => new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const rankClass = (index: number) => index === 0
  ? 'bg-amber-400 text-black'
  : index === 1
    ? 'bg-slate-300 text-black'
    : index === 2
      ? 'bg-orange-500 text-white'
      : 'bg-zinc-800 text-zinc-300'

const requestMore = () => {
  if (selectedTrackId.value) driveTracksStore.loadMoreLeaderboard(selectedTrackId.value, allTimes.value)
}
const onScroll = () => {
  const element = scrollContainer.value
  if (!element || !hasMore.value || loading.value || loadingMore.value) return
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 120) requestMore()
}
watch([entries, hasMore], async () => {
  await nextTick()
  const element = scrollContainer.value
  if (!element || !hasMore.value || loading.value || loadingMore.value) return
  // Fill the viewport when the first page is shorter than the scroll area.
  if (element.scrollHeight <= element.clientHeight + 8) requestMore()
}, { flush: 'post' })

watch([() => props.activeTrackId, () => driveTracksStore.trackList], () => {
  const available = driveTracksStore.trackList
  if (!available.length && !driveTracksStore.isLoading) void driveTracksStore.load()
  const inList = (id: string | null) => !!id && available.some((track) => track.id === id)
  selectedTrackId.value = inList(props.activeTrackId) ? props.activeTrackId : inList(selectedTrackId.value) ? selectedTrackId.value : available[0]?.id ?? null
}, { immediate: true })

watch([selectedTrackId, allTimes], () => {
  if (selectedTrackId.value) void driveTracksStore.loadLeaderboard(selectedTrackId.value, allTimes.value)
}, { immediate: true })
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-zinc-950">
    <header class="flex shrink-0 items-center gap-2 border-b border-white/5 px-3 py-2">
      <Trophy class="h-4 w-4 shrink-0 text-amber-400" />
      <h3 class="min-w-0 flex-1 text-xs font-bold uppercase tracking-wider text-zinc-300">Track leaderboard</h3>
      <button type="button" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40" :class="allTimes ? 'bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'" :disabled="!selectedTrackId" :aria-pressed="allTimes" :aria-label="allTimes ? 'Show best time per driver' : 'Show all times'" :title="allTimes ? 'Show best time per driver' : 'Show all times'" @click="allTimes = !allTimes">
        <ListOrdered class="h-4 w-4" />
      </button>
      <button type="button" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-40" :disabled="!selectedTrackId || loading" aria-label="Refresh leaderboard" @click="selectedTrackId && driveTracksStore.loadLeaderboard(selectedTrackId, allTimes)">
        <Loader2 v-if="loading" class="h-4 w-4 animate-spin" /><RefreshCw v-else class="h-4 w-4" />
      </button>
    </header>
    <div class="shrink-0 border-b border-white/5 px-3 py-2">
      <label for="drive-leaderboard-track" class="sr-only">Track</label>
      <select id="drive-leaderboard-track" v-model="selectedTrackId" class="w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-indigo-400">
        <option :value="null" disabled>Select a track</option>
        <option v-for="track in driveTracksStore.trackList" :key="track.id" :value="track.id">{{ track.name }}</option>
      </select>
    </div>
    <div ref="scrollContainer" class="min-h-0 flex-1 overflow-y-auto px-3 py-3" @scroll="onScroll">
      <p v-if="!driveTracksStore.trackList.length" class="rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-xs text-zinc-500">No tracks have been shared yet.</p>
      <p v-else-if="loading && !entries.length" class="px-3 py-6 text-center text-xs text-zinc-500">Loading times…</p>
      <p v-else-if="!entries.length" class="rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-xs text-zinc-500">No finished runs recorded for this track yet. Be the first to set a time.</p>
      <ol v-else class="space-y-1.5" :aria-label="allTimes ? 'All finished times' : 'Best times per driver'">
        <li v-for="(entry, index) in entries" :key="entry.run_id" class="flex items-center gap-3 rounded-lg border px-3 py-2" :class="entry.user_id === chatStore.currentUser?.id ? 'border-indigo-500/40 bg-indigo-500/10' : 'border-white/10 bg-zinc-900/70'">
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums" :class="rankClass(index)">{{ index + 1 }}</span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-white">{{ username(entry.user_id) }}<span v-if="entry.user_id === chatStore.currentUser?.id" class="text-indigo-300"> (you)</span></p>
            <p class="text-[11px] text-zinc-500">{{ formatDriveDistance(entry.distance_m) }} · {{ finishedLabel(entry.finished_at) }}</p>
          </div>
          <div class="shrink-0 text-right">
            <p class="text-sm font-bold tabular-nums text-white">{{ formatDriveDuration(entry.duration_ms) }}</p>
            <p class="text-[11px] tabular-nums text-zinc-400">{{ formatDriveSpeed(entry.avg_speed_mps) }}</p>
          </div>
        </li>
      </ol>
      <div v-if="entries.length && loadingMore" class="flex items-center justify-center py-2"><Loader2 class="h-4 w-4 animate-spin text-zinc-500" /></div>
      <p v-else-if="entries.length && !hasMore" class="py-2 text-center text-[11px] text-zinc-600">{{ allTimes ? 'All times loaded' : 'All drivers loaded' }}</p>
      <p v-if="driveTracksStore.lastError" class="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300" role="alert">{{ driveTracksStore.lastError }}</p>
    </div>
  </div>
</template>
