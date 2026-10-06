import assert from 'node:assert/strict';
import test from 'node:test';
import { DriveParticipants } from '../src/ws/drive';
import type { ClientConnection } from '../src/ws/connectionManager';
import { DriveServices, readDriveConfig, type StreetRoute } from '../src/driveServices';
import type sqlite3 from 'sqlite3';

// Navigation handler tests never open the persisted database or call a live provider.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { channelsSchemaReady: Promise.resolve() } } as NodeModule;
const modelPath = require.resolve('../src/models');
require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: { getChannelById: async () => undefined } } as NodeModule;
const { createDriveNavigationHandler } = require('../src/ws/driveNavigation') as typeof import('../src/ws/driveNavigation');

const makeClient = (userId?: string) => {
  const messages: any[] = [];
  const client = { userId, identityVersion: 1, isAlive: true, ws: { readyState: 1, send: (data: string) => messages.push(JSON.parse(data)) } } as unknown as ClientConnection;
  return { client, messages };
};
const payload = { request_id: 'request', channel_id: 'drive', user_id: 'driver', destination: { latitude: 49, longitude: 12 } };
const goal = { ...payload.destination, label: 'Park' };
const search = { request_id: 'search', channel_id: 'drive', query: '  Central  Park  ' };
const point = { latitude: 48.123456, longitude: 11.987654, accuracy: 3 };
const streetRoute: StreetRoute = { coordinates: [[11.987654, 48.123456], [12, 49]], origin: { latitude: point.latitude, longitude: point.longitude }, destination: payload.destination, distance_m: 100, duration_s: 30, provider: 'osrm', updated_at: 1000 };
function fixture(ready = Promise.resolve()) {
  const participants = new DriveParticipants();
  let exists = true;
  let searches = 0;
  let routes = 0;
  const services = {
    search: async (query: unknown) => { searches++; assert.equal(query, 'Central Park'); return [{ latitude: 49, longitude: 12, label: 'Park' }]; },
    route: async (origin: unknown, destination: unknown) => { routes++; assert.deepEqual(origin, { ...point, speed: null, updated_at: 1000 }); assert.deepEqual(destination, payload.destination); return streetRoute; }
  };
  const handler = createDriveNavigationHandler({ ready, participants, channel: async () => exists ? { type: 'drive' } : undefined, services: () => services });
  return { participants, services, handler, removeChannel: () => { exists = false; }, counts: () => ({ searches, routes }) };
}

test('authenticated search before join, socket-only frozen responses, and route ownership/current shared origin', async () => {
  const f = fixture();
  const requester = makeClient('requester');
  const driver = makeClient('driver');
  const tab = makeClient('requester');
  await f.handler(requester.client, 'drive_search_destinations', search);
  assert.deepEqual(requester.messages.at(-1), { type: 'drive_destinations', payload: { request_id: 'search', channel_id: 'drive', destinations: [{ latitude: 49, longitude: 12, label: 'Park' }] } });
  f.participants.admit('drive', requester.client);
  f.participants.admit('drive', driver.client);
  f.participants.update('drive', driver.client, point, 1000);
  f.participants.setDestination('drive', requester.client, goal, 1000);
  requester.messages.length = driver.messages.length = 0;
  await f.handler(tab.client, 'drive_get_route', payload);
  assert.equal(tab.messages.at(-1).type, 'drive_route');
  assert.match(tab.messages.at(-1).payload.error, /Join/);
  assert.equal(f.counts().routes, 0);
  // Supplied origins and spoofed metadata are ignored; only source GPS in the same channel is used.
  await f.handler(requester.client, 'drive_get_route', { ...payload, origin: { latitude: 1, longitude: 2 } });
  assert.deepEqual(requester.messages.at(-1), { type: 'drive_route', payload: { request_id: 'request', channel_id: 'drive', user_id: 'driver', route: streetRoute } });
  assert.equal(driver.messages.length, 0);
  assert.equal(tab.messages.length, 1);
  const outsider = makeClient('outsider');
  f.participants.admit('elsewhere', outsider.client);
  f.participants.update('elsewhere', outsider.client, point, 1000);
  const viewer = makeClient('viewer');
  f.participants.admit('drive', viewer.client);
  await f.handler(viewer.client, 'drive_get_route', { ...payload, user_id: 'outsider' });
  assert.match(viewer.messages.at(-1).payload.error, /sharing location/);
});

test('handled validation/auth/channel/provider errors keep frozen events and leak no GPS/URLs', async () => {
  const f = fixture();
  for (const invalid of [null, {}, { ...payload, request_id: {} }, { ...payload, channel_id: 12 }, { ...payload, user_id: [] },
    { ...payload, request_id: 'x'.repeat(129) }, { ...payload, destination: { latitude: '48', longitude: 12 } },
    { ...payload, destination: { latitude: Infinity, longitude: 12 } }, { ...payload, destination: { latitude: 91, longitude: 12 } }]) {
    const requester = makeClient('requester');
    await f.handler(requester.client, 'drive_get_route', invalid);
    assert.equal(requester.messages.at(-1).type, 'drive_route');
    assert.equal(typeof requester.messages.at(-1).payload.error, 'string');
  }
  for (const query of ['', 'a', {}, 'x'.repeat(251)]) {
    const requester = makeClient('requester');
    await f.handler(requester.client, 'drive_search_destinations', { ...search, query });
    assert.equal(requester.messages.at(-1).type, 'drive_destinations');
    assert.deepEqual(requester.messages.at(-1).payload.destinations, []);
    assert.equal(typeof requester.messages.at(-1).payload.error, 'string');
  }
  const anonymous = makeClient();
  await f.handler(anonymous.client, 'drive_search_destinations', search);
  assert.match(anonymous.messages.at(-1).payload.error, /Authentication/);
  const closed = makeClient('closed');
  closed.client.ws.readyState = 3;
  await f.handler(closed.client, 'drive_search_destinations', search);
  assert.equal(closed.messages.length, 0);
  const requester = makeClient('requester');
  f.services.search = async () => { throw new Error('secret-proxy?key=private latitude=48.123456'); };
  await f.handler(requester.client, 'drive_search_destinations', search);
  assert.deepEqual(requester.messages.at(-1), { type: 'drive_destinations', payload: { request_id: 'search', channel_id: 'drive', destinations: [], error: 'Drive request failed. Please try again later.' } });
  f.removeChannel();
  const another = makeClient('another');
  await f.handler(another.client, 'drive_search_destinations', search);
  assert.match(another.messages.at(-1).payload.error, /not found/);
  assert.equal(f.counts().routes, 0);
});

test('navigation requests cannot pass the startup readiness barrier', async () => {
  let release!: () => void;
  const f = fixture(new Promise<void>((resolve) => { release = resolve; }));
  const requester = makeClient('requester');
  const work = f.handler(requester.client, 'drive_search_destinations', search);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.counts().searches, 0);
  assert.equal(requester.messages.length, 0);
  release();
  await work;
  assert.equal(f.counts().searches, 1);
});

test('stale route completion after leave/rejoin, GPS clear/re-share, relogin, deletion or disconnect never sends geometry', async () => {
  for (const action of ['leave', 'rejoin', 'clear', 'clear-reshare', 'driver-leave', 'relogin', 'delete', 'disconnect', 'destination-change', 'destination-clear', 'destination-reset']) {
    const f = fixture();
    const requester = makeClient('requester');
    const driver = makeClient('driver');
    f.participants.admit('drive', requester.client);
    f.participants.admit('drive', driver.client);
    f.participants.update('drive', driver.client, point, 1000);
    f.participants.setDestination('drive', requester.client, goal, 1000);
    requester.messages.length = driver.messages.length = 0;
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    f.services.route = async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return streetRoute; };
    const work = f.handler(requester.client, 'drive_get_route', payload);
    await start;
    if (action === 'leave' || action === 'rejoin') f.participants.leave('drive', requester.client);
    if (action === 'rejoin') f.participants.admit('drive', requester.client);
    if (action === 'clear' || action === 'clear-reshare') f.participants.update('drive', driver.client, null);
    if (action === 'clear-reshare') f.participants.update('drive', driver.client, point, 2000);
    if (action === 'driver-leave') f.participants.leave('drive', driver.client);
    if (action === 'destination-change') f.participants.setDestination('drive', requester.client, { ...goal, longitude: 13 }, 2000);
    if (action === 'destination-clear' || action === 'destination-reset') f.participants.setDestination('drive', requester.client, null, 2000);
    if (action === 'destination-reset') f.participants.setDestination('drive', requester.client, goal, 2000);
    if (action === 'relogin') requester.client.identityVersion!++;
    if (action === 'delete') f.removeChannel();
    if (action === 'disconnect') requester.client.ws.readyState = 3;
    release();
    await work;
    const responses = requester.messages.filter((message) => message.type === 'drive_route');
    assert.ok(!responses.some((message) => message.payload.route), action);
    assert.ok(!JSON.stringify(responses).includes(String(point.latitude)), action);
    assert.equal(driver.messages.filter((message) => message.type === 'drive_route').length, 0);
  }
});

test('ordinary GPS updates do not starve queued routes; origin remains the server-derived fix', async () => {
  const f = fixture();
  const requester = makeClient('requester');
  const driver = makeClient('driver');
  f.participants.admit('drive', requester.client);
  f.participants.admit('drive', driver.client);
  f.participants.update('drive', driver.client, point, 1000);
  f.participants.setDestination('drive', requester.client, goal, 1000);
  let release!: () => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.services.route = async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return streetRoute; };
  const work = f.handler(requester.client, 'drive_get_route', payload);
  await start;
  f.participants.update('drive', driver.client, { ...point, latitude: 48.2 }, 2000);
  release();
  await work;
  assert.deepEqual(requester.messages.at(-1).payload.route.origin, streetRoute.origin);
});

test('search completion is suppressed on relogin and channel deletion', async () => {
  for (const action of ['relogin', 'delete']) {
    const f = fixture();
    const requester = makeClient('requester');
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    f.services.search = async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return [{ latitude: 49, longitude: 12, label: 'Park' }]; };
    const work = f.handler(requester.client, 'drive_search_destinations', search);
    await start;
    if (action === 'relogin') requester.client.userId = 'new-user';
    else f.removeChannel();
    release();
    await work;
    if (action === 'relogin') assert.equal(requester.messages.length, 0);
    else assert.deepEqual(requester.messages.at(-1).payload.destinations, []);
  }
});

test('per-connection request rate limits include cached hits, and global outstanding jobs are bounded', async (t) => {
  const f = fixture();
  const requester = makeClient('requester');
  await f.handler(requester.client, 'drive_search_destinations', search);
  await f.handler(requester.client, 'drive_search_destinations', { ...search, request_id: 'limited' });
  assert.equal(requester.messages.at(-1).payload.request_id, 'limited');
  assert.match(requester.messages.at(-1).payload.error, /rate limit/);
  assert.equal(f.counts().searches, 1);
  const driver = makeClient('driver');
  f.participants.admit('drive', requester.client);
  f.participants.admit('drive', driver.client);
  f.participants.update('drive', driver.client, point, 1000);
  f.participants.setDestination('drive', requester.client, goal, 1000);
  await f.handler(requester.client, 'drive_get_route', payload);
  await f.handler(requester.client, 'drive_get_route', { ...payload, request_id: 'route-limited' });
  assert.match(requester.messages.at(-1).payload.error, /rate limit/);
  assert.equal(f.counts().routes, 1);
  let release!: () => void;
  const blocked = fixture(new Promise<void>((resolve) => { release = resolve; }));
  const work = Array.from({ length: 128 }, (_, i) => blocked.handler(makeClient(`user-${i}`).client, 'drive_search_destinations', search));
  const overflow = makeClient('overflow');
  await blocked.handler(overflow.client, 'drive_search_destinations', search);
  assert.match(overflow.messages.at(-1).payload.error, /outstanding/);
  assert.equal(blocked.counts().searches, 0);
  release();
  await Promise.all(work);
});

test('one socket can have at most four outstanding navigation requests', async (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  let release!: () => void;
  const f = fixture(new Promise<void>((resolve) => { release = resolve; }));
  const requester = makeClient('requester');
  const pending: Promise<void>[] = [];
  for (let i = 0; i < 4; i++) {
    now += 1000;
    pending.push(f.handler(requester.client, 'drive_search_destinations', { ...search, request_id: String(i) }));
  }
  now += 1000;
  await f.handler(requester.client, 'drive_search_destinations', { ...search, request_id: 'overflow' });
  assert.match(requester.messages.at(-1).payload.error, /outstanding/);
  assert.equal(f.counts().searches, 0);
  release();
  await Promise.all(pending);
  now += 1000;
  await f.handler(requester.client, 'drive_search_destinations', { ...search, request_id: 'next' });
  assert.equal(requester.messages.at(-1).payload.request_id, 'next');
  assert.equal(requester.messages.at(-1).payload.error, undefined);
});

test('multiple viewers coalesce a driver route, dispatch latest GPS, and preserve private socket replies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const participants = new DriveParticipants();
  const first = makeClient('first');
  const second = makeClient('second');
  const driver = makeClient('driver');
  for (const { client } of [first, second, driver]) participants.admit('drive', client);
  participants.update('drive', driver.client, point, 1000);
  participants.setDestination('drive', first.client, goal, 1000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const urls: URL[] = [];
  const service = new DriveServices({} as sqlite3.Database, readDriveConfig({}), (async (url: URL) => {
    urls.push(url);
    if (urls.length === 1) await gate;
    return new Response(JSON.stringify({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[11, 48], [12, 49]] }, distance: 100, duration: 30 }] }));
  }) as unknown as typeof fetch);
  const handler = createDriveNavigationHandler({ ready: Promise.resolve(), participants, channel: async () => ({ type: 'drive' }), services: () => service });
  const blocker = service.route({ latitude: 1, longitude: 1 }, payload.destination);
  const a = handler(first.client, 'drive_get_route', { ...payload, request_id: 'a' });
  const b = handler(second.client, 'drive_get_route', { ...payload, request_id: 'b' });
  await new Promise((resolve) => setImmediate(resolve));
  participants.update('drive', driver.client, { ...point, latitude: 48.2 }, 2000);
  participants.leave('drive', first.client);
  release();
  await blocker;
  t.mock.timers.tick(1000);
  await Promise.all([a, b]);
  assert.equal(urls.length, 2);
  assert.match(urls[1].pathname, /11\.987654,48\.2;12,49$/);
  const result = second.messages.find((message) => message.type === 'drive_route');
  assert.equal(result.payload.request_id, 'b');
  assert.equal(result.payload.user_id, 'driver');
  assert.equal(result.payload.route.origin.latitude, 48.2);
  assert.equal(result.payload.route.updated_at, 101000);
  assert.ok(!first.messages.some((message) => message.type === 'drive_route' && message.payload.route));
  assert.ok(!driver.messages.some((message) => message.type === 'drive_route'));
  assert.ok(!JSON.stringify(first.messages.filter((message) => message.type === 'drive_route')).includes('48.2'));
});

test('queued route privacy rechecks prevent upstream GPS transmission after invalidation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 200000 });
  for (const action of ['leave', 'rejoin', 'clear', 'clear-reshare', 'relogin', 'delete', 'disconnect', 'destination-change', 'destination-clear', 'destination-reset']) {
    const participants = new DriveParticipants();
    const requester = makeClient('requester');
    const driver = makeClient('driver');
    participants.admit('drive', requester.client);
    participants.admit('drive', driver.client);
    participants.update('drive', driver.client, point, 1000);
    participants.setDestination('drive', requester.client, goal, 1000);
    let exists = true;
    let calls = 0;
    const service = new DriveServices({} as sqlite3.Database, readDriveConfig({}), (async () => {
      calls++;
      return new Response(JSON.stringify({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[11, 48], [12, 49]] }, distance: 100, duration: 30 }] }));
    }) as typeof fetch);
    const handler = createDriveNavigationHandler({ ready: Promise.resolve(), participants, channel: async () => exists ? { type: 'drive' } : undefined, services: () => service });
    await service.route({ latitude: 1, longitude: 1 }, payload.destination);
    const work = handler(requester.client, 'drive_get_route', payload);
    await new Promise((resolve) => setImmediate(resolve));
    if (action === 'leave' || action === 'rejoin') participants.leave('drive', requester.client);
    if (action === 'rejoin') participants.admit('drive', requester.client);
    if (action === 'clear' || action === 'clear-reshare') participants.update('drive', driver.client, null);
    if (action === 'clear-reshare') participants.update('drive', driver.client, point, 2000);
    if (action === 'destination-change') participants.setDestination('drive', requester.client, { ...goal, longitude: 13 }, 2000);
    if (action === 'destination-clear' || action === 'destination-reset') participants.setDestination('drive', requester.client, null, 2000);
    if (action === 'destination-reset') participants.setDestination('drive', requester.client, goal, 2000);
    if (action === 'relogin') requester.client.identityVersion!++;
    if (action === 'delete') exists = false;
    if (action === 'disconnect') requester.client.ws.readyState = 3;
    t.mock.timers.tick(1000);
    await work;
    assert.equal(calls, 1, action);
    const responses = requester.messages.filter((message) => message.type === 'drive_route');
    assert.ok(!responses.some((message) => message.payload.route), action);
    assert.ok(!JSON.stringify(responses).includes(String(point.latitude)), action);
  }
});

test('route handling rate limit is hard one second including cached responses', async (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  const requester = makeClient('requester');
  const driver = makeClient('driver');
  f.participants.admit('drive', requester.client);
  f.participants.admit('drive', driver.client);
  f.participants.update('drive', driver.client, point, 1000);
  f.participants.setDestination('drive', requester.client, goal, 1000);
  await f.handler(requester.client, 'drive_get_route', payload);
  now += 999;
  await f.handler(requester.client, 'drive_get_route', payload);
  assert.match(requester.messages.at(-1).payload.error, /rate limit/);
  now++;
  await f.handler(requester.client, 'drive_get_route', payload);
  assert.equal(requester.messages.at(-1).payload.error, undefined);
  assert.equal(f.counts().routes, 2);
});

test('routes require the nonnull shared room goal; spoofed matchRoomTarget cannot bypass matching', async () => {
  for (const selected of [null, { ...goal, latitude: 50 }, goal]) {
    const f = fixture();
    const requester = makeClient('requester');
    const driver = makeClient('driver');
    f.participants.admit('drive', requester.client);
    f.participants.admit('drive', driver.client);
    f.participants.update('drive', driver.client, point, 1000);
    if (selected) f.participants.setDestination('drive', requester.client, selected, 1000);
    await f.handler(requester.client, 'drive_get_route', { ...payload, matchRoomTarget: false, origin: point });
    const response = requester.messages.at(-1).payload;
    if (selected === goal) {
      assert.equal(f.counts().routes, 1);
      assert.deepEqual(response.route, streetRoute);
    } else {
      assert.equal(f.counts().routes, 0);
      assert.match(response.error, /shared room destination/);
      assert.equal(response.route, undefined);
      assert.ok(!JSON.stringify(response).includes(String(point.latitude)));
    }
  }
});

test('personal routes accept an explicit start target without a shared room goal', async () => {
  const participants = new DriveParticipants();
  const targets: unknown[] = [];
  const services = {
    search: async () => [],
    route: async (_origin: unknown, destination: unknown) => {
      targets.push(destination);
      return { ...streetRoute, destination: destination as { latitude: number; longitude: number } };
    }
  };
  const handler = createDriveNavigationHandler({ ready: Promise.resolve(), participants, channel: async () => ({ type: 'drive' }), services: () => services });
  const requester = makeClient('requester');
  const driver = makeClient('driver');
  participants.admit('drive', requester.client);
  participants.admit('drive', driver.client);
  participants.update('drive', driver.client, point, 1000);
  const start = { latitude: 50, longitude: 8 };
  await handler(requester.client, 'drive_get_route', { request_id: 'personal', channel_id: 'drive', user_id: 'driver', destination: start, personal: true });
  const personal = requester.messages.at(-1).payload;
  assert.equal(personal.error, undefined);
  assert.deepEqual(targets, [start]);
  assert.deepEqual(personal.route.destination, start);
  // Without the personal flag the same target is rejected because it is not the room goal.
  const viewer = makeClient('viewer');
  participants.admit('drive', viewer.client);
  await handler(viewer.client, 'drive_get_route', { request_id: 'shared', channel_id: 'drive', user_id: 'driver', destination: start });
  assert.match(viewer.messages.at(-1).payload.error, /shared room destination/);
  assert.equal(targets.length, 1);
});
