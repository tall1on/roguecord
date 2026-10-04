export type Coordinates = { latitude: number; longitude: number };
export type DriveTrackGateKind = 'start' | 'checkpoint' | 'end';
export type DriveTrackCheckpoint = Coordinates & { name: string | null };
export type DriveTrackPayload = {
  start: Coordinates;
  checkpoints: DriveTrackCheckpoint[];
  end: Coordinates;
};
export type DriveTrackGate = Coordinates & {
  kind: DriveTrackGateKind;
  index: number;
  name: string;
};
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
  mine: DriveTrackVote | 0 | null;
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
  max_speed_mps: number | null;
  status: DriveTrackRunStatus;
  updated_at: number;
};
export type RunProgress = {
  nextGate: number;
  gateTimes: number[];
  status: 'active' | 'finished';
  finishedAt: number | null;
};
export type DriveTrackFix = { latitude: number; longitude: number; accuracy: number; speed?: number | null };

export class DriveTrackError extends Error {}

export const TRACK_NAME_MAX = 80;
export const TRACK_CHECKPOINT_MAX = 50;
export const CHECKPOINT_NAME_MAX = 64;
// GPS leeway: a gate counts when the driver is inside a radius that grows with the reported
// accuracy, but never past a hard ceiling so a single bad fix cannot credit a whole track.
export const GATE_MIN_RADIUS_M = 25;
export const GATE_MAX_RADIUS_M = 75;
export const GATE_ACCURACY_MULTIPLIER = 1.5;
// Fixes worse than this never advance progress (they are display-only).
export const GATE_MAX_ACCURACY_M = 100;
// Gates must be spaced in time and the implied speed must stay physically plausible.
export const GATE_MIN_INTERVAL_MS = 1000;
export const GATE_MAX_SPEED_MPS = 111;

const EARTH_RADIUS_M = 6371000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

const hasControlCharacters = (value: string): boolean => /[\x00-\x1f\x7f-\x9f]/.test(value);

export function validTrackCoordinates(value: unknown): value is Coordinates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { latitude, longitude } = value as Coordinates;
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const latitudeDelta = toRadians(b.latitude - a.latitude);
  const longitudeDelta = toRadians(b.longitude - a.longitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine))));
}

export function normalizeTrackName(value: unknown): string {
  if (typeof value !== 'string') throw new DriveTrackError('Track name is required.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > TRACK_NAME_MAX || hasControlCharacters(name)) {
    throw new DriveTrackError(`Track name must be 1 to ${TRACK_NAME_MAX} characters without control characters.`);
  }
  return name;
}

const sanitizeGateName = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value !== 'string') throw new DriveTrackError('Checkpoint name must be text.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  if (name.length > CHECKPOINT_NAME_MAX || hasControlCharacters(name)) {
    throw new DriveTrackError(`Checkpoint name must be at most ${CHECKPOINT_NAME_MAX} characters without control characters.`);
  }
  return name;
};

export function parseTrackPayload(value: unknown): DriveTrackPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DriveTrackError('Invalid track definition.');
  const { start, end, checkpoints } = value as Record<string, unknown>;
  if (!validTrackCoordinates(start)) throw new DriveTrackError('Track start is missing or invalid.');
  if (!validTrackCoordinates(end)) throw new DriveTrackError('Track end is missing or invalid.');
  const rawCheckpoints = checkpoints == null ? [] : checkpoints;
  if (!Array.isArray(rawCheckpoints) || rawCheckpoints.length > TRACK_CHECKPOINT_MAX) {
    throw new DriveTrackError(`A track supports at most ${TRACK_CHECKPOINT_MAX} checkpoints.`);
  }
  const parsedCheckpoints: DriveTrackCheckpoint[] = rawCheckpoints.map((entry, index) => {
    if (!validTrackCoordinates(entry)) throw new DriveTrackError(`Checkpoint ${index + 1} has invalid coordinates.`);
    const name = sanitizeGateName((entry as Record<string, unknown>).name);
    return { latitude: (entry as Coordinates).latitude, longitude: (entry as Coordinates).longitude, name };
  });
  return {
    start: { latitude: start.latitude, longitude: start.longitude },
    end: { latitude: end.latitude, longitude: end.longitude },
    checkpoints: parsedCheckpoints
  };
}

export function trackGates(payload: DriveTrackPayload): DriveTrackGate[] {
  const gates: DriveTrackGate[] = [
    { ...payload.start, kind: 'start', index: 0, name: 'Start' }
  ];
  payload.checkpoints.forEach((checkpoint, index) => {
    gates.push({
      latitude: checkpoint.latitude,
      longitude: checkpoint.longitude,
      kind: 'checkpoint',
      index: index + 1,
      name: checkpoint.name ?? `Checkpoint ${index + 1}`
    });
  });
  gates.push({ ...payload.end, kind: 'end', index: gates.length, name: 'Finish' });
  return gates;
}

export function trackDistanceMeters(gates: readonly DriveTrackGate[]): number {
  let total = 0;
  for (let index = 1; index < gates.length; index++) total += haversineMeters(gates[index - 1]!, gates[index]!);
  return Math.round(total);
}

export function displayTrackName(baseName: string, version: number): string {
  return version <= 1 ? baseName : `${baseName} V${version}`;
}

export function gateRadiusMeters(accuracy: number): number {
  const scaled = accuracy * GATE_ACCURACY_MULTIPLIER;
  return Math.min(GATE_MAX_RADIUS_M, Math.max(GATE_MIN_RADIUS_M, scaled));
}

// Automatic runs time out when they take longer than a slow but plausible pace could cover the track.
export const TRACK_TIMEOUT_MIN_MS = 60000;
export const TRACK_MIN_AVG_SPEED_MPS = 1;
export const TRACK_TIMEOUT_MULTIPLIER = 2;

export function trackMaxDurationMs(distanceMeters: number): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return TRACK_TIMEOUT_MIN_MS;
  return Math.max(TRACK_TIMEOUT_MIN_MS, (distanceMeters / TRACK_MIN_AVG_SPEED_MPS) * 1000 * TRACK_TIMEOUT_MULTIPLIER);
}

/**
 * Advances a run by exactly one gate when the fix is inside the leeway of the *next expected*
 * gate. Ordering, a minimum inter-gate interval and a physical speed ceiling keep GPS glitches
 * and deliberate shortcuts from crediting gates out of order.
 */
export function advanceRun(
  progress: RunProgress,
  gates: readonly DriveTrackGate[],
  fix: DriveTrackFix,
  now: number
): { progress: RunProgress; passedGate: number } | null {
  if (progress.status !== 'active') return null;
  const gateIndex = progress.nextGate;
  if (gateIndex < 0 || gateIndex >= gates.length) return null;
  if (!validTrackCoordinates(fix)) return null;
  if (typeof fix.accuracy !== 'number' || !Number.isFinite(fix.accuracy) || fix.accuracy < 0) return null;
  if (typeof now !== 'number' || !Number.isFinite(now)) return null;
  if (fix.accuracy > GATE_MAX_ACCURACY_M) return null;
  const gate = gates[gateIndex]!;
  if (haversineMeters(fix, gate) > gateRadiusMeters(fix.accuracy)) return null;
  if (gateIndex > 0) {
    const previousTime = progress.gateTimes[gateIndex - 1];
    if (previousTime === undefined || now - previousTime < GATE_MIN_INTERVAL_MS) return null;
    const elapsedSeconds = (now - previousTime) / 1000;
    const segmentMeters = haversineMeters(gates[gateIndex - 1]!, gate);
    if (elapsedSeconds > 0 && segmentMeters / elapsedSeconds > GATE_MAX_SPEED_MPS) return null;
  }
  const gateTimes = [...progress.gateTimes, now];
  const nextGate = gateIndex + 1;
  const finished = nextGate >= gates.length;
  return {
    progress: {
      nextGate,
      gateTimes,
      status: finished ? 'finished' : 'active',
      finishedAt: finished ? now : null
    },
    passedGate: gateIndex
  };
}

export function computeRunStats(distanceMeters: number, startedAt: number, finishedAt: number | null): {
  duration_ms: number | null;
  avg_speed_mps: number | null;
} {
  if (finishedAt === null) return { duration_ms: null, avg_speed_mps: null };
  const durationMs = finishedAt - startedAt;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { duration_ms: durationMs > 0 ? durationMs : 0, avg_speed_mps: null };
  const avgSpeed = distanceMeters / (durationMs / 1000);
  return {
    duration_ms: durationMs,
    avg_speed_mps: Number.isFinite(avgSpeed) && avgSpeed >= 0 ? Math.round(avgSpeed * 100) / 100 : null
  };
}
