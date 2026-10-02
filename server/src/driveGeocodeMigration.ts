import type sqlite3 from 'sqlite3';

export function migrateDriveGeocodeCache(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(`CREATE TABLE IF NOT EXISTS drive_geocode_cache (
      cache_key TEXT PRIMARY KEY,
      results_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`, (error) => {
      if (error) { reject(error); return; }
      db.run('CREATE INDEX IF NOT EXISTS idx_drive_geocode_cache_expiry ON drive_geocode_cache(expires_at)',
        (error) => error ? reject(error) : resolve());
    });
  });
}
