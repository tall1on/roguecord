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
    payload: { channel_id: 'drive', user_id: 'owner', location: { latitude: 1, longitude: 2, accuracy: 3, updated_at: 10000 } }
  });
  assert.equal(otherTab.messages.length, 0);
  drive.snapshot('drive', participant.client);
  assert.deepEqual(participant.messages.at(-1), {
    type: 'drive_locations', payload: { channel_id: 'drive', locations: [{ user_id: 'owner', latitude: 1, longitude: 2, accuracy: 3, updated_at: 10000 }] }
  });
  for (const location of [undefined, [], {}, { latitude: '1', longitude: 2, accuracy: 3 },
    { latitude: NaN, longitude: 2, accuracy: 3 }, { latitude: 91, longitude: 2, accuracy: 3 },
    { latitude: 1, longitude: Infinity, accuracy: 3 }, { latitude: 1, longitude: 181, accuracy: 3 },
    { latitude: 1, longitude: 2, accuracy: -1 }, { latitude: 1, longitude: 2, accuracy: Infinity }]) {
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

test('drive signaling rejects unrelated sockets and screen media before produce', async () => {
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
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { dataDir: process.cwd() } } as NodeModule;
  const { handleMessage, handleClientDisconnect } = require('../src/ws/handlers') as typeof import('../src/ws/handlers');
  const owner = makeClient('owner');
  const tab = makeClient('owner');
  const viewer = makeClient('viewer');
  let produces = 0;
  let closes = 0;
  const room = { id: 'drive', router: { rtpCapabilities: {}, close: () => closes++ }, peers: new Map() } as unknown as Room;
  rooms.set('drive', room);
  const send = (client: ClientConnection, type: string, payload: any) => handleMessage(client, JSON.stringify({ type, payload }));
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
  peer.transports.set('transport', { produce: async () => { produces++; return { id: 'producer', kind: 'audio' }; }, close: () => {} } as any);
  for (const kind of ['audio', 'video']) {
    await send(owner.client, 'produce', { channel_id: 'drive', transport_id: 'transport', kind, source: 'screen', request_id: kind });
    assert.equal(owner.messages.at(-1).type, 'error');
    assert.equal(owner.messages.at(-1).payload.request_id, kind);
  }
  for (const type of ['produce', 'consume', 'resume_consumer', 'connect_webrtc_transport', 'create_webrtc_transport', 'close_producer', 'get_producers', 'voice_state_update']) {
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
    connectionManager.getClients().add(owner.client);
    connectionManager.getClients().add(viewer.client);
    server = { id: 'server' };
    await send(viewer.client, action, action === 'delete_channel' ? { channel_id: 'drive' } : { targetUserId: 'owner' });
    assert.equal(driveParticipants.owns('drive', owner.client), false);
    assert.equal(nextRoom.peers.has('owner') && rooms.has('drive'), false);
    assert.ok(viewer.messages.some((message) => message.type === 'drive_location_updated' && message.payload.user_id === 'owner' && message.payload.location === null));
    driveParticipants.removeChannel('drive');
    rooms.delete('drive');
    connectionManager.getClients().delete(owner.client);
    connectionManager.getClients().delete(viewer.client);
  }
});
