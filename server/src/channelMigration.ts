import type sqlite3 from 'sqlite3';

// Use a dedicated connection so other startup migrations cannot enter this transaction.
export const migrateChannelsSchema = (db: sqlite3.Database): Promise<void> => new Promise((resolve, reject) => {
  db.all('PRAGMA table_info(channels)', (error, columns: { name: string }[]) => {
    if (error) return reject(error);
    db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels'", (error, row: { sql: string } | undefined) => {
      if (error) return reject(error);
      if (!row?.sql) return reject(new Error('Channels table is missing during migration'));
      const hasFeedUrl = columns.some((column) => column.name === 'feed_url');
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_channels_category_position ON channels(category_id, position)',
        'CREATE INDEX IF NOT EXISTS idx_channels_position ON channels(position)'
      ];
      if (hasFeedUrl && row.sql.toLowerCase().includes("'folder'") && row.sql.toLowerCase().includes("'drive'")) {
        db.exec(indexes.join(';'), (error) => error ? reject(error) : resolve());
        return;
      }
      db.all("SELECT sql FROM sqlite_master WHERE tbl_name = 'channels' AND type IN ('index', 'trigger') AND sql IS NOT NULL", (error, objects: { sql: string }[]) => {
        if (error) return reject(error);
        const schema = row.sql
          .replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"channels"|`channels`|\[channels\]|channels)/i, 'CREATE TABLE channels_new')
          .replace(/CHECK\s*\(\s*type\s+IN\s*\([^)]*\)\s*\)/i, "CHECK(type IN ('text', 'voice', 'rss', 'folder', 'drive'))");
        const names = columns.map(({ name }) => `"${name.replace(/"/g, '""')}"`).join(', ');
        const statements = [
          'BEGIN IMMEDIATE',
          schema,
          ...(!hasFeedUrl ? ['ALTER TABLE channels_new ADD COLUMN feed_url TEXT'] : []),
          `INSERT INTO channels_new (${names}) SELECT ${names} FROM channels`,
          'DROP TABLE channels',
          'ALTER TABLE channels_new RENAME TO channels',
          ...objects.map(({ sql }) => sql),
          ...indexes,
          'COMMIT'
        ];
        db.exec(statements.join(';'), (error) => {
          if (!error) return resolve();
          db.exec('ROLLBACK', () => reject(error));
        });
      });
    });
  });
});
