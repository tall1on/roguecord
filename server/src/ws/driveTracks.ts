import { WebSocket } from 'ws';
import { channelsSchemaReady, db } from '../db';
import { getChannelById, getServer, getUserById, getUserServerRoles } from '../models';
import { rolesIncludeAdmin } from '../permissions';
import { DriveTrackError, type DriveTrack, type DriveTrackFix, type DriveTrackRun, type DriveTrackVote } from '../driveTracks';
import { connectionManager, type ClientConnection } from './connectionManager';
import { driveParticipants, validDriveId } from './drive';
import { DriveTracksStore, type DriveTrackInput } from './driveTracksStore';

export const driveTracksStore = new DriveTracksStore(db);

const isAdminUser = async (userId: string): Promise<boolean> => {
  const server = await getServer();
  if (!server) return false;
  const user = await getUserById(userId);
  if (!user) return false;
  const roles = await getUserServerRoles(server.id, user.id, user.role);
  return rolesIncludeAdmin(roles);
};

const broadcastTrackChanged = (track: DriveTrack): void => {
  connectionManager.broadcastToAuthenticated({ type: 'drive_track_changed', payload: { track } });
};

export const broadcastDriveRun = (channelId: string, run: DriveTrackRun | null): void => {
  driveParticipants.broadcast(channelId, 'drive_track_run_updated', { channel_id: channelId, run });
};

/** Called after an accepted GPS update: advances checkpoint timing and relays any change to the room. */
export const observeDriveLocation = async (channelId: string, userId: string, fix: DriveTrackFix): Promise<DriveTrackRun | null> => {
  const run = await driveTracksStore.observeRun(channelId, userId, fix);
  if (run) broadcastDriveRun(channelId, run);
  return run;
};

/** Ends an active run when a driver leaves the room or disconnects. */
export const endDriveTrackRun = async (channelId: string, userId: string): Promise<void> => {
  const run = await driveTracksStore.endRun(channelId, userId, 'abandoned');
  if (run) broadcastDriveRun(channelId, run);
};

/** Closes all active runs in a room, e.g. when the drive channel is deleted. */
export const abandonDriveRunsForChannel = (channelId: string): Promise<void> => driveTracksStore.abandonRunsForChannel(channelId);

const readInput = (payload: Record<string, unknown>): DriveTrackInput => ({
  name: typeof payload.name === 'string' ? payload.name : '',
  start: payload.start,
  checkpoints: payload.checkpoints,
  end: payload.end
});

const responseTypes: Record<string, string> = {
  drive_tracks_list: 'drive_tracks',
  drive_track_create: 'drive_track_saved',
  drive_track_update: 'drive_track_saved',
  drive_track_delete: 'drive_track_deleted',
  drive_track_vote: 'drive_track_vote',
  drive_track_activate: 'drive_track_run',
  drive_track_deactivate: 'drive_track_run'
};

const writeTypes = new Set(['drive_track_create', 'drive_track_update', 'drive_track_delete', 'drive_track_vote', 'drive_track_activate', 'drive_track_deactivate']);
const limits = new WeakMap<ClientConnection, { at: number; pending: number }>();
let outstanding = 0;

export const handleDriveTracks = async (client: ClientConnection, type: string, raw: unknown): Promise<void> => {
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const requestId = payload.request_id;
  const channelId = validDriveId(payload.channel_id) ? payload.channel_id : null;
  const trackId = validDriveId(payload.track_id) ? payload.track_id : null;
  const userId = client.userId;
  const identityVersion = client.identityVersion;
  const active = () => client.ws.readyState === WebSocket.OPEN && client.userId === userId && client.identityVersion === identityVersion;

  const responseType = responseTypes[type]!;
  const reply = (result: Record<string, unknown>) => {
    if (!active()) return;
    client.ws.send(JSON.stringify({ type: responseType, payload: { request_id: requestId ?? null, ...(channelId ? { channel_id: channelId } : {}), ...result } }));
  };

  let admitted = false;
  let limit = limits.get(client);
  try {
    if (!client.userId || !validDriveId(requestId) || !active()) throw new DriveTrackError('Authentication required.');
    if (!limit) { limit = { at: -Infinity, pending: 0 }; limits.set(client, limit); }
    if (writeTypes.has(type) && Date.now() - limit.at < 500) throw new DriveTrackError('Drive track rate limit exceeded. Please try again.');
    if (limit.pending >= 4 || outstanding >= 64) throw new DriveTrackError('Too many outstanding drive track requests. Please try again.');
    limit.at = Date.now();
    limit.pending++;
    outstanding++;
    admitted = true;

    await channelsSchemaReady;
    if (!active()) return;

    if (type === 'drive_tracks_list') {
      reply({ tracks: await driveTracksStore.list(userId!) });
      return;
    }

    if (type === 'drive_track_create' || type === 'drive_track_update') {
      const input = readInput(payload);
      let track: DriveTrack;
      if (type === 'drive_track_create') {
        track = await driveTracksStore.createTrack(userId!, input);
      } else {
        if (!trackId) throw new DriveTrackError('Track identifier is required.');
        track = await driveTracksStore.cloneTrack(trackId, userId!, input);
      }
      broadcastTrackChanged(track);
      reply({ track });
      return;
    }

    if (type === 'drive_track_delete') {
      if (!trackId) throw new DriveTrackError('Track identifier is required.');
      if (!(await isAdminUser(userId!))) throw new DriveTrackError('Only admins can delete shared tracks.');
      if (!(await driveTracksStore.deleteTrack(trackId))) throw new DriveTrackError('Track not found.');
      connectionManager.broadcastToAuthenticated({ type: 'drive_track_removed', payload: { track_id: trackId } });
      reply({ track_id: trackId, deleted: true });
      return;
    }

    if (type === 'drive_track_vote') {
      if (!trackId) throw new DriveTrackError('Track identifier is required.');
      const value = payload.value;
      if (value !== 1 && value !== 0 && value !== -1) throw new DriveTrackError('Vote must be an upvote, downvote or cleared.');
      const votes = await driveTracksStore.setVote(trackId, userId!, value as DriveTrackVote | 0);
      if (!votes) throw new DriveTrackError('Track not found.');
      connectionManager.broadcastToAuthenticated({ type: 'drive_track_vote_updated', payload: { track_id: trackId, ...votes } });
      reply({ track_id: trackId, ...votes });
      return;
    }

    if (type === 'drive_track_activate') {
      if (!channelId || !trackId) throw new DriveTrackError('Track and drive channel are required.');
      if (!driveParticipants.owns(channelId, client)) throw new DriveTrackError('Join the drive channel before activating a track.');
      const channel = await getChannelById(channelId);
      if (!active()) return;
      if (channel?.type !== 'drive') throw new DriveTrackError('Drive channel not found.');
      const run = await driveTracksStore.startRun(channelId, trackId, userId!);
      reply({ run });
      broadcastDriveRun(channelId, run);
      return;
    }

    if (type === 'drive_track_deactivate') {
      if (!channelId) throw new DriveTrackError('Drive channel is required.');
      if (!driveParticipants.owns(channelId, client)) throw new DriveTrackError('Join the drive channel before changing the active track.');
      const run = await driveTracksStore.endRun(channelId, userId!, 'abandoned');
      reply({ run });
      broadcastDriveRun(channelId, run);
      return;
    }

    throw new DriveTrackError('Unsupported drive track request.');
  } catch (error) {
    reply({ error: error instanceof DriveTrackError ? error.message : 'Drive track request failed. Please try again.' });
  } finally {
    if (admitted) { limit!.pending--; outstanding--; }
  }
};
