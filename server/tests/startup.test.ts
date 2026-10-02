import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';

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
    './storage/userAvatarStorage': {}
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
