import assert from 'node:assert/strict';
import test from 'node:test';
import sqlite3 from 'sqlite3';
import { createHash } from 'node:crypto';
import { migrateDriveGeocodeCache } from '../src/driveGeocodeMigration';
import { DriveServices, ProviderQueue, normalizeDriveQuery, parseOsrm, parsePhoton, readDriveConfig, validCoordinates } from '../src/driveServices';

const run = (db: sqlite3.Database, sql: string, params: unknown[] = []) => new Promise<void>((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
const all = (db: sqlite3.Database, sql: string) => new Promise<any[]>((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
const close = (db: sqlite3.Database) => new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
const config = () => readDriveConfig({ DRIVE_PHOTON_URL: 'http://localhost:2322/api/?key=private', DRIVE_OSRM_URL: 'http://localhost:5000/base?key=private' });
const origin = { latitude: 48.123456, longitude: 11.987654 };
const destination = { latitude: 49, longitude: 12 };
const photon = { type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [12, 49] }, properties: { name: 'Park', city: 'Town' } }] };
const osrm = { code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[11.9, 48.1], [12, 49]] }, distance: 123, duration: 45 }] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const mockFetch = (fn: (url: URL, init: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('additive geocode migration preserves legacy rows and is idempotent', async () => {
  const db = new sqlite3.Database(':memory:');
  try {
    await run(db, 'CREATE TABLE channels(id TEXT PRIMARY KEY, type TEXT)');
    await run(db, "INSERT INTO channels VALUES ('old', 'text')");
    await migrateDriveGeocodeCache(db);
    await run(db, "INSERT INTO drive_geocode_cache VALUES ('existing', '[]', 9999999999999, 1)");
    await migrateDriveGeocodeCache(db);
    assert.deepEqual(await all(db, 'SELECT * FROM channels'), [{ id: 'old', type: 'text' }]);
    assert.equal((await all(db, 'SELECT * FROM drive_geocode_cache')).length, 1);
    assert.ok((await all(db, "PRAGMA index_list('drive_geocode_cache')")).some((row) => row.name === 'idx_drive_geocode_cache_expiry'));
  } finally { await close(db); }
});

test('strict coordinates, normalized query, admin configuration, and validated Photon results', () => {
  assert.equal(normalizeDriveQuery('  Central\n  Park  '), 'Central Park');
  for (const value of ['', 'x', 'x'.repeat(251), {}, 'abc\x00']) assert.throws(() => normalizeDriveQuery(value));
  for (const latitude of ['48', NaN, Infinity, 91, -91]) assert.equal(validCoordinates({ latitude, longitude: 1 }), false);
  for (const longitude of ['1', NaN, Infinity, 181, -181]) assert.equal(validCoordinates({ latitude: 1, longitude }), false);
  assert.equal(validCoordinates({ latitude: -90, longitude: 180 }), true);
  assert.equal(readDriveConfig({}).geocodeTtlMs, 7 * 86400000);
  assert.equal(readDriveConfig({ DRIVE_OSRM_URL: '' }).osrmUrl, '');
  assert.equal(config().osrmUrl, 'http://localhost:5000/base?key=private');
  for (const url of ['file:///etc/passwd', 'ftp://host', 'http://user:secret@host', 'https://host/#secret', 'not a url']) {
    assert.throws(() => readDriveConfig({ DRIVE_OSRM_URL: url }), (error: Error) => !error.message.includes(url));
  }
  assert.throws(() => readDriveConfig({ DRIVE_GEOCODE_MAX_ROWS: 'NaN' }));
  assert.deepEqual(parsePhoton(photon), [{ latitude: 49, longitude: 12, label: 'Park, Town' }]);
  assert.deepEqual(parsePhoton({ type: 'FeatureCollection', features: [] }), []);
  assert.equal(parsePhoton({ ...photon, features: Array.from({ length: 10 }, (_, index) => ({
    geometry: { type: 'Point', coordinates: [12 + index / 100, 49] }, properties: { name: `Place ${index}` }
  })) }).length, 5);
  for (const data of [{}, { ...photon, features: [{ geometry: { type: 'Point', coordinates: ['12', 49] }, properties: { name: 'Place' } }] }]) assert.throws(() => parsePhoton(data));
});

test('SQLite positive/empty TTL, normalized inflight dedup, endpoint isolation, pruning and privacy', async () => {
  const db = new sqlite3.Database(':memory:');
  await migrateDriveGeocodeCache(db);
  let now = 1000;
  let calls = 0;
  let empty = false;
  const cfg = { ...config(), geocodeTtlMs: 100, emptyTtlMs: 10, maxRows: 2 };
  const fetcher = mockFetch(async (url, init) => {
    calls++;
    assert.equal(url.searchParams.get('q'), 'Central Park');
    assert.equal(url.searchParams.get('limit'), '5');
    assert.equal(init.redirect, 'error');
    assert.match((init.headers as Record<string, string>)['User-Agent'], /Roguecord/);
    return response(empty ? { type: 'FeatureCollection', features: [] } : photon);
  });
  try {
    const service = new DriveServices(db, cfg, fetcher, () => now);
    const first = service.search(' Central  Park ');
    assert.equal(first, service.search('Central Park'));
    assert.equal(first, service.search('  CENTRAL  park  '));
    assert.equal((await first).length, 1);
    await service.search('Central Park');
    await service.search('central park');
    assert.equal(calls, 1);
    const rows = await all(db, 'SELECT * FROM drive_geocode_cache');
    assert.equal(rows[0].expires_at, 1100);
    assert.match(rows[0].cache_key, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(rows).includes('private'));
    now = 1100;
    empty = true;
    assert.deepEqual(await service.search('Central Park'), []);
    assert.equal(calls, 2);
    now = 1109;
    await service.search('Central Park');
    assert.equal(calls, 2);
    now = 1110;
    await service.search('Central Park');
    assert.equal(calls, 3);
    const differentEndpoint = new DriveServices(db, { ...cfg, photonUrl: 'http://127.0.0.1/api/' }, fetcher, () => now);
    await differentEndpoint.search('Central Park');
    assert.equal(calls, 4);
    await run(db, "INSERT INTO drive_geocode_cache VALUES ('expired', '[]', 1, 1)");
    await run(db, "INSERT INTO drive_geocode_cache VALUES ('older', '[]', 99999, 1)");
    await differentEndpoint.search('Central Park');
    assert.equal((await all(db, 'SELECT * FROM drive_geocode_cache')).length, 2);
    const key = createHash('sha256').update(JSON.stringify([cfg.photonUrl, 'central park'])).digest('hex');
    await run(db, 'UPDATE drive_geocode_cache SET results_json = ? WHERE cache_key = ?', ['[{"latitude":"bad","longitude":2,"label":"bad"}]', key]);
    now = 1111;
    await service.search('Central Park');
    assert.equal(calls, 5);
    // No routes or source GPS enter the only navigation table.
    assert.ok(!JSON.stringify(await all(db, 'SELECT * FROM drive_geocode_cache')).includes(String(origin.latitude)));
  } finally { await close(db); }
});

test('failed Photon responses never populate the cache or disclose upstream details', async () => {
  const db = new sqlite3.Database(':memory:');
  await migrateDriveGeocodeCache(db);
  let calls = 0;
  try {
    const service = new DriveServices(db, config(), mockFetch(async () => {
      calls++;
      throw new Error('http://secret-proxy/?key=private 48.123456');
    }));
    for (let i = 0; i < 2; i++) await assert.rejects(service.search('Park'), (error: Error) => !/private|secret|48\.123456/.test(error.message));
    assert.equal(calls, 2);
    assert.deepEqual(await all(db, 'SELECT * FROM drive_geocode_cache'), []);
  } finally { await close(db); }
});

test('OSRM coordinate order, full street geometry, exact dedup and memory-only TTL', async () => {
  const db = new sqlite3.Database(':memory:');
  await migrateDriveGeocodeCache(db);
  let calls = 0;
  let now = 100;
  try {
    const service = new DriveServices(db, config(), mockFetch(async (url) => {
      calls++;
      assert.equal(url.pathname, '/base/route/v1/driving/11.987654,48.123456;12,49');
      assert.equal(url.searchParams.get('overview'), 'full');
      assert.equal(url.searchParams.get('geometries'), 'geojson');
      assert.equal(url.searchParams.get('steps'), 'false');
      assert.equal(url.searchParams.get('alternatives'), 'false');
      assert.equal(url.searchParams.get('radiuses'), '1000;1000');
      return response(osrm);
    }), () => now);
    const first = service.route(origin, destination);
    assert.equal(first, service.route(origin, destination));
    assert.deepEqual(await first, { coordinates: [[11.9, 48.1], [12, 49]], distance_m: 123, duration_s: 45, origin, destination, provider: 'osrm', updated_at: 100 });
    now = 30099;
    assert.equal((await service.route(origin, destination)).updated_at, 100);
    assert.equal(calls, 1);
    now = 30100;
    assert.equal((await service.route(origin, destination)).updated_at, 30100);
    assert.equal(calls, 2);
    assert.deepEqual(await all(db, 'SELECT * FROM drive_geocode_cache'), []);
    const disabled = new DriveServices(db, { ...config(), osrmUrl: '' }, mockFetch(async () => { throw new Error('must not fetch'); }));
    assert.throws(() => disabled.route(origin, destination), /disabled.*DRIVE_OSRM_URL/);
  } finally { await close(db); }
});

test('OSRM validates every coordinate/metric and handles NoRoute/NoSegment without raw errors', async () => {
  assert.throws(() => parseOsrm({ code: 'NoRoute', message: 'private' }, origin, destination), /No street route/);
  assert.throws(() => parseOsrm({ code: 'NoSegment', message: 'private' }, origin, destination), /No routable road/);
  for (const coordinates of [[], [[1, 2]], [[1, 2], ['3', 4]], [[1, 2], [181, 2]], [[1, 2], [3, Infinity]], Array(50001).fill([1, 2])]) {
    assert.throws(() => parseOsrm({ code: 'Ok', routes: [{ ...osrm.routes[0], geometry: { type: 'LineString', coordinates } }] }, origin, destination));
  }
  for (const metrics of [{ distance: -1 }, { duration: NaN }, { distance: '123' }, { duration: Infinity }]) {
    assert.throws(() => parseOsrm({ code: 'Ok', routes: [{ ...osrm.routes[0], ...metrics }] }, origin, destination));
  }
  assert.throws(() => parseOsrm({ code: 'Ok', routes: [{ ...osrm.routes[0], geometry: { type: 'Point', coordinates: [[1, 2], [3, 4]] } }] }, origin, destination));
  const db = new sqlite3.Database(':memory:');
  try {
    const service = new DriveServices(db, config(), mockFetch(async () => response({ code: 'NoSegment', message: 'secret coordinates' }, 400)));
    await assert.rejects(service.route(origin, destination), /No routable road/);
  } finally { await close(db); }
});

test('provider pacing, serial concurrency, queue capacity and maximum wait', async () => {
  const queue = new ProviderQueue(2, 4000);
  const starts: number[] = [];
  let active = 0;
  const job = async () => { starts.push(Date.now()); assert.equal(++active, 1); await new Promise((resolve) => setTimeout(resolve, 10)); active--; };
  await Promise.all([queue.submit(job), queue.submit(job), queue.submit(job)]);
  assert.ok(starts[1] - starts[0] >= 1000);
  assert.ok(starts[2] - starts[1] >= 1000);
  const blocked = new ProviderQueue(1, 20);
  let release!: () => void;
  const first = blocked.submit(() => new Promise<void>((resolve) => { release = resolve; }));
  const waiting = blocked.submit(async () => {});
  await assert.rejects(blocked.submit(async () => {}), /busy/);
  await assert.rejects(waiting, /queue timed out/);
  release();
  await first;
});

test('HTTP errors, oversized responses, and fetch timeout remain generic', async (t) => {
  const db = new sqlite3.Database(':memory:');
  try {
    const httpError = new DriveServices(db, config(), mockFetch(async () => response({ message: 'secret' }, 503)));
    await assert.rejects(httpError.route(origin, destination), /provider unavailable/);
    const oversized = new DriveServices(db, config(), mockFetch(async () => new Response('x'.repeat(4194305))));
    await assert.rejects(oversized.route(origin, destination), /response limits/);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timeout = new DriveServices(db, config(), mockFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('private URL and GPS')));
    })));
    const work = timeout.route(origin, destination);
    const check = assert.rejects(work, /timed out/);
    t.mock.timers.tick(15001);
    await check;
    t.mock.timers.reset();
  } finally { await close(db); }
});

test('OSRM dispatch chooses never-updated then oldest successful driver, not frequent requesters or cache hits', async (t) => {
  const db = new sqlite3.Database(':memory:');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const starts: { latitude: number; time: number }[] = [];
  const points = { A: { latitude: 1, longitude: 1 }, B: { latitude: 2, longitude: 2 }, C: { latitude: 3, longitude: 3 }, D: { latitude: 4, longitude: 4 } };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const context = (userId: keyof typeof points) => ({ channelId: 'drive', userId, resolveOrigin: async () => points[userId] });
  try {
    const service = new DriveServices(db, config(), mockFetch(async (url) => {
      const latitude = Number(url.pathname.split('/').at(-1)!.split(';')[0].split(',')[1]);
      starts.push({ latitude, time: Date.now() });
      if (latitude === 3) await gate;
      return response(osrm);
    }));
    const b = await service.route(points.B, destination, context('B'));
    t.mock.timers.tick(1000);
    await service.route(points.A, destination, context('A'));
    t.mock.timers.tick(1000);
    for (let i = 0; i < 3; i++) assert.equal((await service.route(points.B, destination, context('B'))).updated_at, b.updated_at);
    const blocker = service.route(points.C, destination, context('C'));
    await flush();
    points.A = { latitude: 1.1, longitude: 1 };
    points.B = { latitude: 2.1, longitude: 2 };
    const a = service.route(points.A, destination, context('A'));
    points.A = { latitude: 1.2, longitude: 1 };
    assert.equal(a, service.route(points.A, destination, context('A')));
    points.A = { latitude: 1.3, longitude: 1 };
    assert.equal(a, service.route(points.A, destination, context('A')));
    const old = service.route(points.B, destination, context('B'));
    const never = service.route(points.D, destination, context('D'));
    t.mock.timers.tick(1000);
    release();
    assert.equal((await blocker).updated_at, 103000); // Upstream completion, not start at 102000.
    await never;
    t.mock.timers.tick(1000);
    const refreshedB = await old;
    t.mock.timers.tick(1000);
    const refreshedA = await a;
    assert.deepEqual(starts.map((entry) => entry.latitude), [2, 1, 3, 4, 2.1, 1.3]);
    assert.equal(refreshedB.updated_at, 104000);
    assert.equal(refreshedA.updated_at, 105000);
    assert.equal(refreshedA.origin.latitude, 1.3);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i].time - starts[i - 1].time >= 1000);
  } finally { t.mock.timers.reset(); await close(db); }
});

test('OSRM actual fetch starts remain one second apart after delayed dispatch checks and burst callers', async (t) => {
  const db = new sqlite3.Database(':memory:');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 200000 });
  const starts: number[] = [];
  try {
    const service = new DriveServices(db, config(), mockFetch(async () => { starts.push(Date.now()); return response(osrm); }));
    const first = service.route(origin, destination, { channelId: 'drive', userId: 'first', resolveOrigin: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return origin;
    } });
    const secondOrigin = { ...origin, latitude: 47 };
    const secondContext = { channelId: 'drive', userId: 'second', resolveOrigin: async () => secondOrigin };
    const second = service.route(secondOrigin, destination, secondContext);
    for (let i = 0; i < 4; i++) assert.equal(second, service.route(secondOrigin, destination, { ...secondContext }));
    t.mock.timers.tick(600);
    await first;
    assert.deepEqual(starts, [200600]);
    t.mock.timers.tick(999);
    await flush();
    assert.equal(starts.length, 1);
    t.mock.timers.tick(1);
    await second;
    assert.deepEqual(starts, [200600, 201600]);
  } finally { t.mock.timers.reset(); await close(db); }
});

test('coalesced dispatch skips inactive requesters and bounds an abandoned origin lookup deadline', async (t) => {
  const db = new sqlite3.Database(':memory:');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 300000 });
  let calls = 0;
  try {
    const service = new DriveServices(db, config(), mockFetch(async () => { calls++; return response(osrm); }));
    await service.route({ ...origin, latitude: 1 }, destination);
    const inactive = service.route(origin, destination, { channelId: 'drive', userId: 'driver', resolveOrigin: async () => null });
    const active = service.route(origin, destination, { channelId: 'drive', userId: 'driver', resolveOrigin: async () => ({ ...origin, latitude: 48.2 }) });
    assert.equal(inactive, active);
    t.mock.timers.tick(1000);
    assert.equal((await active).origin.latitude, 48.2);
    assert.equal(calls, 2);
    const stalled = service.route(origin, destination, { channelId: 'drive', userId: 'stalled', resolveOrigin: () => new Promise(() => {}) });
    const check = assert.rejects(stalled, /request timed out/);
    t.mock.timers.tick(1000);
    await flush();
    t.mock.timers.tick(54000);
    await check;
    assert.equal(calls, 2);
  } finally { t.mock.timers.reset(); await close(db); }
});
