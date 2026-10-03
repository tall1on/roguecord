import { getRouteHeading, requestDriveMessage, type DriveNavigationTransport, type MapPosition } from './driveNavigation';

export type DriveTrackGateKind = 'start' | 'checkpoint' | 'end';
export type DriveTrackCheckpoint = MapPosition & { name: string | null };
export type DriveTrackPayload = {
  start: MapPosition;
  checkpoints: DriveTrackCheckpoint[];
  end: MapPosition;
};
export type DriveTrackGate = MapPosition & { kind: DriveTrackGateKind; index: number; name: string };
export type DriveTrackVote = 1 | -1;
export type DriveTrack = {
  id: string;
  family_id: string;
  name: string;
  version: number;
  owner_id: string;
  payload: DriveTrackPayload;
  distance_m: number;
  up: number;
  down: number;
  mine: DriveTrackVote | 0;
  created_at: number;
  updated_at: number;
};
export type DriveTrackRunStatus = 'active' | 'finished' | 'abandoned';
export type DriveTrackRun = {
  id: string;
  track_id: string;
  user_id: string;
  channel_id: string;
  started_at: number;
  finished_at: number | null;
  next_gate: number;
  gates_total: number;
  gate_times: number[];
  distance_m: number;
  duration_ms: number | null;
  avg_speed_mps: number | null;
  status: DriveTrackRunStatus;
  updated_at: number;
};
export type DriveTrackInput = {
  name: string;
  start: MapPosition;
  checkpoints: DriveTrackCheckpoint[];
  end: MapPosition;
};

export const TRACK_NAME_MAX = 80;
export const TRACK_CHECKPOINT_MAX = 50;
export const CHECKPOINT_NAME_MAX = 64;

export const validTrackCoordinates = (value: unknown): value is MapPosition => {
  if (!value || typeof value !== 'object') return false;
  const { latitude, longitude } = value as MapPosition;
  return typeof latitude === 'number' && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
};

export const isDriveTrackPayload = (value: unknown): value is DriveTrackPayload => {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<DriveTrackPayload>;
  if (!validTrackCoordinates(payload.start) || !validTrackCoordinates(payload.end)) return false;
  if (!Array.isArray(payload.checkpoints) || payload.checkpoints.length > TRACK_CHECKPOINT_MAX) return false;
  return payload.checkpoints.every((checkpoint) => validTrackCoordinates(checkpoint)
    && (checkpoint.name === null || (typeof checkpoint.name === 'string' && checkpoint.name.length <= CHECKPOINT_NAME_MAX)));
};

export const isDriveTrack = (value: unknown): value is DriveTrack => {
  if (!value || typeof value !== 'object') return false;
  const track = value as Partial<DriveTrack>;
  return typeof track.id === 'string' && track.id.length > 0 && track.id.length <= 128
    && typeof track.family_id === 'string' && track.family_id.length > 0
    && typeof track.name === 'string' && track.name.length > 0 && track.name.length <= TRACK_NAME_MAX + 8
    && typeof track.version === 'number' && Number.isInteger(track.version) && track.version >= 1
    && typeof track.owner_id === 'string' && track.owner_id.length > 0
    && isDriveTrackPayload(track.payload)
    && typeof track.distance_m === 'number' && Number.isFinite(track.distance_m) && track.distance_m >= 0
    && typeof track.up === 'number' && Number.isInteger(track.up) && track.up >= 0
    && typeof track.down === 'number' && Number.isInteger(track.down) && track.down >= 0
    && (track.mine === 1 || track.mine === -1 || track.mine === 0)
    && typeof track.created_at === 'number' && typeof track.updated_at === 'number';
};

export const isDriveTrackRun = (value: unknown): value is DriveTrackRun => {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<DriveTrackRun>;
  return typeof run.id === 'string' && typeof run.track_id === 'string' && typeof run.user_id === 'string'
    && typeof run.channel_id === 'string'
    && typeof run.started_at === 'number'
    && (run.finished_at === null || typeof run.finished_at === 'number')
    && typeof run.next_gate === 'number' && Number.isInteger(run.next_gate) && run.next_gate >= 0
    && typeof run.gates_total === 'number' && Number.isInteger(run.gates_total) && run.gates_total >= 2
    && Array.isArray(run.gate_times) && run.gate_times.every((entry) => typeof entry === 'number')
    && typeof run.distance_m === 'number'
    && (run.duration_ms === null || typeof run.duration_ms === 'number')
    && (run.avg_speed_mps === null || typeof run.avg_speed_mps === 'number')
    && (run.status === 'active' || run.status === 'finished' || run.status === 'abandoned');
};

/** Strips the server-appended version suffix so the editor shows the family base name. */
export function displayTrackBaseName(name: string): string {
  return name.replace(/\s+V\d+$/, '');
}

export function trackGates(payload: DriveTrackPayload): DriveTrackGate[] {
  const gates: DriveTrackGate[] = [{ ...payload.start, kind: 'start', index: 0, name: 'Start' }];
  payload.checkpoints.forEach((checkpoint, index) => {
    gates.push({ latitude: checkpoint.latitude, longitude: checkpoint.longitude, kind: 'checkpoint', index: index + 1, name: checkpoint.name ?? `Checkpoint ${index + 1}` });
  });
  gates.push({ ...payload.end, kind: 'end', index: gates.length, name: 'Finish' });
  return gates;
}

/** [longitude, latitude] pairs consumed by getRouteHeading and the routing geometry helpers. */
export function trackRouteCoordinates(gates: readonly DriveTrackGate[]): [number, number][] {
  return gates.map((gate) => [gate.longitude, gate.latitude]);
}

/** Follows the planned track instead of the raw GPS compass while a track is active. */
export function getTrackHeading(position: MapPosition, gates: readonly DriveTrackGate[], lookAheadMeters = 40): number | null {
  return getRouteHeading(position, trackRouteCoordinates(gates), lookAheadMeters);
}

export function distanceToGate(position: MapPosition, gate: MapPosition): number {
  const radians = Math.PI / 180;
  const haversine = Math.sin((gate.latitude - position.latitude) * radians / 2) ** 2
    + Math.cos(position.latitude * radians) * Math.cos(gate.latitude * radians)
    * Math.sin((gate.longitude - position.longitude) * radians / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

const requireTrack = (value: unknown): DriveTrack => {
  if (!isDriveTrack(value)) throw new Error('The server returned an invalid track.');
  return value;
};

export const listDriveTracks = async (transport: DriveNavigationTransport, signal: AbortSignal): Promise<DriveTrack[]> => {
  const response = await requestDriveMessage(transport, 'drive_tracks_list', 'drive_tracks', null, {}, signal, 15000);
  if (!Array.isArray(response.tracks) || response.tracks.length > 500 || response.tracks.some((track: unknown) => !isDriveTrack(track))) {
    throw new Error('The server returned an invalid track list.');
  }
  return response.tracks;
};

export const saveDriveTrack = async (
  transport: DriveNavigationTransport, input: DriveTrackInput, trackId: string | null, signal: AbortSignal
): Promise<DriveTrack> => {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > TRACK_NAME_MAX) throw new Error(`Give the track a name of 1 to ${TRACK_NAME_MAX} characters.`);
  if (!validTrackCoordinates(input.start)) throw new Error('Set a start point on the map.');
  if (!validTrackCoordinates(input.end)) throw new Error('Set an end point on the map.');
  if (input.checkpoints.length > TRACK_CHECKPOINT_MAX) throw new Error(`A track supports at most ${TRACK_CHECKPOINT_MAX} checkpoints.`);
  const response = await requestDriveMessage(
    transport, trackId ? 'drive_track_update' : 'drive_track_create', 'drive_track_saved', null,
    {
      name,
      start: { latitude: input.start.latitude, longitude: input.start.longitude },
      checkpoints: input.checkpoints.map((checkpoint) => ({ latitude: checkpoint.latitude, longitude: checkpoint.longitude, name: checkpoint.name })),
      end: { latitude: input.end.latitude, longitude: input.end.longitude },
      ...(trackId ? { track_id: trackId } : {})
    },
    signal, 20000
  );
  return requireTrack(response.track);
};

export const deleteDriveTrack = async (transport: DriveNavigationTransport, trackId: string, signal: AbortSignal): Promise<void> => {
  await requestDriveMessage(transport, 'drive_track_delete', 'drive_track_deleted', null, { track_id: trackId }, signal, 15000);
};

export const voteDriveTrack = async (
  transport: DriveNavigationTransport, trackId: string, value: DriveTrackVote | 0, signal: AbortSignal
): Promise<{ up: number; down: number; mine: DriveTrackVote | 0 }> => {
  const response = await requestDriveMessage(transport, 'drive_track_vote', 'drive_track_vote', null, { track_id: trackId, value }, signal, 15000);
  if (typeof response.up !== 'number' || typeof response.down !== 'number'
    || (response.mine !== 1 && response.mine !== -1 && response.mine !== 0)) throw new Error('The server returned an invalid vote result.');
  return { up: response.up, down: response.down, mine: response.mine };
};

export const activateDriveTrack = async (
  transport: DriveNavigationTransport, channelId: string, trackId: string, signal: AbortSignal
): Promise<DriveTrackRun> => {
  const response = await requestDriveMessage(transport, 'drive_track_activate', 'drive_track_run', channelId, { track_id: trackId }, signal, 15000);
  if (!isDriveTrackRun(response.run)) throw new Error('The server returned an invalid track run.');
  return response.run;
};

export const deactivateDriveTrack = async (
  transport: DriveNavigationTransport, channelId: string, signal: AbortSignal
): Promise<void> => {
  const response = await requestDriveMessage(transport, 'drive_track_deactivate', 'drive_track_run', channelId, {}, signal, 15000);
  if (response.run !== null && !isDriveTrackRun(response.run)) throw new Error('The server returned an invalid track run.');
};
