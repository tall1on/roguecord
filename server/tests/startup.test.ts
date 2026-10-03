import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';
import sqlite3 from 'sqlite3';
import { migrateDriveGeocodeCache } from '../src/driveGeocodeMigration';

test('startup waits for schema before listening and never logs GPS payloads', async () => {
  let ready!: () => void;
  const channelsSchemaReady = new Promise<void>((resolve) => { ready = resolve; });
  let listens = 0;
  let created = 0;
  let wss!: EventEmitter;
  let handled = '';
  const logs: string[] = [];
  class FakeWebSocketServer extends EventEmitter {
    constructor() { super(); wss = this; }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  const mocks: Record<string, unknown> = {
    'node:http': { createServer: () => { created++; return { listen: () => { listens++; } }; } },
    ws: { WebSocketServer: FakeWebSocketServer },
    dotenv: { config: () => {} },
    './db': { channelsSchemaReady, dataDir: process.cwd() },
    './mediasoup': {},
    './ws/connectionManager': { connectionManager: { addClient: (ws: EventEmitter) => ({ ws, userId: 'user', isAlive: true }) } },
    './ws/handlers': { handleMessage: async (_client: unknown, message: string) => { handled = message; } },
    './admin': {},
    './rssPolling': {},
    './models': {},
    './storage/s3Storage': {},
    './storage/userAvatarStorage': {},
    './storage/driverAvatarStorage': {}
  };
  vm.runInNewContext(compiled, {
    exports: {},
    require: (id: string) => id in mocks ? mocks[id] : require(id),
    process,
    console: { log: (...values: unknown[]) => logs.push(values.join(' ')), error: (...values: unknown[]) => logs.push(values.join(' ')) },
    setInterval: () => 0,
    clearInterval: () => {}
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, 0);
  assert.equal(listens, 0);
  ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, 1);
  assert.equal(listens, 1);
  const ws = new EventEmitter();
  wss.emit('connection', ws, { socket: { remoteAddress: '127.0.0.1' } });
  const raw = JSON.stringify({ type: 'drive_location_update', payload: { channel_id: 'drive', location: { latitude: 48.123456, longitude: 11.987654, accuracy: 6.789 } } });
  ws.emit('message', Buffer.from(raw));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, raw);
  assert.ok(!logs.join('\n').includes('48.123456'));
  assert.ok(!logs.join('\n').includes('11.987654'));
  assert.ok(!logs.join('\n').includes('6.789'));
});

test('database readiness includes the geocode migration and rejects migration failures', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/db.ts'), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  for (const fail of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mockedSqlite = { ...sqlite3, Database: class extends sqlite3.Database {
      constructor(_file: string, callback: (error: Error | null) => void) {
        super(':memory:', callback);
      }
    } };
    const module = { exports: {} as Record<string, any> };
    const requireMock = (id: string) => {
      if (id === 'sqlite3') return mockedSqlite;
      if (id === './driveGeocodeMigration') return { migrateDriveGeocodeCache: async (db: sqlite3.Database) => {
        await gate;
        if (fail) throw new Error('mock cache migration failure');
        await migrateDriveGeocodeCache(db);
      } };
      if (id === './driveTracksMigration') return require('../src/driveTracksMigration');
      // The dedicated channel connection has its own :memory: DB; channel migration is tested separately.
      if (id === './channelMigration') return { migrateChannelsSchema: async () => {} };
      if (id === './permissions') return require('../src/permissions');
      return require(id);
    };
    vm.runInNewContext(compiled, { module, exports: module.exports, require: requireMock, __dirname: path.join(__dirname, '../src'), console: { log: () => {}, error: () => {} } });
    let settled = false;
    const completion = module.exports.channelsSchemaReady.then(() => { settled = true; });
    void completion.catch(() => {});
    const checked = fail ? assert.rejects(completion, /mock cache migration failure/) : completion;
    // Other migrations finish against a real in-memory database, but the cache step is still blocked.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false);
    release();
    await checked;
    assert.equal(settled, !fail);
    await new Promise<void>((resolve, reject) => module.exports.db.close((error: Error | null) => error ? reject(error) : resolve()));
  }
});
