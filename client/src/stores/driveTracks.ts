import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';
import { useChatStore } from './chat';
import { useDriveStore } from './drive';
import {
  deleteDriveTrack,
  getDriveRecordingUrl,
  getDriveTrackLeaderboard,
  isDriveTrack,
  isDriveTrackRun,
  listDriveTracks,
  saveDriveTrack,
  trackGates,
  voteDriveTrack,
  type DriveTrack,
  type DriveTrackGate,
  type DriveTrackInput,
  type DriveTrackLeaderboardEntry,
  type DriveTrackRun,
  type DriveTrackVote
} from '../utils/driveTracks';

const channelKey = (connectionId: string | null, channelId: string): string => `${connectionId ?? ''}:${channelId}`;
type DriveTrackLeaderboardView = {
  entries: DriveTrackLeaderboardEntry[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
};
type DriveTrackLeaderboardViews = Partial<Record<'best' | 'all', DriveTrackLeaderboardView>>;

const emptyLeaderboardView = (): DriveTrackLeaderboardView => ({ entries: [], total: 0, hasMore: false, loading: false, loadingMore: false });

const mergeLeaderboardEntries = (
  existing: readonly DriveTrackLeaderboardEntry[], incoming: readonly DriveTrackLeaderboardEntry[]
): DriveTrackLeaderboardEntry[] => {
  const seen = new Set(existing.map((entry) => entry.run_id));
  return [...existing, ...incoming.filter((entry) => !seen.has(entry.run_id))];
};

export const useDriveTracksStore = defineStore('driveTracks', () => {
  const chatStore = useChatStore();
  const driveStore = useDriveStore();
  const tracks = ref<Map<string, DriveTrack>>(new Map());
  const runs = ref<Map<string, DriveTrackRun>>(new Map());
  const activeTrackIds = ref<Map<string, string>>(new Map());
  const leaderboards = ref<Map<string, DriveTrackLeaderboardViews>>(new Map());
  const isLoading = ref(false);
  const isSaving = ref(false);
  const downloadingRunId = ref<string | null>(null);
  const lastError = ref<string | null>(null);
  const pending = new Map<string, AbortController>();
  const pendingLeaderboards = new Map<string, AbortController>();

  const trackList = computed(() => [...tracks.value.values()].sort((a, b) => (b.up - b.down) - (a.up - a.down) || b.updated_at - a.updated_at));

  const load = async (): Promise<void> => {
    pending.get('list')?.abort();
    const controller = new AbortController();
    pending.set('list', controller);
    isLoading.value = true;
    lastError.value = null;
    try {
      const result = await listDriveTracks(chatStore, controller.signal);
      if (pending.get('list') !== controller) return;
      tracks.value = new Map(result.map((track) => [track.id, track]));
    } catch (error) {
      if (pending.get('list') !== controller || (error as Error)?.name === 'AbortError') return;
      lastError.value = error instanceof Error ? error.message : 'Could not load shared tracks.';
    } finally {
      if (pending.get('list') === controller) {
        pending.delete('list');
        isLoading.value = false;
      }
    }
  };

  const save = async (input: DriveTrackInput, trackId: string | null): Promise<DriveTrack | null> => {
    pending.get('save')?.abort();
    const controller = new AbortController();
    pending.set('save', controller);
    isSaving.value = true;
    lastError.value = null;
    try {
      const track = await saveDriveTrack(chatStore, input, trackId, controller.signal);
      if (pending.get('save') !== controller) return null;
      tracks.value = new Map(tracks.value).set(track.id, track);
      return track;
    } catch (error) {
      if (pending.get('save') !== controller || (error as Error)?.name === 'AbortError') return null;
      lastError.value = error instanceof Error ? error.message : 'Could not save the track.';
      return null;
    } finally {
      if (pending.get('save') === controller) {
        pending.delete('save');
        isSaving.value = false;
      }
    }
  };

  const remove = async (trackId: string): Promise<boolean> => {
    lastError.value = null;
    try {
      await deleteDriveTrack(chatStore, trackId, new AbortController().signal);
      const next = new Map(tracks.value);
      next.delete(trackId);
      tracks.value = next;
      return true;
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Could not delete the track.';
      return false;
    }
  };

  const leaderboardView = (trackId: string | null, allTimes: boolean): DriveTrackLeaderboardView => {
    if (!trackId) return emptyLeaderboardView();
    return leaderboards.value.get(trackId)?.[allTimes ? 'all' : 'best'] ?? emptyLeaderboardView();
  };

  const updateLeaderboardView = (
    trackId: string, allTimes: boolean, update: (view: DriveTrackLeaderboardView) => DriveTrackLeaderboardView
  ): void => {
    const mode = allTimes ? 'all' : 'best';
    const next = new Map(leaderboards.value);
    const views = { ...next.get(trackId) };
    views[mode] = update(views[mode] ?? emptyLeaderboardView());
    next.set(trackId, views);
    leaderboards.value = next;
  };

  const loadLeaderboard = async (trackId: string, allTimes = false, offset = 0): Promise<void> => {
    const requestKey = `${trackId}:${allTimes ? 'all' : 'best'}`;
    if (offset > 0) {
      // A page request is already in flight; ignore duplicate scroll triggers.
      if (pendingLeaderboards.has(requestKey)) return;
    } else {
      pendingLeaderboards.get(requestKey)?.abort();
    }
    const controller = new AbortController();
    pendingLeaderboards.set(requestKey, controller);
    updateLeaderboardView(trackId, allTimes, (view) => ({ ...view, loading: offset === 0, loadingMore: offset > 0 }));
    lastError.value = null;
    try {
      const page = await getDriveTrackLeaderboard(chatStore, trackId, controller.signal, { allTimes, offset });
      if (pendingLeaderboards.get(requestKey) !== controller) return;
      const existing = leaderboardView(trackId, allTimes);
      const entries = offset === 0 ? page.entries : mergeLeaderboardEntries(existing.entries, page.entries);
      updateLeaderboardView(trackId, allTimes, () => ({ entries, total: page.total, hasMore: page.hasMore, loading: false, loadingMore: false }));
    } catch (error) {
      if (pendingLeaderboards.get(requestKey) !== controller || (error as Error)?.name === 'AbortError') return;
      updateLeaderboardView(trackId, allTimes, (view) => ({ ...view, loading: false, loadingMore: false }));
      lastError.value = error instanceof Error ? error.message : 'Could not load the leaderboard.';
    } finally {
      if (pendingLeaderboards.get(requestKey) === controller) pendingLeaderboards.delete(requestKey);
    }
  };

  const loadMoreLeaderboard = (trackId: string, allTimes: boolean): void => {
    const view = leaderboardView(trackId, allTimes);
    if (!view.hasMore || view.loading || view.loadingMore) return;
    void loadLeaderboard(trackId, allTimes, view.entries.length);
  };

  const downloadRecording = async (runId: string): Promise<boolean> => {
    if (downloadingRunId.value) return false;
    downloadingRunId.value = runId;
    lastError.value = null;
    try {
      const recording = await getDriveRecordingUrl(chatStore, runId, new AbortController().signal);
      const anchor = document.createElement('a');
      anchor.href = recording.url;
      anchor.download = recording.fileName;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      window.setTimeout(() => anchor.remove(), 0);
      return true;
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Could not download the recording.';
      return false;
    } finally {
      downloadingRunId.value = null;
    }
  };

  const vote = async (trackId: string, value: DriveTrackVote | 0): Promise<void> => {
    lastError.value = null;
    try {
      const result = await voteDriveTrack(chatStore, trackId, value, new AbortController().signal);
      applyVotes(trackId, result);
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Could not record your vote.';
    }
  };

  const applyVotes = (trackId: string, votes: { up: number; down: number; mine?: DriveTrackVote | 0 }): void => {
    const track = tracks.value.get(trackId);
    if (!track) return;
    const next = new Map(tracks.value);
    next.set(trackId, { ...track, up: votes.up, down: votes.down, mine: votes.mine ?? track.mine });
    tracks.value = next;
  };

  const navigate = (channelId: string, trackId: string): boolean => {
    const keys = new Map(activeTrackIds.value);
    keys.set(channelKey(chatStore.activeConnectionId, channelId), trackId);
    activeTrackIds.value = keys;
    return true;
  };

  const clearNavigation = (channelId: string): void => {
    const keys = new Map(activeTrackIds.value);
    keys.delete(channelKey(chatStore.activeConnectionId, channelId));
    activeTrackIds.value = keys;
  };

  const activeTrack = (channelId: string): DriveTrack | null => {
    const trackId = activeTrackIds.value.get(channelKey(chatStore.activeConnectionId, channelId));
    return trackId ? tracks.value.get(trackId) ?? null : null;
  };

  const activeRun = (channelId: string): DriveTrackRun | null => {
    const currentUserId = chatStore.currentUser?.id;
    if (!currentUserId) return null;
    const own = [...runs.value.values()].filter((run) => run.user_id === currentUserId && run.channel_id === channelId);
    if (!own.length) return null;
    const trackId = activeTrackIds.value.get(channelKey(chatStore.activeConnectionId, channelId));
    const navigated = trackId ? own.find((run) => run.track_id === trackId) : undefined;
    if (navigated) return navigated;
    return own.find((run) => run.status === 'active') ?? own.sort((a, b) => b.started_at - a.started_at)[0]!;
  };

  const gatesFor = (track: DriveTrack): DriveTrackGate[] => trackGates(track.payload);

  const setRun = (run: DriveTrackRun): void => {
    const next = new Map(runs.value);
    next.set(run.id, run);
    runs.value = next;
  };

  const clearRun = (userId: string): void => {
    const next = new Map(runs.value);
    for (const [id, run] of next) if (run.user_id === userId) next.delete(id);
    runs.value = next;
  };

  const applyTrackChanged = (track: DriveTrack): void => {
    tracks.value = new Map(tracks.value).set(track.id, track);
  };

  const handleMessage = ({ type, payload }: { type: string; payload: any }) => {
    if (type === 'drive_track_changed' && isDriveTrack(payload?.track)) {
      applyTrackChanged(payload.track);
    } else if (type === 'drive_track_removed' && typeof payload?.track_id === 'string') {
      const next = new Map(tracks.value);
      next.delete(payload.track_id);
      tracks.value = next;
      const boards = new Map(leaderboards.value);
      boards.delete(payload.track_id);
      leaderboards.value = boards;
    } else if (type === 'drive_track_vote_updated' && typeof payload?.track_id === 'string') {
      applyVotes(payload.track_id, { up: Number(payload.up) || 0, down: Number(payload.down) || 0 });
    } else if (type === 'drive_track_run_updated' && payload?.channel_id === driveStore.joinedChannelId) {
      if (isDriveTrackRun(payload.run)) {
        setRun(payload.run);
        if (payload.run.status === 'finished') {
          const board = leaderboards.value.get(payload.run.track_id);
          if (board?.best) void loadLeaderboard(payload.run.track_id);
          if (board?.all) void loadLeaderboard(payload.run.track_id, true);
        }
      }
    } else if (type === 'drive_track_recording_ready' && typeof payload?.track_id === 'string') {
      // Refresh any open leaderboard so the download action appears once the clip is stored.
      const board = leaderboards.value.get(payload.track_id);
      if (board?.best) void loadLeaderboard(payload.track_id);
      if (board?.all) void loadLeaderboard(payload.track_id, true);
    } else if (type === 'user_left_voice' && typeof payload?.user_id === 'string') {
      clearRun(payload.user_id);
    } else if (type === 'authenticated') {
      tracks.value = new Map();
      runs.value = new Map();
      activeTrackIds.value = new Map();
      leaderboards.value = new Map();
    }
  };

  chatStore.addMessageListener(handleMessage);
  onScopeDispose(() => chatStore.removeMessageListener(handleMessage));

  return { tracks, trackList, runs, isLoading, isSaving, downloadingRunId, lastError, load, save, remove, vote, navigate, clearNavigation, activeTrack, activeRun, gatesFor, leaderboards, leaderboardView, loadLeaderboard, loadMoreLeaderboard, downloadRecording };
});
