import assert from 'node:assert/strict';
import test from 'node:test';
import sqlite3 from 'sqlite3';
import { migrateChannelsSchema } from '../src/channelMigration';

const exec = (db: sqlite3.Database, sql: string) => new Promise<void>((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
const all = (db: sqlite3.Database, sql: string) => new Promise<any[]>((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
const close = (db: sqlite3.Database) => new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));

for (const hasFeed of [false, true]) {
  test(`migration preserves rows, dependent data, custom columns/indexes/triggers; feed_url=${hasFeed}`, async () => {
    const db = new sqlite3.Database(':memory:');
    try {
      await exec(db, `
        CREATE TABLE categories (id TEXT PRIMARY KEY);
        CREATE TABLE channels (id TEXT PRIMARY KEY, category_id TEXT, name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'rss', 'folder')), position INTEGER DEFAULT 0,
          custom_value TEXT ${hasFeed ? ', feed_url TEXT' : ''}, FOREIGN KEY(category_id) REFERENCES categories(id));
        CREATE UNIQUE INDEX custom_channels_name ON channels(name);
        CREATE TABLE messages (id TEXT, channel_id TEXT REFERENCES channels(id), content TEXT);
        CREATE TABLE audit (id TEXT);
        CREATE TRIGGER custom_channel_insert AFTER INSERT ON channels BEGIN INSERT INTO audit VALUES (new.id); END;
        INSERT INTO channels VALUES ('text', NULL, 'Text', 'text', 4, 'preserved' ${hasFeed ? ", 'https://example.com'" : ''});
        INSERT INTO channels VALUES ('voice', NULL, 'Voice', 'voice', 5, 'preserved' ${hasFeed ? ', NULL' : ''});
        INSERT INTO messages VALUES ('message', 'text', 'unchanged');
      `);
      const before = await all(db, 'SELECT * FROM channels ORDER BY id');
      await migrateChannelsSchema(db);
      assert.deepEqual(await all(db, 'SELECT * FROM channels ORDER BY id'), before.map((row) => hasFeed ? row : { ...row, feed_url: null }));
      assert.deepEqual(await all(db, 'SELECT * FROM messages'), [{ id: 'message', channel_id: 'text', content: 'unchanged' }]);
      assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
      await exec(db, "INSERT INTO channels (id, name, type) VALUES ('drive', 'Drive', 'drive')");
      await assert.rejects(exec(db, "INSERT INTO channels (id, name, type) VALUES ('duplicate', 'Drive', 'drive')"));
      await assert.rejects(exec(db, "INSERT INTO channels (id, name, type) VALUES ('invalid', 'Invalid', 'invalid')"));
      assert.deepEqual(await all(db, 'SELECT * FROM audit'), [{ id: 'text' }, { id: 'voice' }, { id: 'drive' }]);
      await migrateChannelsSchema(db);
      assert.equal((await all(db, 'SELECT * FROM channels')).length, 3);
    } finally { await close(db); }
  });
}

test('failed migration rolls back without losing original table or indexes', async () => {
  const db = new sqlite3.Database(':memory:');
  try {
    await exec(db, `CREATE TABLE channels (id TEXT PRIMARY KEY, category_id TEXT, name TEXT, type TEXT CHECK(type IN ('text', 'legacy')), position INTEGER);
      CREATE INDEX custom_index ON channels(name);
      INSERT INTO channels VALUES ('legacy', NULL, 'Legacy', 'legacy', 1);`);
    await assert.rejects(migrateChannelsSchema(db));
    assert.deepEqual(await all(db, 'SELECT * FROM channels'), [{ id: 'legacy', category_id: null, name: 'Legacy', type: 'legacy', position: 1 }]);
    assert.equal((await all(db, "SELECT name FROM sqlite_master WHERE name = 'custom_index'")).length, 1);
    assert.equal((await all(db, "SELECT name FROM sqlite_master WHERE name = 'channels_new'")).length, 0);
  } finally { await close(db); }
});
