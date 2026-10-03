import crypto from 'node:crypto';
import type sqlite3 from 'sqlite3';
import {
  advanceRun,
  computeRunStats,
  displayTrackName,
  DriveTrackError,
  normalizeTrackName,
  parseTrackPayload,
  trackDistanceMeters,
  trackGates,
  type DriveTrack,
  type DriveTrackFix,
  type DriveTrackGate,
  type DriveTrackPayload,
  type DriveTrackRun,
  type DriveTrackRunStatus,
  type DriveTrackVote
} from '../driveTracks';

export type DriveTrackInput = {
  name: string;
  start: unknown;
  checkpoints?: unknown;
  end: unknown;
};

type TrackRow = {
  id: string;
  family_id: string;
  name: string;
  version: number;
  owner_user_id: string;
  payload_json: string;
  distance_m: number;
  created_at: number;
  updated_at: number;
  up?: number | null;
  down?: number | null;
  mine?: number | null;
};

type RunRow = {
  id: string;
  track_id: string;
  user_id: string;
  channel_id: string;
  started_at: number;
  finished_at: number | null;
  next_gate: number;
  gates_total: number;
  gate_times_json: string;
  distance_m: number;
  duration_ms: number | null;
  avg_speed_mps: number | null;
  status: DriveTrackRunStatus;
  updated_at: number;
};

const parseGateTimes = (value: string): number[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry)) : [];
  } catch {
    return [];
  }
};

export class DriveTracksStore {
  private gateCache = new Map<string, { gates: DriveTrackGate[]; distance_m: number }>();

  constructor(private db: sqlite3.Database, private now: () => number = Date.now) {}

  private queryAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows as T[])));
    });
  }

  private queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row as T | undefined)));
    });
  }

  private execute(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (error) => (error ? reject(error) : resolve()));
    });
  }

  private cacheGates(trackId: string, payloadJson: string, distanceMeters: number): void {
    const payload = parseTrackPayload(JSON.parse(payloadJson));
    this.gateCache.set(trackId, { gates: trackGates(payload), distance_m: distanceMeters });
  }

  private toTrack(row: TrackRow): DriveTrack {
    const payload: DriveTrackPayload = parseTrackPayload(JSON.parse(row.payload_json));
    const mine = Number(row.mine ?? 0);
    return {
      id: row.id,
      family_id: row.family_id,
      name: displayTrackName(row.name, Number(row.version)),
      version: Number(row.version),
      owner_id: row.owner_user_id,
      payload,
      distance_m: Number(row.distance_m),
      up: Number(row.up ?? 0),
      down: Number(row.down ?? 0),
      mine: mine === 1 ? 1 : mine === -1 ? -1 : 0,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at)
    };
  }

  private toRun(row: RunRow): DriveTrackRun {
    return {
      id: row.id,
      track_id: row.track_id,
      user_id: row.user_id,
      channel_id: row.channel_id,
      started_at: Number(row.started_at),
      finished_at: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
      next_gate: Number(row.next_gate),
      gates_total: Number(row.gates_total),
      gate_times: parseGateTimes(row.gate_times_json),
      distance_m: Number(row.distance_m),
      duration_ms: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      avg_speed_mps: row.avg_speed_mps === null || row.avg_speed_mps === undefined ? null : Number(row.avg_speed_mps),
      status: row.status,
      updated_at: Number(row.updated_at)
    };
  }

  private trackSelect = `SELECT t.id, t.family_id, t.name, t.version, t.owner_user_id, t.payload_json, t.distance_m,
      t.created_at, t.updated_at,
      COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS up,
      COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS down,
      COALESCE(SUM(CASE WHEN v.user_id = ? THEN v.value ELSE 0 END), 0) AS mine
    FROM drive_tracks t
    LEFT JOIN drive_track_votes v ON v.track_id = t.id`;

  async list(viewerId: string): Promise<DriveTrack[]> {
    const rows = await this.queryAll<TrackRow>(`${this.trackSelect} GROUP BY t.id`, [viewerId]);
    rows.forEach((row) => this.cacheGates(row.id, row.payload_json, Number(row.distance_m)));
    const records = rows.map((row) => this.toTrack(row));
    records.sort((a, b) => (b.up - b.down) - (a.up - a.down) || b.updated_at - a.updated_at);
    return records;
  }

  async get(trackId: string, viewerId: string): Promise<DriveTrack | null> {
    const row = await this.queryOne<TrackRow>(`${this.trackSelect} WHERE t.id = ? GROUP BY t.id`, [viewerId, trackId]);
    if (!row) return null;
    this.cacheGates(row.id, row.payload_json, Number(row.distance_m));
    return this.toTrack(row);
  }

  async exists(trackId: string): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>('SELECT id FROM drive_tracks WHERE id = ?', [trackId]);
    return Boolean(row);
  }

  async gatesFor(trackId: string): Promise<{ gates: DriveTrackGate[]; distance_m: number } | null> {
    const cached = this.gateCache.get(trackId);
    if (cached) return cached;
    const row = await this.queryOne<{ payload_json: string; distance_m: number }>('SELECT payload_json, distance_m FROM drive_tracks WHERE id = ?', [trackId]);
    if (!row) return null;
    this.cacheGates(trackId, row.payload_json, Number(row.distance_m));
    return this.gateCache.get(trackId) ?? null;
  }

  async createTrack(ownerId: string, input: DriveTrackInput): Promise<DriveTrack> {
    const name = normalizeTrackName(input.name);
    const payload = parseTrackPayload(input);
    const gates = trackGates(payload);
    const distance = trackDistanceMeters(gates);
    const id = crypto.randomUUID();
    const timestamp = this.now();
    await this.execute(
      'INSERT INTO drive_tracks (id, family_id, name, version, owner_user_id, payload_json, distance_m, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
      [id, id, name, ownerId, JSON.stringify(payload), distance, timestamp, timestamp]
    );
    this.gateCache.set(id, { gates, distance_m: distance });
    return (await this.get(id, ownerId))!;
  }

  /**
   * Editing never mutates the shared track: it appends a new version to the same family
   * (name V2, V3, ...), owned by the editor.
   */
  async cloneTrack(sourceId: string, editorId: string, input: DriveTrackInput): Promise<DriveTrack> {
    const source = await this.queryOne<{ family_id: string; name: string }>('SELECT family_id, name FROM drive_tracks WHERE id = ?', [sourceId]);
    if (!source) throw new DriveTrackError('Track not found.');
    const payload = parseTrackPayload(input);
    const gates = trackGates(payload);
    const distance = trackDistanceMeters(gates);
    const versionRow = await this.queryOne<{ maxVersion: number | null }>('SELECT MAX(version) AS maxVersion FROM drive_tracks WHERE family_id = ?', [source.family_id]);
    const version = Number(versionRow?.maxVersion ?? 0) + 1;
    const id = crypto.randomUUID();
    const timestamp = this.now();
    await this.execute(
      'INSERT INTO drive_tracks (id, family_id, name, version, owner_user_id, payload_json, distance_m, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, source.family_id, source.name, version, editorId, JSON.stringify(payload), distance, timestamp, timestamp]
    );
    this.gateCache.set(id, { gates, distance_m: distance });
    return (await this.get(id, editorId))!;
  }

  async deleteTrack(trackId: string): Promise<boolean> {
    if (!(await this.exists(trackId))) return false;
    await this.execute('DELETE FROM drive_track_votes WHERE track_id = ?', [trackId]);
    await this.execute('DELETE FROM drive_track_runs WHERE track_id = ?', [trackId]);
    await this.execute('DELETE FROM drive_tracks WHERE id = ?', [trackId]);
    this.gateCache.delete(trackId);
    return true;
  }

  async setVote(trackId: string, userId: string, value: DriveTrackVote | 0): Promise<{ up: number; down: number; mine: DriveTrackVote | 0 } | null> {
    if (!(await this.exists(trackId))) return null;
    if (value === 0) await this.execute('DELETE FROM drive_track_votes WHERE track_id = ? AND user_id = ?', [trackId, userId]);
    else await this.execute('INSERT OR REPLACE INTO drive_track_votes (track_id, user_id, value, updated_at) VALUES (?, ?, ?, ?)', [trackId, userId, value, this.now()]);
    const row = await this.queryOne<{ up: number | null; down: number | null; mine: number | null }>(
      `SELECT COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS up,
        COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS down,
        COALESCE(SUM(CASE WHEN user_id = ? THEN value ELSE 0 END), 0) AS mine
       FROM drive_track_votes WHERE track_id = ?`,
      [userId, trackId]
    );
    const mine = Number(row?.mine ?? 0);
    return { up: Number(row?.up ?? 0), down: Number(row?.down ?? 0), mine: mine === 1 ? 1 : mine === -1 ? -1 : 0 };
  }

  async startRun(channelId: string, trackId: string, userId: string): Promise<DriveTrackRun> {
    const record = await this.gatesFor(trackId);
    if (!record) throw new DriveTrackError('Track not found.');
    await this.execute("UPDATE drive_track_runs SET status = 'abandoned', finished_at = ?, updated_at = ? WHERE channel_id = ? AND user_id = ? AND status = 'active'",
      [this.now(), this.now(), channelId, userId]);
    const id = crypto.randomUUID();
    const timestamp = this.now();
    await this.execute(
      `INSERT INTO drive_track_runs (id, track_id, user_id, channel_id, started_at, finished_at, next_gate, gates_total, gate_times_json, distance_m, duration_ms, avg_speed_mps, status, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, '[]', ?, NULL, NULL, 'active', ?)`,
      [id, trackId, userId, channelId, timestamp, record.gates.length, record.distance_m, timestamp]
    );
    return (await this.getActiveRun(channelId, userId))!;
  }

  async getActiveRun(channelId: string, userId: string): Promise<DriveTrackRun | null> {
    const row = await this.queryOne<RunRow>(
      "SELECT * FROM drive_track_runs WHERE channel_id = ? AND user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
      [channelId, userId]
    );
    return row ? this.toRun(row) : null;
  }

  async observeRun(channelId: string, userId: string, fix: DriveTrackFix): Promise<DriveTrackRun | null> {
    const run = await this.getActiveRun(channelId, userId);
    if (!run) return null;
    const record = await this.gatesFor(run.track_id);
    if (!record) {
      await this.endRun(channelId, userId, 'abandoned');
      return null;
    }
    const result = advanceRun(
      { nextGate: run.next_gate, gateTimes: run.gate_times, status: 'active', finishedAt: null },
      record.gates,
      fix,
      this.now()
    );
    if (!result) return null;
    const finished = result.progress.status === 'finished';
    const finishedAt = result.progress.finishedAt;
    const stats = finished ? computeRunStats(run.distance_m, run.started_at, finishedAt) : { duration_ms: null, avg_speed_mps: null };
    await this.execute(
      'UPDATE drive_track_runs SET next_gate = ?, gate_times_json = ?, status = ?, finished_at = ?, duration_ms = ?, avg_speed_mps = ?, updated_at = ? WHERE id = ?',
      [result.progress.nextGate, JSON.stringify(result.progress.gateTimes), result.progress.status, finishedAt, stats.duration_ms, stats.avg_speed_mps, this.now(), run.id]
    );
    const updated = await this.queryOne<RunRow>('SELECT * FROM drive_track_runs WHERE id = ?', [run.id]);
    return updated ? this.toRun(updated) : null;
  }

  async endRun(channelId: string, userId: string, status: Exclude<DriveTrackRunStatus, 'active'> = 'abandoned'): Promise<DriveTrackRun | null> {
    const run = await this.getActiveRun(channelId, userId);
    if (!run) return null;
    const finishedAt = this.now();
    const stats = status === 'finished'
      ? computeRunStats(run.distance_m, run.started_at, finishedAt)
      : { duration_ms: Math.max(0, finishedAt - run.started_at), avg_speed_mps: null };
    await this.execute(
      'UPDATE drive_track_runs SET status = ?, finished_at = ?, duration_ms = ?, avg_speed_mps = ?, updated_at = ? WHERE id = ?',
      [status, finishedAt, stats.duration_ms, stats.avg_speed_mps, finishedAt, run.id]
    );
    const updated = await this.queryOne<RunRow>('SELECT * FROM drive_track_runs WHERE id = ?', [run.id]);
    return updated ? this.toRun(updated) : null;
  }

  /** Closes every active run in a room, e.g. when the channel itself is deleted. */
  async abandonRunsForChannel(channelId: string): Promise<void> {
    const finishedAt = this.now();
    await this.execute(
      "UPDATE drive_track_runs SET status = 'abandoned', finished_at = ?, duration_ms = MAX(0, ? - started_at), updated_at = ? WHERE channel_id = ? AND status = 'active'",
      [finishedAt, finishedAt, finishedAt, channelId]
    );
  }
}
