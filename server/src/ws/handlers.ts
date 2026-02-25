import { ClientConnection, connectionManager } from './connectionManager';
import {
  createUser,
  getUserByPublicKey,
  createCategory,
  createChannel,
  deleteChannel,
  getChannelById,
  getCategories,
  getChannels,
  getChannelMessages,
  createMessage,
  getUserById,
  updateUserRole,
  getUsers
} from '../models';
import { getOrCreateRoom, getPeer, createWebRtcTransport, rooms } from '../mediasoup';
import crypto from 'node:crypto';
import { adminKey } from '../admin';

export const handleMessage = async (client: ClientConnection, messageStr: string) => {
  try {
    const message = JSON.parse(messageStr);
    const { type, payload } = message;
    console.log(`[WS DEBUG] Handling message type: ${type} for user: ${client.userId || 'unauthenticated'}`);

    switch (type) {
      case 'auth:request':
        await handleAuthRequest(client, payload);
        break;
      case 'auth:response':
        await handleAuthResponse(client, payload);
        break;
      case 'get_channels':
        await handleGetChannels(client);
        break;
      case 'create_channel':
        await handleCreateChannel(client, payload);
        break;
      case 'delete_channel':
        await handleDeleteChannel(client, payload);
        break;
      case 'get_messages':
        await handleGetMessages(client, payload);
        break;
      case 'send_message':
        await handleSendMessage(client, payload);
        break;
      case 'join_voice_channel':
        await handleJoinVoiceChannel(client, payload);
        break;
      case 'create_webrtc_transport':
        await handleCreateWebRtcTransport(client, payload);
        break;
      case 'connect_webrtc_transport':
        await handleConnectWebRtcTransport(client, payload);
        break;
      case 'produce':
        await handleProduce(client, payload);
        break;
      case 'consume':
        await handleConsume(client, payload);
        break;
      case 'resume_consumer':
        await handleResumeConsumer(client, payload);
        break;
      case 'leave_voice_channel':
        await handleLeaveVoiceChannel(client, payload);
        break;
      case 'get_producers':
        await handleGetProducers(client, payload);
        break;
      case 'submit_admin_key':
        await handleSubmitAdminKey(client, payload);
        break;
      case 'voice_state_update':
        await handleVoiceStateUpdate(client, payload);
        break;
      case 'ping':
        client.ws.send(JSON.stringify({ type: 'pong', payload: {} }));
        break;
      default:
        console.warn(`[WS DEBUG] Unknown message type: ${type}`);
    }
  } catch (error) {
    console.error('[WS DEBUG] Error handling message:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Internal server error' } }));
  }
};

const handleAuthRequest = async (client: ClientConnection, payload: { username: string, publicKey: string }) => {
  const { username, publicKey } = payload;
  if (!username || !publicKey) return;

  let user = await getUserByPublicKey(publicKey);
  if (!user) {
    user = await createUser(username, publicKey);
  }

  const challenge = crypto.randomBytes(32).toString('hex');
  client.challenge = challenge;
  client.pendingPublicKey = publicKey;

  client.ws.send(JSON.stringify({
    type: 'auth:challenge',
    payload: { challenge }
  }));
};

const handleAuthResponse = async (client: ClientConnection, payload: { signature: string }) => {
  const { signature } = payload;
  if (!signature || !client.challenge || !client.pendingPublicKey) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid authentication state' } }));
    return;
  }

  try {
    const isValid = crypto.verify(
      'SHA256',
      Buffer.from(client.challenge),
      {
        key: client.pendingPublicKey,
        format: 'pem',
        type: 'spki',
        dsaEncoding: 'ieee-p1363'
      },
      Buffer.from(signature, 'hex')
    );

    if (isValid) {
      const user = await getUserByPublicKey(client.pendingPublicKey);
      if (user) {
        connectionManager.setUserId(client, user.id);
        client.challenge = undefined;
        client.pendingPublicKey = undefined;

        client.ws.send(JSON.stringify({
          type: 'authenticated',
          payload: { user }
        }));

        // Send full member list to the newly authenticated user
        const allUsers = await getUsers();
        const onlineUserIds = connectionManager.getOnlineUserIds();
        client.ws.send(JSON.stringify({
          type: 'member_list',
          payload: {
            members: allUsers,
            onlineUserIds
          }
        }));

        // Broadcast to others that this user is online, if they weren't already
        if (!connectionManager.isUserOnline(user.id, client)) {
          connectionManager.broadcastToAuthenticated({
            type: 'user_online',
            payload: { user }
          });
        }
      } else {
        client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'User not found' } }));
      }
    } else {
      client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid signature' } }));
    }
  } catch (error) {
    console.error('Error verifying signature:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Authentication failed' } }));
  }
};

const handleGetChannels = async (client: ClientConnection) => {
  if (!client.userId) return;

  const categories = await getCategories();
  const channels = await getChannels();

  // Create default category and channel if none exist
  if (categories.length === 0 && channels.length === 0) {
    const category = await createCategory('Text Channels', 0);
    const channel = await createChannel(category.id, 'general', 'text', 0);
    categories.push(category);
    channels.push(channel);
  }

  client.ws.send(JSON.stringify({
    type: 'channels_list',
    payload: { categories, channels }
  }));

  const voiceParticipants: Record<string, any[]> = {};
  for (const [channelId, room] of rooms.entries()) {
    const users = [];
    for (const [userId, peer] of room.peers.entries()) {
      const user = await getUserById(userId);
      if (user) {
        users.push({ id: user.id, username: user.username, avatar_url: user.avatar_url, isMuted: peer.isMuted, isDeafened: peer.isDeafened });
      }
    }
    voiceParticipants[channelId] = users;
  }

  client.ws.send(JSON.stringify({
    type: 'voice_participants_list',
    payload: { participants: voiceParticipants }
  }));
};

const handleCreateChannel = async (client: ClientConnection, payload: { category_id: string | null, name: string, type: 'text' | 'voice' }) => {
  if (!client.userId) return;
  const { category_id, name, type } = payload;

  const normalizedName = (name || '').trim();
  if (!normalizedName) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Channel name is required' } }));
    return;
  }

  if (type !== 'text' && type !== 'voice') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid channel type' } }));
    return;
  }

  const user = await getUserById(client.userId);
  if (!user || user.role !== 'admin') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Only admins can create channels' } }));
    return;
  }

  try {
    const channel = await createChannel(category_id, normalizedName, type);

    // Broadcast to all authenticated users
    connectionManager.broadcastToAuthenticated({
      type: 'channel_created',
      payload: { channel }
    });
  } catch (error) {
    console.error('[WS DEBUG] Failed to create channel:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to create channel' } }));
  }
};

const handleDeleteChannel = async (client: ClientConnection, payload: { channel_id: string }) => {
  if (!client.userId) return;
  const { channel_id } = payload;

  if (!channel_id) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Channel ID is required' } }));
    return;
  }

  const user = await getUserById(client.userId);
  if (!user || user.role !== 'admin') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Only admins can delete channels' } }));
    return;
  }

  const channel = await getChannelById(channel_id);
  if (!channel) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Channel not found' } }));
    return;
  }

  try {
    await deleteChannel(channel_id);

    if (channel.type === 'voice') {
      const room = rooms.get(channel_id);
      if (room) {
        for (const peer of room.peers.values()) {
          for (const transport of peer.transports.values()) {
            transport.close();
          }
        }
        rooms.delete(channel_id);
      }
    }

    connectionManager.broadcastToAuthenticated({
      type: 'channel_deleted',
      payload: { channel_id }
    });
  } catch (error) {
    console.error('[WS DEBUG] Failed to delete channel:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to delete channel' } }));
  }
};

const handleGetMessages = async (client: ClientConnection, payload: { channel_id: string }) => {
  if (!client.userId) return;
  const { channel_id } = payload;
  if (!channel_id) return;

  // Ideally verify user has access to this channel's server
  const messages = await getChannelMessages(channel_id);

  client.ws.send(JSON.stringify({
    type: 'messages_list',
    payload: { channel_id, messages }
  }));
};

const handleSendMessage = async (client: ClientConnection, payload: { channel_id: string, content: string }) => {
  if (!client.userId) return;
  const { channel_id, content } = payload;
  if (!channel_id || !content) return;

  const message = await createMessage(channel_id, client.userId, content);
  const user = await getUserById(client.userId);
  
  const messageWithUser = {
    ...message,
    user
  };

  // Broadcast to all authenticated users (for simplicity, as requested)
  // A better approach would be to broadcast only to users in the server
  connectionManager.broadcastToAuthenticated({
    type: 'new_message',
    payload: { message: messageWithUser }
  });
};

export const handleClientDisconnect = (client: ClientConnection) => {
  if (!client.userId) return;

  for (const [channel_id, room] of rooms.entries()) {
    if (room.peers.has(client.userId)) {
      handleLeaveVoiceChannel(client, { channel_id }).catch(console.error);
    }
  }

  // Broadcast to others that this user is offline, only if they have no other active connections
  if (!connectionManager.isUserOnline(client.userId, client)) {
    connectionManager.broadcastToAuthenticated({
      type: 'user_offline',
      payload: { userId: client.userId }
    });
  }
};

const handleJoinVoiceChannel = async (client: ClientConnection, payload: { channel_id: string, isMuted?: boolean, isDeafened?: boolean }) => {
  if (!client.userId) return;
  const { channel_id, isMuted = false, isDeafened = false } = payload;
  if (!channel_id) return;

  const room = await getOrCreateRoom(channel_id);
  const peer = getPeer(room, client.userId);
  
  peer.isMuted = isMuted;
  peer.isDeafened = isDeafened;

  const user = await getUserById(client.userId);
  if (!user) return;

  // Notify all authenticated users
  connectionManager.broadcastToAuthenticated({
    type: 'user_joined_voice',
    payload: { 
      channel_id, 
      user: { id: user.id, username: user.username, avatar_url: user.avatar_url, isMuted: peer.isMuted, isDeafened: peer.isDeafened } 
    }
  });

  const users = [];
  for (const [userId, p] of room.peers.entries()) {
    const u = await getUserById(userId);
    if (u) {
      users.push({ id: u.id, username: u.username, avatar_url: u.avatar_url, isMuted: p.isMuted, isDeafened: p.isDeafened });
    }
  }

  client.ws.send(JSON.stringify({
    type: 'voice_channel_joined',
    payload: {
      channel_id,
      rtpCapabilities: room.router.rtpCapabilities,
      users
    }
  }));
};

const handleCreateWebRtcTransport = async (client: ClientConnection, payload: { channel_id: string, direction: 'send' | 'recv' }) => {
  if (!client.userId) return;
  const { channel_id, direction } = payload;
  
  const room = rooms.get(channel_id);
  if (!room) return;
  
  const peer = getPeer(room, client.userId);
  const transport = await createWebRtcTransport(room.router);
  
  peer.transports.set(transport.id, transport);

  client.ws.send(JSON.stringify({
    type: 'webrtc_transport_created',
    payload: {
      channel_id,
      direction,
      transportOptions: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      }
    }
  }));
};

const handleConnectWebRtcTransport = async (client: ClientConnection, payload: { channel_id: string, transport_id: string, dtlsParameters: any }) => {
  if (!client.userId) return;
  const { channel_id, transport_id, dtlsParameters } = payload;
  
  const room = rooms.get(channel_id);
  if (!room) return;
  
  const peer = getPeer(room, client.userId);
  const transport = peer.transports.get(transport_id);
  if (!transport) return;

  await transport.connect({ dtlsParameters });
  
  client.ws.send(JSON.stringify({
    type: 'webrtc_transport_connected',
    payload: { channel_id, transport_id }
  }));
};

const handleProduce = async (client: ClientConnection, payload: { channel_id: string, transport_id: string, kind: any, rtpParameters: any }) => {
  if (!client.userId) return;
  const { channel_id, transport_id, kind, rtpParameters } = payload;
  
  const room = rooms.get(channel_id);
  if (!room) return;
  
  const peer = getPeer(room, client.userId);
  const transport = peer.transports.get(transport_id);
  if (!transport) return;

  const producer = await transport.produce({ kind, rtpParameters });
  peer.producers.set(producer.id, producer);

  if (peer.isMuted || peer.isDeafened) {
    await producer.pause();
  }

  client.ws.send(JSON.stringify({
    type: 'produced',
    payload: { channel_id, id: producer.id }
  }));

  // Broadcast new producer to others
  for (const [otherPeerId] of room.peers) {
    if (otherPeerId !== client.userId) {
      connectionManager.sendToUser(otherPeerId, {
        type: 'new_producer',
        payload: {
          channel_id,
          producer_id: producer.id,
          user_id: client.userId
        }
      });
    }
  }
};

const handleConsume = async (client: ClientConnection, payload: { channel_id: string, transport_id: string, producer_id: string, rtpCapabilities: any }) => {
  if (!client.userId) return;
  const { channel_id, transport_id, producer_id, rtpCapabilities } = payload;
  
  const room = rooms.get(channel_id);
  if (!room) return;
  
  const peer = getPeer(room, client.userId);
  const transport = peer.transports.get(transport_id);
  if (!transport) return;

  if (!room.router.canConsume({ producerId: producer_id, rtpCapabilities })) {
    console.error('Cannot consume');
    return;
  }

  const consumer = await transport.consume({
    producerId: producer_id,
    rtpCapabilities,
    paused: true,
  });

  peer.consumers.set(consumer.id, consumer);

  client.ws.send(JSON.stringify({
    type: 'consumed',
    payload: {
      channel_id,
      producer_id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    }
  }));
};

const handleResumeConsumer = async (client: ClientConnection, payload: { channel_id: string, consumer_id: string }) => {
  if (!client.userId) return;
  const { channel_id, consumer_id } = payload;
  
  const room = rooms.get(channel_id);
  if (!room) return;
  
  const peer = getPeer(room, client.userId);
  const consumer = peer.consumers.get(consumer_id);
  if (!consumer) return;

  await consumer.resume();
};

const handleLeaveVoiceChannel = async (client: ClientConnection, payload: { channel_id: string }) => {
  if (!client.userId) return;
  const { channel_id } = payload;
  
  const room = rooms.get(channel_id);
  if (!room) return;
  
  const peer = room.peers.get(client.userId);
  if (peer) {
    for (const transport of peer.transports.values()) {
      transport.close();
    }
    room.peers.delete(client.userId);
  }

  // Notify all authenticated users
  connectionManager.broadcastToAuthenticated({
    type: 'user_left_voice',
    payload: { channel_id, user_id: client.userId }
  });

  if (room.peers.size === 0) {
    rooms.delete(channel_id);
  }
};

const handleGetProducers = async (client: ClientConnection, payload: { channel_id: string }) => {
  if (!client.userId) return;
  const { channel_id } = payload;
  
  const room = rooms.get(channel_id);
  if (!room) return;
  
  for (const [peerId, peer] of room.peers) {
    if (peerId !== client.userId) {
      for (const [producerId, producer] of peer.producers) {
        client.ws.send(JSON.stringify({
          type: 'new_producer',
          payload: {
            channel_id,
            producer_id: producerId,
            user_id: peerId
          }
        }));
      }
    }
  }
};

const handleSubmitAdminKey = async (client: ClientConnection, payload: { key: string }) => {
  if (!client.userId) return;
  const { key } = payload;

  if (key === adminKey) {
    await updateUserRole(client.userId, 'admin');
    const user = await getUserById(client.userId);
    client.ws.send(JSON.stringify({
      type: 'role_updated',
      payload: { role: 'admin', user }
    }));
    
    // Broadcast user update to all authenticated clients
    connectionManager.broadcastToAuthenticated({
      type: 'user_updated',
      payload: { user }
    });
  } else {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid admin key' } }));
  }
};

const handleVoiceStateUpdate = async (client: ClientConnection, payload: { channel_id: string, isMuted: boolean, isDeafened: boolean }) => {
  if (!client.userId) return;
  const { channel_id, isMuted, isDeafened } = payload;

  const room = rooms.get(channel_id);
  if (!room) return;

  const peer = room.peers.get(client.userId);
  if (peer) {
    peer.isMuted = isMuted;
    peer.isDeafened = isDeafened;

    for (const producer of peer.producers.values()) {
      if (isMuted || isDeafened) {
        await producer.pause();
      } else {
        await producer.resume();
      }
    }
  }

  // Broadcast to all authenticated users
  connectionManager.broadcastToAuthenticated({
    type: 'voice_state_updated',
    payload: {
      channel_id,
      user_id: client.userId,
      isMuted,
      isDeafened
    }
  });
};

