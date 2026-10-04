import assert from 'node:assert/strict';
import test from 'node:test';
import { DriveParticipants, driveParticipants } from '../src/ws/drive';
import type { ClientConnection } from '../src/ws/connectionManager';
import { connectionManager } from '../src/ws/connectionManager';
import { rooms, getPeer, type Room } from '../src/mediasoup';

const makeClient = (userId: string) => {
  const messages: any[] = [];
  const client = { userId, isAlive: true, ws: { readyState: 1, send: (data: string) => messages.push(JSON.parse(data)), close: () => { Object.assign(client.ws, { readyState: 2 }); } } } as unknown as ClientConnection;
  return { client, messages };
};

test('room destination broadcasts do not reach a socket whose admitted identity changed', () => {
  const participants = new DriveParticipants();
  const owner = makeClient('owner');
  const receiver = makeClient('receiver');
  participants.admit('trip', owner.client);
  participants.admit('trip', receiver.client);
  receiver.client.userId = 'another-user';
  participants.setDestination('trip', owner.client, { latitude: 52, longitude: 13, label: 'Shared target' });
  assert.equal(owner.messages.at(-1).type, 'drive_destination_updated');
  participants.snapshot('trip', receiver.client);
  assert.equal(receiver.messages.length, 0);
});

test('GPS protocol, identity, privacy, validation, rate limiting and cleanup', () => {
  const drive = new DriveParticipants();
  const owner = makeClient('owner');
  const otherTab = makeClient('owner');
  const participant = makeClient('participant');
  drive.admit('drive', owner.client);
  drive.admit('drive', participant.client);
  assert.throws(() => drive.admit('drive', otherTab.client));
  assert.throws(() => drive.update('drive', otherTab.client, { latitude: 1, longitude: 2, accuracy: 3 }));
  drive.update('drive', owner.client, { latitude: 1, longitude: 2, accuracy: 3, user_id: 'spoof', updated_at: 0 }, 10000);
  assert.deepEqual(participant.messages.at(-1), {
    type: 'drive_location_updated',
    payload: { channel_id: 'drive', user_id: 'owner', location: { latitude: 1, longitude: 2, accuracy: 3, speed: null, updated_at: 10000 } }
  });
  assert.equal(otherTab.messages.length, 0);
  drive.snapshot('drive', participant.client);
  assert.equal(participant.messages.at(-1).type, 'drive_locations');
  assert.equal(participant.messages.at(-1).payload.destination, null);
  assert.equal(typeof participant.messages.at(-1).payload.generated_at, 'number');
  assert.deepEqual(participant.messages.at(-1).payload.locations, [{ user_id: 'owner', latitude: 1, longitude: 2, accuracy: 3, speed: null, updated_at: 10000 }]);
  for (const location of [undefined, [], {}, { latitude: '1', longitude: 2, accuracy: 3 },
    { latitude: NaN, longitude: 2, accuracy: 3 }, { latitude: 91, longitude: 2, accuracy: 3 },
    { latitude: 1, longitude: Infinity, accuracy: 3 }, { latitude: 1, longitude: 181, accuracy: 3 },
    { latitude: 1, longitude: 2, accuracy: -1 }, { latitude: 1, longitude: 2, accuracy: Infinity },
    ...[-1, Infinity, NaN, 'fast', 401].map((speed) => ({ latitude: 1, longitude: 2, accuracy: 3, speed }))]) {
    assert.throws(() => drive.update('drive', owner.client, location, 12000));
  }
  assert.throws(() => drive.update('drive', owner.client, { latitude: 1, longitude: 2, accuracy: 3 }, 10500), /rate limit/);
  drive.update('drive', owner.client, null, 10500);
  assert.equal(participant.messages.at(-1).payload.location, null);
  const count = participant.messages.length;
  drive.update('drive', owner.client, null, 10500);
  assert.equal(participant.messages.length, count);
  drive.leave('drive', otherTab.client);
  assert.equal(drive.owns('drive', owner.client), true);
  drive.leave('drive', owner.client);
  assert.equal(participant.messages.at(-1).payload.location, null);
  assert.throws(() => drive.update('drive', owner.client, null));
  drive.removeChannel('drive');
  assert.equal(drive.hasChannel('drive'), false);
});

test('GPS relays speed in meters per second and snapshots retain it', () => {
  const drive = new DriveParticipants();
  const owner = makeClient('owner');
  const viewer = makeClient('viewer');
  drive.admit('trip', owner.client);
  drive.admit('trip', viewer.client);
  drive.update('trip', owner.client, { latitude: 1, longitude: 2, accuracy: 3, speed: 25 }, 10000);
  assert.equal(viewer.messages.at(-1).payload.location.speed, 25);
  drive.snapshot('trip', viewer.client);
  assert.equal(viewer.messages.at(-1).payload.locations[0].speed, 25);
  drive.update('trip', owner.client, { latitude: 1, longitude: 2, accuracy: 3, speed: 0 }, 10900);
  assert.equal(viewer.messages.at(-1).payload.location.speed, 0);
  drive.update('trip', owner.client, { latitude: 1, longitude: 2, accuracy: 3, speed: null }, 12000);
  assert.equal(viewer.messages.at(-1).payload.location.speed, null);
});

test('room destinations synchronize only socket-owned members and survive late joins without GPS sharing', () => {
  const drive = new DriveParticipants();
  const owner = makeClient('owner');
  const viewer = makeClient('viewer');
  const tab = makeClient('owner');
  const spectator = makeClient('spectator');
  const elsewhere = makeClient('elsewhere');
  drive.admit('trip', owner.client);
  drive.admit('trip', viewer.client);
  drive.admit('other', elsewhere.client);
  const value = { latitude: 49, longitude: 12, label: 'Park', user_id: 'spoof' };
  const stored = drive.setDestination('trip', owner.client, value, 1000);
  assert.notEqual(stored, value);
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Reflect.set(stored!, 'latitude', 1), false);
  value.latitude = 1;
  assert.equal(drive.destinationFor('trip', owner.client), stored);
  assert.equal(stored!.latitude, 49);
  assert.deepEqual(owner.messages.at(-1), { type: 'drive_destination_updated', payload: { channel_id: 'trip', destination: { latitude: 49, longitude: 12, label: 'Park' } } });
  assert.deepEqual(viewer.messages.at(-1), owner.messages.at(-1));
  for (const { client, messages } of [tab, spectator, elsewhere]) {
    assert.equal(drive.destinationFor('trip', client), null);
    assert.throws(() => drive.setDestination('trip', client, null), /Join/);
    drive.snapshot('trip', client);
    assert.equal(messages.length, 0);
  }
  const late = makeClient('late');
  drive.admit('trip', late.client);
  drive.snapshot('trip', late.client);
  assert.deepEqual(late.messages.at(-1).payload.destination, stored);
  assert.deepEqual(late.messages.at(-1).payload.locations, []);
  const count = owner.messages.length;
  assert.equal(drive.setDestination('trip', owner.client, { ...stored }, 1001), stored);
  assert.equal(owner.messages.length, count);
  assert.throws(() => drive.setDestination('trip', owner.client, { ...stored, label: 'Other' }, 1999), /rate limit/);
  assert.equal(drive.destinationFor('trip', viewer.client), stored);
  // Different participants have independent limits, even without sharing their GPS.
  const changed = drive.setDestination('trip', viewer.client, { ...stored, label: 'Other' }, 1001);
  assert.notEqual(changed, stored);
  drive.setDestination('trip', viewer.client, null, 1002);
  assert.deepEqual(owner.messages.at(-1), { type: 'drive_destination_updated', payload: { channel_id: 'trip', destination: null } });
  const clearedCount = owner.messages.length;
  drive.setDestination('trip', viewer.client, null, 1002);
  assert.equal(owner.messages.length, clearedCount);
  assert.throws(() => drive.setDestination('trip', viewer.client, value, 1002), /rate limit/);
  assert.equal(drive.destinationFor('trip', owner.client), null);
  drive.setDestination('trip', owner.client, { latitude: 49, longitude: 12, label: 'Park' }, 2000);
  assert.notEqual(drive.destinationFor('trip', owner.client), stored);
});

test('invalid destinations leave immutable room state unchanged and do not consume the set limit', () => {
  const drive = new DriveParticipants();
  const owner = makeClient('owner');
  drive.admit('trip', owner.client);
  const stored = drive.setDestination('trip', owner.client, { latitude: 49, longitude: 12, label: 'Park' }, 1000);
  const count = owner.messages.length;
  for (const value of [undefined, [], {}, { latitude: '49', longitude: 12, label: 'Park' },
    ...[NaN, Infinity, -91, 91].map((latitude) => ({ latitude, longitude: 12, label: 'Park' })),
    ...[NaN, Infinity, -181, 181].map((longitude) => ({ latitude: 49, longitude, label: 'Park' })),
    ...['', '   ', 'x'.repeat(501), 'Park\nAddress', 'Park\x00', 'Park\x7f', 'Park\x85', 1].map((label) => ({ latitude: 49, longitude: 12, label }))]) {
    assert.throws(() => drive.setDestination('trip', owner.client, value, 2000), /Invalid/);
    assert.equal(drive.destinationFor('trip', owner.client), stored);
    assert.equal(owner.messages.length, count);
  }
  for (const id of ['', 'a b', 'a\n', 'a\x00', 'a\x85', 'x'.repeat(129)]) {
    assert.throws(() => drive.setDestination(id, owner.client, null), /identifier/);
  }
  drive.setDestination('trip', owner.client, { latitude: -90, longitude: 180, label: 'x'.repeat(500) }, 2000);
  assert.equal(drive.destinationFor('trip', owner.client)!.label.length, 500);
});

test('destinations clear on empty room, a fresh session, and channel deletion', () => {
  const drive = new DriveParticipants();
  const owner = makeClient('owner');
  const viewer = makeClient('viewer');
  drive.admit('trip', owner.client);
  drive.admit('trip', viewer.client);
  const stored = drive.setDestination('trip', owner.client, { latitude: 49, longitude: 12, label: 'Park' }, 1000);
  drive.leave('trip', owner.client);
  assert.equal(drive.destinationFor('trip', viewer.client), stored);
  drive.leave('trip', viewer.client);
  assert.equal(drive.hasChannel('trip'), false);
  drive.admit('trip', owner.client);
  drive.snapshot('trip', owner.client);
  assert.equal(owner.messages.at(-1).payload.destination, null);
  drive.setDestination('trip', owner.client, { latitude: 49, longitude: 12, label: 'Park' }, 1001);
  drive.removeChannel('trip');
  assert.ok(owner.messages.some((message) => message.type === 'drive_destination_updated' && message.payload.destination === null));
  drive.admit('trip', owner.client);
  assert.equal(drive.destinationFor('trip', owner.client), null);
});

test('drive signaling rejects unrelated sockets and screen media while allowing camera video', async (t) => {
  t.mock.method(Date, 'now', () => 10000);
  // Isolate handlers from the persisted database and mediasoup worker.
  const modelPath = require.resolve('../src/models');
  const users = new Map(['owner', 'viewer'].map((id) => [id, { id, username: id, avatar_url: null }]));
  let server: { id: string } | undefined;
  let driveExists = true;
  let deleteDuringLookup = false;
  require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: {
    registerPersistedS3ConfigResolver: () => {},
    getChannelById: async (id: string) => id === 'drive' && driveExists ? { id, type: 'drive' } : { id, type: 'text' },
    getUserById: async (id: string) => {
      if (deleteDuringLookup) { driveExists = false; deleteDuringLookup = false; }
      return users.get(id);
    },
    getServerStorageSettings: async () => undefined,
    getServer: async () => server,
    getUserServerRoles: async (_serverId: string, userId: string) => [{ key: userId === 'viewer' ? 'admin' : 'user', position: userId === 'viewer' ? 10 : 0 }],
    createModerationAction: async () => {},
    createBanRule: async () => {},
    deleteChannel: async () => {}
  } } as NodeModule;
  const dbPath = require.resolve('../src/db');
  const leaderboardRows = [{
    id: 'run-1', track_id: 'track-1', user_id: 'driver', channel_id: 'drive', started_at: 1000,
    finished_at: 5000, next_gate: 3, gates_total: 3, gate_times_json: '[1000,3000,5000]',
    distance_m: 222, duration_ms: 4000, avg_speed_mps: 55.5, status: 'finished', updated_at: 5000
  }];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    dataDir: process.cwd(), channelsSchemaReady: Promise.resolve(),
    db: {
      all: (sql: string, params: unknown[], callback: (error: Error | null, rows: unknown[]) => void) => {
        assert.match(sql, /FROM drive_track_runs/);
        assert.deepEqual(params, ['track-1']);
        callback(null, leaderboardRows);
      },
      get: (_sql: string, _params: unknown[], callback: (error: Error | null, row?: unknown) => void) => callback(null),
      run: (_sql: string, _params: unknown[], callback: (error: Error | null) => void) => callback(null)
    }
  } } as NodeModule;
  const { handleMessage, handleClientDisconnect } = require('../src/ws/handlers') as typeof import('../src/ws/handlers');
  const owner = makeClient('owner');
  const tab = makeClient('owner');
  const viewer = makeClient('viewer');
  let produces = 0;
  let closes = 0;
  const room = { id: 'drive', router: { rtpCapabilities: {}, close: () => closes++ }, peers: new Map() } as unknown as Room;
  rooms.set('drive', room);
  const send = (client: ClientConnection, type: string, payload: any) => handleMessage(client, JSON.stringify({ type, payload }));
  const previousMessageCount = owner.messages.length;
  await send(owner.client, 'drive_track_leaderboard', { request_id: 'leaderboard-request', track_id: 'track-1' });
  assert.equal(owner.messages.length, previousMessageCount + 1);
  assert.deepEqual(owner.messages.at(-1), {
    type: 'drive_track_leaderboard',
    payload: {
      request_id: 'leaderboard-request', track_id: 'track-1',
      entries: [{ user_id: 'driver', run_id: 'run-1', duration_ms: 4000, avg_speed_mps: 55.5, distance_m: 222, finished_at: 5000 }]
    }
  });
  await send(owner.client, 'drive_search_destinations', { request_id: 'invalid-search', channel_id: 'drive', query: '' });
  assert.equal(owner.messages.at(-1).type, 'drive_destinations');
  assert.equal(owner.messages.at(-1).payload.request_id, 'invalid-search');
  assert.equal(typeof owner.messages.at(-1).payload.error, 'string');
  await send(owner.client, 'drive_get_route', { request_id: 'invalid-route', channel_id: 'drive', user_id: 'owner', destination: { latitude: '1', longitude: 2 } });
  assert.equal(owner.messages.at(-1).type, 'drive_route');
  assert.equal(owner.messages.at(-1).payload.request_id, 'invalid-route');
  assert.equal(typeof owner.messages.at(-1).payload.error, 'string');
  await send(owner.client, 'join_voice_channel', { channel_id: 'text' });
  assert.equal(rooms.has('text'), false);
  await send(owner.client, 'create_webrtc_transport', { channel_id: 'drive' });
  assert.equal(room.peers.size, 0);
  deleteDuringLookup = true;
  await send(owner.client, 'join_voice_channel', { channel_id: 'drive' });
  assert.equal(room.peers.size, 0);
  assert.equal(driveParticipants.owns('drive', owner.client), false);
  driveExists = true;
  await send(owner.client, 'join_voice_channel', { channel_id: 'drive' });
  await send(viewer.client, 'join_voice_channel', { channel_id: 'drive' });
  assert.equal(owner.messages.at(-1).type, 'drive_locations');
  await send(owner.client, 'auth:request', { publicKey: 'other-identity' });
  assert.equal(owner.messages.at(-1).type, 'error');
  const peer = getPeer(room, 'owner');
  const destination = { latitude: 49, longitude: 12, label: 'Park' };
  const setPayload = { request_id: 'select', channel_id: 'drive', destination, user_id: 'spoof' };
  const spectator = makeClient('spectator');
  for (const outsider of [tab, spectator, makeClient('')]) {
    await send(outsider.client, 'drive_set_destination', setPayload);
    assert.deepEqual(outsider.messages.at(-1), { type: 'drive_destination_set', payload: { request_id: 'select', channel_id: 'drive', error: 'Join the drive channel before selecting a destination' } });
  }
  const tabCount = tab.messages.length;
  const spectatorCount = spectator.messages.length;
  await send(owner.client, 'drive_set_destination', setPayload);
  assert.deepEqual(owner.messages.at(-1), { type: 'drive_destination_set', payload: { request_id: 'select', channel_id: 'drive', destination } });
  assert.deepEqual(owner.messages.at(-2), { type: 'drive_destination_updated', payload: { channel_id: 'drive', destination } });
  assert.deepEqual(viewer.messages.at(-1), owner.messages.at(-2));
  assert.equal(tab.messages.length, tabCount);
  assert.equal(spectator.messages.length, spectatorCount);
  const stored = driveParticipants.destinationFor('drive', owner.client);
  const broadcastCount = () => viewer.messages.filter((message) => message.type === 'drive_destination_updated').length;
  const count = broadcastCount();
  await send(owner.client, 'drive_set_destination', setPayload);
  assert.equal(broadcastCount(), count);
  assert.deepEqual(owner.messages.at(-1).payload, { request_id: 'select', channel_id: 'drive', destination });
  for (const invalid of [null, [], {}, { ...setPayload, request_id: '' }, { ...setPayload, request_id: 'bad id' },
    { ...setPayload, request_id: 'x'.repeat(129) }, { ...setPayload, channel_id: 'bad\nchannel' },
    { ...setPayload, destination: undefined }, { ...setPayload, destination: { ...destination, label: '' } },
    { ...setPayload, destination: { ...destination, latitude: 91 } }]) {
    await send(owner.client, 'drive_set_destination', invalid);
    assert.equal(owner.messages.at(-1).type, 'drive_destination_set');
    assert.equal(owner.messages.at(-1).payload.request_id, invalid && 'request_id' in invalid
      && typeof invalid.request_id === 'string' && invalid.request_id.length > 0 && invalid.request_id.length <= 128
      && !/\s/.test(invalid.request_id) ? invalid.request_id : null);
    assert.equal(typeof owner.messages.at(-1).payload.error, 'string');
    assert.equal('destination' in owner.messages.at(-1).payload, false);
    assert.equal(driveParticipants.destinationFor('drive', owner.client), stored);
  }
  await send(owner.client, 'drive_set_destination', { ...setPayload, request_id: 'limited', destination: { ...destination, label: 'Other' } });
  assert.match(owner.messages.at(-1).payload.error, /rate limit/);
  assert.equal(owner.messages.at(-1).payload.request_id, 'limited');
  room.peers.delete('owner');
  await send(owner.client, 'drive_set_destination', { ...setPayload, destination: null });
  assert.match(owner.messages.at(-1).payload.error, /Join/);
  room.peers.set('owner', peer);
  room.type = 'voice';
  await send(owner.client, 'drive_set_destination', { ...setPayload, destination: null });
  assert.match(owner.messages.at(-1).payload.error, /Join/);
  room.type = 'drive';
  assert.equal(driveParticipants.destinationFor('drive', owner.client), stored);
  // A joined member without a GPS fix can clear immediately; no upstream request is needed.
  await send(viewer.client, 'drive_set_destination', { ...setPayload, request_id: 'clear', destination: null });
  assert.deepEqual(viewer.messages.at(-1), { type: 'drive_destination_set', payload: { request_id: 'clear', channel_id: 'drive', destination: null } });
  assert.deepEqual(owner.messages.at(-1), { type: 'drive_destination_updated', payload: { channel_id: 'drive', destination: null } });
  const clearCount = broadcastCount();
  await send(viewer.client, 'drive_set_destination', { ...setPayload, request_id: 'clear-again', destination: null });
  assert.equal(broadcastCount(), clearCount);
  peer.transports.set('transport', { produce: async ({ kind }: { kind: string }) => { produces++; return { id: `producer-${produces}`, kind }; }, close: () => {} } as any);
  for (const kind of ['audio', 'video']) {
    await send(owner.client, 'produce', { channel_id: 'drive', transport_id: 'transport', kind, source: 'screen', request_id: kind });
    assert.equal(owner.messages.at(-1).type, 'error');
    assert.equal(owner.messages.at(-1).payload.request_id, kind);
  }
  for (const type of ['produce', 'consume', 'pause_consumer', 'resume_consumer', 'connect_webrtc_transport', 'create_webrtc_transport', 'close_producer', 'get_producers', 'voice_state_update']) {
    await send(tab.client, type, { channel_id: 'drive', transport_id: 'transport', request_id: type });
    assert.equal(tab.messages.at(-1).type, 'error');
    assert.equal(tab.messages.at(-1).payload.request_id, type);
  }
  assert.equal(produces, 0);
  await send(tab.client, 'join_voice_channel', { channel_id: 'drive' });
  assert.equal(tab.messages.at(-1).type, 'error');
  await send(tab.client, 'leave_voice_channel', { channel_id: 'drive' });
  handleClientDisconnect(tab.client);
  assert.equal(room.peers.get('owner'), peer);
  await send(tab.client, 'drive_location_update', { channel_id: 'drive', location: { latitude: 1, longitude: 2, accuracy: 3 } });
  assert.equal(tab.messages.at(-1).type, 'error');
  await send(owner.client, 'drive_location_update', { channel_id: 'drive', location: { latitude: 1, longitude: 2, accuracy: 3 } });
  assert.equal(viewer.messages.at(-1).type, 'drive_location_updated');
  await send(owner.client, 'produce', { channel_id: 'drive', transport_id: 'transport', kind: 'audio', source: 'mic', request_id: 'mic' });
  assert.equal(produces, 1);
  assert.equal(owner.messages.at(-1).type, 'produced');
  await send(owner.client, 'produce', { channel_id: 'drive', transport_id: 'transport', kind: 'video', source: 'camera', request_id: 'camera' });
  assert.equal(produces, 2);
  assert.equal(owner.messages.at(-1).type, 'produced');
  assert.equal(owner.messages.at(-1).payload.source, 'camera');
  let cameraConsumerPauses = 0;
  let cameraConsumerResumes = 0;
  peer.consumers.set('camera-consumer', {
    pause: async () => { cameraConsumerPauses++; },
    resume: async () => { cameraConsumerResumes++; }
  } as any);
  await send(owner.client, 'pause_consumer', { channel_id: 'drive', consumer_id: 'camera-consumer' });
  await send(owner.client, 'resume_consumer', { channel_id: 'drive', consumer_id: 'camera-consumer' });
  assert.equal(cameraConsumerPauses, 1);
  assert.equal(cameraConsumerResumes, 1);
  handleClientDisconnect(owner.client);
  assert.equal(room.peers.has('owner'), false);
  assert.equal(driveParticipants.owns('drive', owner.client), false);
  assert.equal(viewer.messages.at(-1).payload.location, null);
  await send(viewer.client, 'leave_voice_channel', { channel_id: 'drive' });
  assert.equal(rooms.has('drive'), false);
  assert.equal(driveParticipants.hasChannel('drive'), false);
  assert.equal(closes, 1);

  for (const action of ['kick_member', 'ban_member', 'delete_channel']) {
    // Cleanup must happen immediately, not depend on receiving a socket close event.
    Object.assign(owner.client.ws, { readyState: 1 });
    const nextRoom = { ...room, peers: new Map(), type: 'drive' } as Room;
    rooms.set('drive', nextRoom);
    getPeer(nextRoom, 'owner');
    getPeer(nextRoom, 'viewer');
    driveParticipants.admit('drive', owner.client);
    driveParticipants.admit('drive', viewer.client);
    driveParticipants.update('drive', owner.client, { latitude: 1, longitude: 2, accuracy: 3 });
    driveParticipants.setDestination('drive', owner.client, destination);
    connectionManager.getClients().add(owner.client);
    connectionManager.getClients().add(viewer.client);
    server = { id: 'server' };
    await send(viewer.client, action, action === 'delete_channel' ? { channel_id: 'drive' } : { targetUserId: 'owner' });
    assert.equal(driveParticipants.owns('drive', owner.client), false);
    if (action === 'delete_channel') assert.equal(driveParticipants.destinationFor('drive', viewer.client), null);
    assert.equal(nextRoom.peers.has('owner') && rooms.has('drive'), false);
    assert.ok(viewer.messages.some((message) => message.type === 'drive_location_updated' && message.payload.user_id === 'owner' && message.payload.location === null));
    driveParticipants.removeChannel('drive');
    rooms.delete('drive');
    connectionManager.getClients().delete(owner.client);
    connectionManager.getClients().delete(viewer.client);
  }
});
