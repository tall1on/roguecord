import crypto from 'node:crypto';
import type sqlite3 from 'sqlite3';
import {
  advanceRun,
  computeRunStats,
  displayTrackName,
  DriveTrackError,
  GATE_MAX_ACCURACY_M,
  GATE_MAX_SPEED_MPS,
  gateRadiusMeters,
  haversineMeters,
  normalizeTrackName,
  parseTrackPayload,
  trackDistanceMeters,
  trackGates,
  trackMaxDurationMs,
  validTrackCoordinates,
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

export type DriveTrackLeaderboardEntry = {
  user_id: string;
  run_id: string;
  duration_ms: number;
  avg_speed_mps: number | null;
  distance_m: number;
  finished_at: number;
};

export const LEADERBOARD_PAGE_SIZE = 50;

// Automatic tracking: a driver crossing a start gate begins timing; lingering at a start
// is cooled down so a parked car does not generate endless runs.
export const AUTO_START_COOLDOWN_MS = 15000;
const STALE_RUN_SWEEP_INTERVAL_MS = 15000;

export type DriveTrackLeaderboardPage = {
  entries: DriveTrackLeaderboardEntry[];
  total: number;
  has_more: boolean;
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
  max_speed_mps: number | null;
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
  private trackGateList: Array<{ trackId: string; gates: DriveTrackGate[]; distance_m: number }> | null = null;
  private autoStartAt = new Map<string, number>();
  private departedRuns = new Set<string>();
  private lastSweepAt = new Map<string, number>();

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
      max_speed_mps: row.max_speed_mps === null || row.max_speed_mps === undefined ? null : Number(row.max_speed_mps),
      status: row.status,
      updated_at: Number(row.updated_at)
    };
  }

  private toLeaderboardEntry(row: RunRow): DriveTrackLeaderboardEntry {
    return {
      user_id: row.user_id,
      run_id: row.id,
      duration_ms: Number(row.duration_ms),
      avg_speed_mps: row.avg_speed_mps === null || row.avg_speed_mps === undefined ? null : Number(row.avg_speed_mps),
      max_speed_mps: row.max_speed_mps === null || row.max_speed_mps === undefined ? null : Number(row.max_speed_mps),
      distance_m: Number(row.distance_m),
      finished_at: Number(row.finished_at)
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
    this.trackGateList = null;
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
    this.trackGateList = null;
    return (await this.get(id, editorId))!;
  }

  async deleteTrack(trackId: string): Promise<boolean> {
    if (!(await this.exists(trackId))) return false;
    await this.execute('DELETE FROM drive_track_votes WHERE track_id = ?', [trackId]);
    await this.execute('DELETE FROM drive_track_runs WHERE track_id = ?', [trackId]);
    await this.execute('DELETE FROM drive_tracks WHERE id = ?', [trackId]);
    this.gateCache.delete(trackId);
    this.trackGateList = null;
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

  async startRun(channelId: string, trackId: string, userId: string, now = this.now()): Promise<DriveTrackRun> {
    const record = await this.gatesFor(trackId);
    if (!record) throw new DriveTrackError('Track not found.');
    // Only the same track's stale active run is closed; other auto-tracked tracks keep running.
    await this.execute("UPDATE drive_track_runs SET status = 'abandoned', finished_at = ?, updated_at = ? WHERE channel_id = ? AND user_id = ? AND track_id = ? AND status = 'active'",
      [now, now, channelId, userId, trackId]);
    const id = crypto.randomUUID();
    const timestamp = now;
    await this.execute(
      `INSERT INTO drive_track_runs (id, track_id, user_id, channel_id, started_at, finished_at, next_gate, gates_total, gate_times_json, distance_m, duration_ms, avg_speed_mps, status, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, '[]', ?, NULL, NULL, 'active', ?)`,
      [id, trackId, userId, channelId, timestamp, record.gates.length, record.distance_m, timestamp]
    );
    return (await this.getActiveRun(channelId, userId, trackId))!;
  }

  async getActiveRun(channelId: string, userId: string, trackId?: string): Promise<DriveTrackRun | null> {
    const row = trackId
      ? await this.queryOne<RunRow>(
          "SELECT * FROM drive_track_runs WHERE channel_id = ? AND user_id = ? AND track_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
          [channelId, userId, trackId]
        )
      : await this.queryOne<RunRow>(
          "SELECT * FROM drive_track_runs WHERE channel_id = ? AND user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
          [channelId, userId]
        );
    return row ? this.toRun(row) : null;
  }

  async getActiveRuns(channelId: string, userId: string): Promise<DriveTrackRun[]> {
    const rows = await this.queryAll<RunRow>(
      "SELECT * FROM drive_track_runs WHERE channel_id = ? AND user_id = ? AND status = 'active' ORDER BY started_at ASC",
      [channelId, userId]
    );
    return rows.map((row) => this.toRun(row));
  }

  async activeRunsForChannel(channelId: string): Promise<DriveTrackRun[]> {
    const rows = await this.queryAll<RunRow>(
      "SELECT * FROM drive_track_runs WHERE channel_id = ? AND status = 'active' ORDER BY started_at ASC",
      [channelId]
    );
    return rows.map((row) => this.toRun(row));
  }

  /** Advances every active run of a driver by at most one gate. Retained for direct unit tests. */
  async observeRun(channelId: string, userId: string, fix: DriveTrackFix): Promise<DriveTrackRun | null> {
    const changed: DriveTrackRun[] = [];
    for (const run of await this.getActiveRuns(channelId, userId)) {
      const record = await this.gatesFor(run.track_id);
      if (!record) {
        const ended = await this.endRunById(run.id, 'abandoned', this.now());
        if (ended) changed.push(ended);
        continue;
      }
      const updated = await this.advanceRunRecord(run, record.gates, fix, this.now());
      if (updated) changed.push(updated);
    }
    return changed[0] ?? null;
  }

  /**
   * Automatic tracking entry point for an accepted GPS fix: expires implausibly slow runs,
   * starts a new run when the driver is on any track's start gate, and advances every active run.
   */
  async autoTrack(channelId: string, userId: string, fix: DriveTrackFix, now = this.now()): Promise<DriveTrackRun[]> {
    const changed: DriveTrackRun[] = [];
    const lastSweep = this.lastSweepAt.get(channelId) ?? -Infinity;
    if (now - lastSweep >= STALE_RUN_SWEEP_INTERVAL_MS) {
      this.lastSweepAt.set(channelId, now);
      changed.push(...await this.expireStaleRuns(channelId, now));
    }
    const records = await this.trackGateRecords();
    if (!records.length) return changed;
    const activeByTrack = new Map<string, DriveTrackRun>();
    for (const run of await this.getActiveRuns(channelId, userId)) activeByTrack.set(run.track_id, run);
    const accuracy = typeof fix.accuracy === 'number' && Number.isFinite(fix.accuracy) ? fix.accuracy : Number.POSITIVE_INFINITY;
    const canStart = accuracy <= GATE_MAX_ACCURACY_M;
    for (const record of records) {
      const start = record.gates[0];
      if (!start) continue;
      const startDistance = haversineMeters(fix, start);
      const radius = canStart ? gateRadiusMeters(accuracy) : 0;
      const startKey = `${channelId}\u0000${userId}\u0000${record.trackId}`;
      const existing = activeByTrack.get(record.trackId);
      if (existing) {
        if (this.isRunTimedOut(existing, record.distance_m, now)) {
          const expired = await this.endRunById(existing.id, 'abandoned', now);
          if (expired) changed.push(expired);
          activeByTrack.delete(record.trackId);
        } else {
          // Only a return to the start after actually leaving it restarts timing; lingering on the
          // start line right after starting must not. This handles loops and reversed layouts.
          if (canStart && startDistance > radius * 1.5) this.departedRuns.add(existing.id);
          const crossedStart = canStart && startDistance <= radius;
          const cooldownElapsed = now - (this.autoStartAt.get(startKey) ?? -Infinity) >= AUTO_START_COOLDOWN_MS;
          if (crossedStart && this.departedRuns.has(existing.id) && cooldownElapsed) {
            const abandoned = await this.endRunById(existing.id, 'abandoned', now);
            if (abandoned) changed.push(abandoned);
            this.departedRuns.delete(existing.id);
            this.autoStartAt.set(startKey, now);
            const restarted = await this.startRun(channelId, record.trackId, userId, now);
            const credited = await this.advanceRunRecord(restarted, record.gates, fix, now) ?? restarted;
            changed.push(credited);
            activeByTrack.set(record.trackId, credited);
            continue;
          }
          const updated = await this.advanceRunRecord(existing, record.gates, fix, now);
          if (updated) changed.push(updated);
          continue;
        }
      }
      if (!canStart || startDistance > radius) continue;
      if (now - (this.autoStartAt.get(startKey) ?? -Infinity) < AUTO_START_COOLDOWN_MS) continue;
      this.autoStartAt.set(startKey, now);
      const started = await this.startRun(channelId, record.trackId, userId, now);
      const credited = await this.advanceRunRecord(started, record.gates, fix, now) ?? started;
      changed.push(credited);
      activeByTrack.set(record.trackId, credited);
    }
    if (this.autoStartAt.size > 512) {
      for (const [key, at] of this.autoStartAt) if (now - at > AUTO_START_COOLDOWN_MS * 4) this.autoStartAt.delete(key);
    }
    if (this.departedRuns.size > 1024) this.departedRuns.clear();
    return changed;
  }

  /** Abandons active runs whose elapsed time exceeds the slowest plausible pace for their track. */
  async expireStaleRuns(channelId: string, now = this.now()): Promise<DriveTrackRun[]> {
    const rows = await this.queryAll<RunRow & { track_distance_m: number | null }>(
      `SELECT r.*, t.distance_m AS track_distance_m FROM drive_track_runs r
       LEFT JOIN drive_tracks t ON t.id = r.track_id
       WHERE r.channel_id = ? AND r.status = 'active'`,
      [channelId]
    );
    const changed: DriveTrackRun[] = [];
    for (const row of rows) {
      const run = this.toRun(row);
      const distance = row.track_distance_m === null || row.track_distance_m === undefined ? run.distance_m : Number(row.track_distance_m);
      if (!this.isRunTimedOut(run, distance, now)) continue;
      const updated = await this.endRunById(run.id, 'abandoned', now);
      if (updated) changed.push(updated);
    }
    return changed;
  }

  async endRun(channelId: string, userId: string, status: Exclude<DriveTrackRunStatus, 'active'> = 'abandoned'): Promise<DriveTrackRun | null> {
    return (await this.endRuns(channelId, userId, status))[0] ?? null;
  }

  async endRuns(channelId: string, userId: string, status: Exclude<DriveTrackRunStatus, 'active'> = 'abandoned'): Promise<DriveTrackRun[]> {
    const ended: DriveTrackRun[] = [];
    for (const run of await this.getActiveRuns(channelId, userId)) {
      const updated = await this.endRunById(run.id, status, this.now());
      if (updated) ended.push(updated);
    }
    return ended;
  }

  private isRunTimedOut(run: DriveTrackRun, distanceMeters: number, now: number): boolean {
    const startedAt = run.gate_times[0] ?? run.started_at;
    return now - startedAt > trackMaxDurationMs(distanceMeters);
  }

  private async endRunById(runId: string, status: Exclude<DriveTrackRunStatus, 'active'>, finishedAt: number): Promise<DriveTrackRun | null> {
    const row = await this.queryOne<RunRow>('SELECT * FROM drive_track_runs WHERE id = ?', [runId]);
    if (!row) return null;
    const run = this.toRun(row);
    if (run.status !== 'active') return null;
    this.departedRuns.delete(runId);
    const startedAt = run.gate_times[0] ?? null;
    const stats = status === 'finished' && startedAt !== null
      ? computeRunStats(run.distance_m, startedAt, finishedAt)
      : { duration_ms: startedAt === null ? null : Math.max(0, finishedAt - startedAt), avg_speed_mps: null };
    await this.execute(
      'UPDATE drive_track_runs SET status = ?, finished_at = ?, duration_ms = ?, avg_speed_mps = ?, updated_at = ? WHERE id = ?',
      [status, finishedAt, stats.duration_ms, stats.avg_speed_mps, finishedAt, run.id]
    );
    const updated = await this.queryOne<RunRow>('SELECT * FROM drive_track_runs WHERE id = ?', [run.id]);
    return updated ? this.toRun(updated) : null;
  }

  private recordableSpeed(run: DriveTrackRun, fix: DriveTrackFix): number | null {
    if (!validTrackCoordinates(fix)) return null;
    const accuracy = fix.accuracy;
    if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > GATE_MAX_ACCURACY_M) return null;
    const speed = fix.speed;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0 || speed > GATE_MAX_SPEED_MPS) return null;
    const rounded = Math.round(speed * 100) / 100;
    return rounded > (run.max_speed_mps ?? 0) ? rounded : null;
  }

  private async advanceRunRecord(run: DriveTrackRun, gates: readonly DriveTrackGate[], fix: DriveTrackFix, now: number): Promise<DriveTrackRun | null> {
    // Peak speed is sampled from every accepted fix, even between gates.
    const recordedSpeed = this.recordableSpeed(run, fix);
    const result = advanceRun(
      { nextGate: run.next_gate, gateTimes: run.gate_times, status: 'active', finishedAt: null },
      gates,
      fix,
      now
    );
    if (!result) {
      if (recordedSpeed !== null) {
        await this.execute('UPDATE drive_track_runs SET max_speed_mps = ?, updated_at = ? WHERE id = ?', [recordedSpeed, now, run.id]);
      }
      return null;
    }
    const finished = result.progress.status === 'finished';
    const finishedAt = result.progress.finishedAt;
    // Timing starts at the start gate, not when the run was created, so approach is not counted.
    const startedAt = result.progress.gateTimes[0] ?? run.started_at;
    const stats = finished ? computeRunStats(run.distance_m, startedAt, finishedAt) : { duration_ms: null, avg_speed_mps: null };
    const maxSpeed = recordedSpeed ?? run.max_speed_mps ?? null;
    await this.execute(
      'UPDATE drive_track_runs SET next_gate = ?, gate_times_json = ?, status = ?, finished_at = ?, duration_ms = ?, avg_speed_mps = ?, max_speed_mps = ?, updated_at = ? WHERE id = ?',
      [result.progress.nextGate, JSON.stringify(result.progress.gateTimes), result.progress.status, finishedAt, stats.duration_ms, stats.avg_speed_mps, maxSpeed, now, run.id]
    );
    const updated = await this.queryOne<RunRow>('SELECT * FROM drive_track_runs WHERE id = ?', [run.id]);
    return updated ? this.toRun(updated) : null;
  }

  private async trackGateRecords(): Promise<Array<{ trackId: string; gates: DriveTrackGate[]; distance_m: number }>> {
    if (this.trackGateList) return this.trackGateList;
    const rows = await this.queryAll<{ id: string; payload_json: string; distance_m: number }>('SELECT id, payload_json, distance_m FROM drive_tracks');
    const records: Array<{ trackId: string; gates: DriveTrackGate[]; distance_m: number }> = [];
    for (const row of rows) {
      this.cacheGates(row.id, row.payload_json, Number(row.distance_m));
      const cached = this.gateCache.get(row.id);
      if (cached) records.push({ trackId: row.id, gates: cached.gates, distance_m: cached.distance_m });
    }
    this.trackGateList = records;
    return records;
  }

  /** Paginated leaderboard: every finished run when `allTimes`, otherwise each driver's best. */
  async leaderboard(trackId: string, options: { allTimes?: boolean; offset?: number } = {}): Promise<DriveTrackLeaderboardPage> {
    const allTimes = options.allTimes === true;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.trunc(options.offset as number)) : 0;
    const filter = "track_id = ? AND status = 'finished' AND duration_ms IS NOT NULL AND duration_ms > 0";
    const rows = await this.queryAll<RunRow>(
      allTimes
        ? `SELECT * FROM drive_track_runs WHERE ${filter} ORDER BY duration_ms ASC, finished_at ASC LIMIT ? OFFSET ?`
        : `SELECT * FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY duration_ms ASC, finished_at ASC) AS leaderboard_rank
             FROM drive_track_runs WHERE ${filter}
           ) WHERE leaderboard_rank = 1 ORDER BY duration_ms ASC, finished_at ASC LIMIT ? OFFSET ?`,
      [trackId, LEADERBOARD_PAGE_SIZE, offset]
    );
    const count = await this.queryOne<{ total: number | null }>(
      allTimes
        ? `SELECT COUNT(*) AS total FROM drive_track_runs WHERE ${filter}`
        : `SELECT COUNT(DISTINCT user_id) AS total FROM drive_track_runs WHERE ${filter}`,
      [trackId]
    );
    const total = Number(count?.total ?? 0);
    const entries = rows.map((row) => this.toLeaderboardEntry(row));
    return { entries, total, has_more: offset + entries.length < total };
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
