import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';
import { useChatStore } from './chat';
import { useDriveStore } from './drive';
import {
  activateDriveTrack,
  deactivateDriveTrack,
  deleteDriveTrack,
  isDriveTrack,
  isDriveTrackRun,
  listDriveTracks,
  saveDriveTrack,
  trackGates,
  voteDriveTrack,
  type DriveTrack,
  type DriveTrackGate,
  type DriveTrackInput,
  type DriveTrackRun,
  type DriveTrackVote
} from '../utils/driveTracks';

const channelKey = (connectionId: string | null, channelId: string): string => `${connectionId ?? ''}:${channelId}`;

export const useDriveTracksStore = defineStore('driveTracks', () => {
  const chatStore = useChatStore();
  const driveStore = useDriveStore();
  const tracks = ref<Map<string, DriveTrack>>(new Map());
  const runs = ref<Map<string, DriveTrackRun>>(new Map());
  const activeTrackIds = ref<Map<string, string>>(new Map());
  const isLoading = ref(false);
  const isSaving = ref(false);
  const lastError = ref<string | null>(null);
  const pending = new Map<string, AbortController>();

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

  const activate = async (channelId: string, trackId: string): Promise<boolean> => {
    lastError.value = null;
    try {
      const run = await activateDriveTrack(chatStore, channelId, trackId, new AbortController().signal);
      const keys = new Map(activeTrackIds.value);
      keys.set(channelKey(chatStore.activeConnectionId, channelId), trackId);
      activeTrackIds.value = keys;
      setRun(run);
      return true;
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Could not activate the track.';
      return false;
    }
  };

  const deactivate = async (channelId: string): Promise<void> => {
    lastError.value = null;
    try {
      await deactivateDriveTrack(chatStore, channelId, new AbortController().signal);
      const keys = new Map(activeTrackIds.value);
      keys.delete(channelKey(chatStore.activeConnectionId, channelId));
      activeTrackIds.value = keys;
      const currentUserId = chatStore.currentUser?.id;
      if (currentUserId) clearRun(currentUserId);
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Could not deactivate the track.';
    }
  };

  const activeTrack = (channelId: string): DriveTrack | null => {
    const trackId = activeTrackIds.value.get(channelKey(chatStore.activeConnectionId, channelId));
    return trackId ? tracks.value.get(trackId) ?? null : null;
  };

  const activeRun = (channelId: string): DriveTrackRun | null => {
    const currentUserId = chatStore.currentUser?.id;
    if (!currentUserId) return null;
    const run = runs.value.get(currentUserId);
    return run && run.channel_id === channelId ? run : null;
  };

  const gatesFor = (track: DriveTrack): DriveTrackGate[] => trackGates(track.payload);

  const setRun = (run: DriveTrackRun): void => {
    const next = new Map(runs.value);
    next.set(run.user_id, run);
    runs.value = next;
  };

  const clearRun = (userId: string): void => {
    const next = new Map(runs.value);
    next.delete(userId);
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
    } else if (type === 'drive_track_vote_updated' && typeof payload?.track_id === 'string') {
      applyVotes(payload.track_id, { up: Number(payload.up) || 0, down: Number(payload.down) || 0 });
    } else if (type === 'drive_track_run_updated' && payload?.channel_id === driveStore.joinedChannelId) {
      if (isDriveTrackRun(payload.run)) {
        setRun(payload.run);
        if (payload.run.user_id === chatStore.currentUser?.id && payload.run.status !== 'active') {
          const keys = new Map(activeTrackIds.value);
          for (const [key, trackId] of keys) if (trackId === payload.run.track_id) keys.delete(key);
          activeTrackIds.value = keys;
        }
      }
    } else if (type === 'user_left_voice' && typeof payload?.user_id === 'string') {
      clearRun(payload.user_id);
    } else if (type === 'authenticated') {
      tracks.value = new Map();
      runs.value = new Map();
      activeTrackIds.value = new Map();
    }
  };

  chatStore.addMessageListener(handleMessage);
  onScopeDispose(() => chatStore.removeMessageListener(handleMessage));

  return { tracks, trackList, runs, isLoading, isSaving, lastError, load, save, remove, vote, activate, deactivate, activeTrack, activeRun, gatesFor };
});
