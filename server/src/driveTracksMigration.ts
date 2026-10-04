import type sqlite3 from 'sqlite3';

const run = (db: sqlite3.Database, sql: string): Promise<void> => new Promise((resolve, reject) => {
  db.run(sql, (error) => (error ? reject(error) : resolve()));
});

const columns = (db: sqlite3.Database, table: string): Promise<{ name: string }[]> => new Promise((resolve, reject) => {
  db.all(`PRAGMA table_info(${table})`, (error, rows) => (error ? reject(error) : resolve(rows as { name: string }[])));
});

export async function migrateDriveTracks(db: sqlite3.Database): Promise<void> {
  await run(db, `CREATE TABLE IF NOT EXISTS drive_tracks (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      owner_user_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      distance_m INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`);
  await run(db, `CREATE TABLE IF NOT EXISTS drive_track_votes (
      track_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      value INTEGER NOT NULL CHECK(value IN (-1, 1)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (track_id, user_id),
      FOREIGN KEY (track_id) REFERENCES drive_tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
  await run(db, `CREATE TABLE IF NOT EXISTS drive_track_runs (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      next_gate INTEGER NOT NULL DEFAULT 0,
      gates_total INTEGER NOT NULL DEFAULT 0,
      gate_times_json TEXT NOT NULL DEFAULT '[]',
      distance_m INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      avg_speed_mps REAL,
      max_speed_mps REAL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'finished', 'abandoned')),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (track_id) REFERENCES drive_tracks(id) ON DELETE CASCADE
    )`);
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_drive_tracks_family ON drive_tracks(family_id, version)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_drive_tracks_updated ON drive_tracks(updated_at)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_drive_track_votes_track ON drive_track_votes(track_id)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_drive_track_runs_track ON drive_track_runs(track_id)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_drive_track_runs_active ON drive_track_runs(channel_id, status)');
  // Additive upgrade for databases created before peak speed tracking existed.
  const runColumns = await columns(db, 'drive_track_runs');
  if (!runColumns.some((column) => column.name === 'max_speed_mps')) {
    await run(db, 'ALTER TABLE drive_track_runs ADD COLUMN max_speed_mps REAL');
  }
}
