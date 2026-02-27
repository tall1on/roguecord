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
  getOrCreateSystemUser,
  updateUserRole,
  getUsers,
  getServer,
  createServer,
  updateServerSettings,
  updateUserLastIp,
  getMatchingActiveBan,
  deleteMessagesByUser,
  createModerationAction,
  createBanRule,
  getPendingModerationActions,
  markModerationActionEnforced,
  MessageDeleteMode
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
      case 'close_producer':
        await handleCloseProducer(client, payload);
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
      case 'update_server_settings':
        await handleUpdateServerSettings(client, payload);
        break;
      case 'voice_state_update':
        await handleVoiceStateUpdate(client, payload);
        break;
      case 'CREATE_SERVER':
        await handleCreateServer(client, payload);
        break;
      case 'UPDATE_SERVER_SETTINGS':
        await handleUpdateServerSettingsUppercase(client, payload);
        break;
      case 'JOIN_SERVER':
        await handleJoinServer(client, payload);
        break;
      case 'kick_member':
        await handleKickMember(client, payload);
        break;
      case 'ban_member':
        await handleBanMember(client, payload);
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

  const normalizedIp = normalizeIp(client.ipAddress);
  const activeBan = await getMatchingActiveBan({
    targetPublicKey: publicKey,
    targetIp: normalizedIp
  });

  if (activeBan) {
    client.ws.send(JSON.stringify({
      type: 'auth:banned',
      payload: {
        reason: activeBan.reason || 'You are banned from this server.',
        blacklistIdentity: activeBan.blacklist_identity === 1,
        blacklistIp: activeBan.blacklist_ip === 1,
        targetIp: normalizedIp || null
      }
    }));
    return;
  }

  let user = await getUserByPublicKey(publicKey);
  let isNewUser = false;
  if (!user) {
    user = await createUser(username, publicKey);
    isNewUser = true;
  }

  const challenge = crypto.randomBytes(32).toString('hex');
  client.challenge = challenge;
  client.pendingPublicKey = publicKey;
  client.isNewUser = isNewUser;

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
        const normalizedIp = normalizeIp(client.ipAddress);
        await updateUserLastIp(user.id, normalizedIp || null);

        const activeBan = await getMatchingActiveBan({
          targetUserId: user.id,
          targetPublicKey: user.public_key,
          targetIp: normalizedIp
        });

        if (activeBan) {
          client.ws.send(JSON.stringify({
            type: 'auth:banned',
            payload: {
              reason: activeBan.reason || 'You are banned from this server.',
              blacklistIdentity: activeBan.blacklist_identity === 1,
              blacklistIp: activeBan.blacklist_ip === 1,
              targetIp: normalizedIp || null
            }
          }));
          return;
        }

        connectionManager.setUserId(client, user.id);
        client.challenge = undefined;
        client.pendingPublicKey = undefined;

        const pendingActions = await getPendingModerationActions(user.id);
        if (pendingActions.length > 0) {
          for (const action of pendingActions) {
            await markModerationActionEnforced(action.id);
            client.ws.send(JSON.stringify({
              type: 'moderation_action_enforced',
              payload: {
                actionType: action.action_type,
                reason: action.reason,
                deleteMode: action.delete_mode,
                deleteHours: action.delete_hours,
                blacklistIdentity: action.blacklist_identity === 1,
                blacklistIp: action.blacklist_ip === 1,
                targetIp: action.target_ip
              }
            }));
          }

          // Offline moderation is enforced immediately on next connect.
          client.ws.close(4003, 'Moderation action enforced');
          return;
        }

        const server = await getServer();
        const userWithUpdatedIp = await getUserById(user.id);
        client.ws.send(JSON.stringify({
          type: 'authenticated',
          payload: { user: userWithUpdatedIp || user, server }
        }));

        // Send full member list to the newly authenticated user
        const allUsers = await getUsers();
        const onlineUserIds = connectionManager.getOnlineUserIds();
        const memberIps = Object.fromEntries(
          allUsers.map((member) => [member.id, member.last_ip || connectionManager.getUserIp(member.id) || null])
        );
        client.ws.send(JSON.stringify({
          type: 'member_list',
          payload: {
            members: allUsers,
            onlineUserIds,
            memberIps
          }
        }));

        // Broadcast to others that this user is online, if they weren't already
        if (!connectionManager.isUserOnline(user.id, client)) {
          connectionManager.broadcastToAuthenticated({
            type: 'user_online',
            payload: { user }
          });
        }

        // Send welcome message if new user
        if (client.isNewUser) {
          const server = await getServer();
          if (server && server.welcomeChannelId) {
            const systemUser = await getOrCreateSystemUser();
            const welcomeContent = `Welcome ${user.username} to the server!`;
            const message = await createMessage(server.welcomeChannelId, systemUser.id, welcomeContent);
            const messageWithUser = { ...message, user: systemUser };
            
            connectionManager.broadcastToAuthenticated({
              type: 'new_message',
              payload: { message: messageWithUser }
            });
          }
          client.isNewUser = false;
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
    
    // Set welcome channel
    const server = await getServer();
    if (server) {
      await updateServerSettings(server.id, server.title || server.name, server.rulesChannelId || null, channel.id);
    }
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

const handleCreateChannel = async (
  client: ClientConnection,
  payload: { category_id: string | null, name: string, type: 'text' | 'voice' | 'rss', feed_url?: string }
) => {
  if (!client.userId) return;
  const { category_id, name, type } = payload;

  const normalizedName = (name || '').trim();
  if (!normalizedName) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Channel name is required' } }));
    return;
  }

  if (type !== 'text' && type !== 'voice' && type !== 'rss') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid channel type' } }));
    return;
  }

  const normalizedFeedUrl = typeof payload.feed_url === 'string' ? payload.feed_url.trim() : '';
  if (type === 'rss') {
    if (!normalizedFeedUrl) {
      client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'RSS feed URL is required' } }));
      return;
    }

    try {
      const feedUrl = new URL(normalizedFeedUrl);
      if (feedUrl.protocol !== 'http:' && feedUrl.protocol !== 'https:') {
        client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'RSS feed URL must use http or https' } }));
        return;
      }
    } catch {
      client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid RSS feed URL' } }));
      return;
    }
  }

  const user = await getUserById(client.userId);
  if (!user || user.role !== 'admin') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Only admins can create channels' } }));
    return;
  }

  try {
    const channel = await createChannel(category_id, normalizedName, type, 0, type === 'rss' ? normalizedFeedUrl : null);

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

const MESSAGE_PAGE_SIZE = 25;

const handleGetMessages = async (
  client: ClientConnection,
  payload: { channel_id: string; before_created_at?: string; before_id?: string; limit?: number }
) => {
  if (!client.userId) return;
  const { channel_id } = payload;
  if (!channel_id) return;

  const beforeCreatedAt = typeof payload.before_created_at === 'string' ? payload.before_created_at : undefined;
  const beforeId = typeof payload.before_id === 'string' ? payload.before_id : undefined;

  const before = beforeCreatedAt && beforeId
    ? {
        createdAt: beforeCreatedAt,
        id: beforeId
      }
    : undefined;
  const isOlderPageRequest = Boolean(before);

  // Ideally verify user has access to this channel's server
  const page = await getChannelMessages(channel_id, MESSAGE_PAGE_SIZE, before);
  const oldestMessage = page.messages[0];

  client.ws.send(JSON.stringify({
    type: 'messages_list',
    payload: {
      channel_id,
      messages: page.messages,
      has_more: page.hasMore,
      page_size: MESSAGE_PAGE_SIZE,
      is_older_page: isOlderPageRequest,
      request_before_created_at: beforeCreatedAt || null,
      request_before_id: beforeId || null,
      before_created_at: oldestMessage?.created_at || null,
      before_id: oldestMessage?.id || null
    }
  }));
};

const handleSendMessage = async (client: ClientConnection, payload: { channel_id: string, content: string }) => {
  if (!client.userId) return;
  const { channel_id, content } = payload;
  if (!channel_id || !content) return;

  const channel = await getChannelById(channel_id);
  if (!channel) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Channel not found' } }));
    return;
  }

  const user = await getUserById(client.userId);
  if (!user) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'User not found' } }));
    return;
  }

  const privilegedRoles = new Set(['admin', 'owner', 'mod', 'moderator', 'bot', 'system']);
  if (channel.type === 'rss' && !privilegedRoles.has(user.role)) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'RSS channels are read-only for your role' } }));
    return;
  }

  const message = await createMessage(channel_id, client.userId, content);
  
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

const handleProduce = async (client: ClientConnection, payload: { channel_id: string, transport_id: string, kind: any, rtpParameters: any, source?: 'mic' | 'screen' | 'camera', request_id?: string }) => {
  if (!client.userId) return;
  const { channel_id, transport_id, kind, rtpParameters, source = 'mic', request_id } = payload;
  
  const room = rooms.get(channel_id);
  if (!room) return;
  
  const peer = getPeer(room, client.userId);
  const transport = peer.transports.get(transport_id);
  if (!transport) return;

  const producer = await transport.produce({
    kind,
    rtpParameters,
    appData: {
      source,
      userId: client.userId
    }
  });
  peer.producers.set(producer.id, producer);

  if (peer.isMuted || peer.isDeafened) {
    await producer.pause();
  }

  client.ws.send(JSON.stringify({
    type: 'produced',
    payload: { channel_id, id: producer.id, source, request_id: request_id || null }
  }));

  // Broadcast new producer to others
  for (const [otherPeerId] of room.peers) {
    if (otherPeerId !== client.userId) {
      connectionManager.sendToUser(otherPeerId, {
        type: 'new_producer',
        payload: {
          channel_id,
          producer_id: producer.id,
          user_id: client.userId,
          kind: producer.kind,
          source
        }
      });
    }
  }
};

const handleCloseProducer = async (client: ClientConnection, payload: { channel_id: string, producer_id: string }) => {
  if (!client.userId) return;
  const { channel_id, producer_id } = payload;
  if (!channel_id || !producer_id) return;

  const room = rooms.get(channel_id);
  if (!room) return;

  const peer = room.peers.get(client.userId);
  if (!peer) return;

  const producer = peer.producers.get(producer_id);
  if (!producer) return;

  const producerSource = (producer.appData as { source?: unknown } | undefined)?.source;
  const source: 'mic' | 'screen' | 'camera' =
    producerSource === 'mic' || producerSource === 'screen' || producerSource === 'camera'
      ? producerSource
      : (producer.kind === 'audio' ? 'mic' : 'camera');

  console.log('[WS DEBUG] Closing producer by client request', {
    userId: client.userId,
    channel_id,
    producer_id,
    source
  });

  producer.close();
  peer.producers.delete(producer_id);

  connectionManager.broadcastToAuthenticated({
    type: 'producer_closed',
    payload: {
      channel_id,
      producer_id,
      user_id: client.userId,
      source
    }
  });
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

  const producer = Array.from(room.peers.values())
    .map((roomPeer) => roomPeer.producers.get(producer_id))
    .find((roomProducer): roomProducer is NonNullable<typeof roomProducer> => roomProducer !== undefined);

  const consumer = await transport.consume({
    producerId: producer_id,
    rtpCapabilities,
    paused: true,
  });

  const producerSource = (producer?.appData as { source?: unknown } | undefined)?.source;
  const source: 'mic' | 'screen' | 'camera' =
    producerSource === 'mic' || producerSource === 'screen' || producerSource === 'camera'
      ? producerSource
      : (consumer.kind === 'audio' ? 'mic' : 'camera');

  peer.consumers.set(consumer.id, consumer);

  client.ws.send(JSON.stringify({
    type: 'consumed',
    payload: {
      channel_id,
      producer_id,
      id: consumer.id,
      kind: consumer.kind,
      source,
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
            user_id: peerId,
            kind: producer.kind,
            source: (producer.appData?.source as 'mic' | 'screen' | 'camera' | undefined) || (producer.kind === 'audio' ? 'mic' : 'camera')
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

const handleUpdateServerSettings = async (client: ClientConnection, payload: { serverId: string, title: string, rulesChannelId: string | null, welcomeChannelId: string | null }) => {
  if (!client.userId) return;
  
  const user = await getUserById(client.userId);
  if (!user || user.role !== 'admin') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Only admins can update server settings' } }));
    return;
  }

  const { serverId, title, rulesChannelId, welcomeChannelId } = payload;
  
  if (!serverId) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Server ID is required' } }));
    return;
  }

  const normalizedTitle = (title || '').trim();
  if (!normalizedTitle) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Server title is required' } }));
    return;
  }

  try {
    await updateServerSettings(serverId, normalizedTitle, rulesChannelId, welcomeChannelId);
    const updatedServer = await getServer();
    
    connectionManager.broadcastToAuthenticated({
      type: 'server_settings_updated',
      payload: { server: updatedServer }
    });
  } catch (error) {
    console.error('[WS DEBUG] Failed to update server settings:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to update server settings' } }));
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
      const producerSource = (producer.appData as { source?: unknown } | undefined)?.source;
      const source: 'mic' | 'screen' | 'camera' =
        producerSource === 'mic' || producerSource === 'screen' || producerSource === 'camera'
          ? producerSource
          : (producer.kind === 'audio' ? 'mic' : 'camera');

      // Mute/deafen state must only gate microphone producers.
      // Pausing screen/camera producers causes remote video frame freeze/black screen.
      if (source !== 'mic') {
        continue;
      }

      if (isMuted || isDeafened) {
        await producer.pause();
      } else {
        await producer.resume();
      }

      console.log('[WS DEBUG] Updated producer pause state from voice flags', {
        userId: client.userId,
        channel_id,
        producerId: producer.id,
        source,
        paused: isMuted || isDeafened
      });
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

const handleCreateServer = async (client: ClientConnection, payload: { name: string }) => {
  if (!client.userId) return;
  const { name } = payload;
  
  const server = await createServer(name);
  
  // Create default category and channel
  const category = await createCategory('Text Channels', 0);
  const channel = await createChannel(category.id, 'general', 'text', 0);
  
  // Update server's welcomeChannelId
  await updateServerSettings(server.id, server.title || server.name, null, channel.id);
  
  const updatedServer = await getServer();
  
  client.ws.send(JSON.stringify({
    type: 'SERVER_CREATED',
    payload: { server: updatedServer }
  }));
};

const handleUpdateServerSettingsUppercase = async (client: ClientConnection, payload: { serverId: string, title: string, rulesChannelId: string | null, welcomeChannelId: string | null }) => {
  if (!client.userId) return;
  
  const user = await getUserById(client.userId);
  // Assuming admin is the server owner for now, as there is no ownerId
  if (!user || user.role !== 'admin') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Only server owners can update server settings' } }));
    return;
  }

  const { serverId, title, rulesChannelId, welcomeChannelId } = payload;
  
  if (!serverId) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Server ID is required' } }));
    return;
  }

  const normalizedTitle = (title || '').trim();
  if (!normalizedTitle) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Server title is required' } }));
    return;
  }

  try {
    await updateServerSettings(serverId, normalizedTitle, rulesChannelId, welcomeChannelId);
    const updatedServer = await getServer();
    
    connectionManager.broadcastToAuthenticated({
      type: 'SERVER_UPDATED',
      payload: { server: updatedServer }
    });
  } catch (error) {
    console.error('[WS DEBUG] Failed to update server settings:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to update server settings' } }));
  }
};

const handleJoinServer = async (client: ClientConnection, payload: { serverId: string }) => {
  if (!client.userId) return;
  const { serverId } = payload;
  
  const server = await getServer();
  if (!server || server.id !== serverId) return;
  
  const user = await getUserById(client.userId);
  if (!user) return;

  const activeBan = await getMatchingActiveBan({
    targetUserId: user.id,
    targetPublicKey: user.public_key,
    targetIp: normalizeIp(client.ipAddress)
  });

  if (activeBan) {
    client.ws.send(JSON.stringify({
      type: 'error',
      payload: { message: activeBan.reason || 'You are banned from this server.' }
    }));
    return;
  }
  
  if (server.welcomeChannelId) {
    const welcomeContent = `Just joined the server!`;
    const message = await createMessage(server.welcomeChannelId, user.id, welcomeContent);
    const messageWithUser = { ...message, user };
    
    connectionManager.broadcastToAuthenticated({
      type: 'NEW_MESSAGE',
      payload: { message: messageWithUser }
    });
  }
  
  client.ws.send(JSON.stringify({
    type: 'SERVER_JOINED',
    payload: { serverId }
  }));
};

const parseDeleteMode = (input: unknown): MessageDeleteMode => {
  if (typeof input !== 'string') return 'none';
  const normalized = input.trim().toLowerCase();
  if (normalized === 'all') return 'all';
  if (normalized === 'hours' || normalized === 'hour' || normalized === 'last_hour' || normalized === 'lasthour' || normalized === '1h') {
    return 'hours';
  }
  return 'none';
};

const extractDeleteOptions = (payload: {
  deleteMode?: unknown;
  delete_mode?: unknown;
  deleteHours?: unknown;
  delete_hours?: unknown;
  deleteLastHour?: unknown;
  lastHour?: unknown;
}) => {
  const rawDeleteMode = payload?.deleteMode ?? payload?.delete_mode;
  const inferredHoursMode = payload?.deleteLastHour === true || payload?.lastHour === true;
  const deleteMode = inferredHoursMode ? 'hours' : parseDeleteMode(rawDeleteMode);

  const rawDeleteHours = payload?.deleteHours ?? payload?.delete_hours;
  const parsedHours =
    typeof rawDeleteHours === 'number'
      ? rawDeleteHours
      : typeof rawDeleteHours === 'string'
        ? Number(rawDeleteHours)
        : undefined;

  const deleteHours =
    deleteMode === 'hours'
      ? Math.max(1, Math.floor(Number.isFinite(parsedHours as number) ? (parsedHours as number) : 1))
      : undefined;

  return { deleteMode, deleteHours } as const;
};

const normalizeIp = (value?: string): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }
  return trimmed;
};

const canModerate = (role: string): boolean => {
  return role === 'admin' || role === 'owner' || role === 'mod' || role === 'moderator';
};

const handleKickMember = async (
  client: ClientConnection,
  payload: {
    targetUserId: string;
    reason?: string;
    deleteMode?: MessageDeleteMode;
    delete_mode?: MessageDeleteMode;
    deleteHours?: number;
    delete_hours?: number;
    deleteLastHour?: boolean;
    lastHour?: boolean;
  }
) => {
  if (!client.userId) return;
  const moderator = await getUserById(client.userId);
  if (!moderator || !canModerate(moderator.role)) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Insufficient permissions' } }));
    return;
  }

  const targetUserId = payload?.targetUserId;
  if (!targetUserId || targetUserId === moderator.id) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid target user' } }));
    return;
  }

  const targetUser = await getUserById(targetUserId);
  if (!targetUser) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Target user not found' } }));
    return;
  }

  const { deleteMode, deleteHours } = extractDeleteOptions(payload || {});
  console.debug('[WS DEBUG] kick_member delete payload received', {
    moderatorUserId: moderator.id,
    targetUserId,
    rawDeleteMode: payload?.deleteMode ?? payload?.delete_mode,
    rawDeleteHours: payload?.deleteHours ?? payload?.delete_hours,
    resolvedDeleteMode: deleteMode,
    resolvedDeleteHours: deleteHours ?? null
  });
  const reason = (payload?.reason || '').trim() || 'You were kicked from this server.';
  const targetIp = normalizeIp(connectionManager.getUserIp(targetUser.id) || targetUser.last_ip || undefined);

  if (deleteMode !== 'none') {
    await deleteMessagesByUser(targetUser.id, deleteMode, deleteHours);
  }

  const isOnlineNow = connectionManager.isUserOnline(targetUser.id);
  await createModerationAction({
    targetUserId: targetUser.id,
    moderatorUserId: moderator.id,
    actionType: 'kick',
    reason,
    deleteMode,
    deleteHours,
    targetIp,
    enforced: isOnlineNow
  });

  connectionManager.broadcastToAuthenticated({
    type: 'member_removed',
    payload: {
      actionType: 'kick',
      userId: targetUser.id,
      reason,
      deleteMode,
      deleteHours: deleteHours || null,
      targetIp
    }
  });

  if (isOnlineNow) {
    connectionManager.sendToUser(targetUser.id, {
      type: 'moderation_action_enforced',
      payload: {
        actionType: 'kick',
        reason,
        deleteMode,
        deleteHours: deleteHours || null,
        blacklistIdentity: false,
        blacklistIp: false,
        targetIp
      }
    });
    connectionManager.closeUserConnections(targetUser.id);
  }

  client.ws.send(JSON.stringify({
    type: 'moderation_action_applied',
    payload: {
      actionType: 'kick',
      targetUserId: targetUser.id,
      enforcedImmediately: isOnlineNow,
      reason,
      deleteMode,
      deleteHours: deleteHours || null,
      targetIp
    }
  }));
};

const handleBanMember = async (
  client: ClientConnection,
  payload: {
    targetUserId: string;
    reason?: string;
    deleteMode?: MessageDeleteMode;
    delete_mode?: MessageDeleteMode;
    deleteHours?: number;
    delete_hours?: number;
    deleteLastHour?: boolean;
    lastHour?: boolean;
    blacklistIdentity?: boolean;
    blacklistIp?: boolean;
  }
) => {
  if (!client.userId) return;
  const moderator = await getUserById(client.userId);
  if (!moderator || !canModerate(moderator.role)) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Insufficient permissions' } }));
    return;
  }

  const targetUserId = payload?.targetUserId;
  if (!targetUserId || targetUserId === moderator.id) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid target user' } }));
    return;
  }

  const targetUser = await getUserById(targetUserId);
  if (!targetUser) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Target user not found' } }));
    return;
  }

  const { deleteMode, deleteHours } = extractDeleteOptions(payload || {});
  console.debug('[WS DEBUG] ban_member delete payload received', {
    moderatorUserId: moderator.id,
    targetUserId,
    rawDeleteMode: payload?.deleteMode ?? payload?.delete_mode,
    rawDeleteHours: payload?.deleteHours ?? payload?.delete_hours,
    resolvedDeleteMode: deleteMode,
    resolvedDeleteHours: deleteHours ?? null
  });
  const reason = (payload?.reason || '').trim() || 'You were banned from this server.';
  const blacklistIdentity = payload?.blacklistIdentity !== false;
  const blacklistIp = payload?.blacklistIp === true;
  const targetIp = normalizeIp(connectionManager.getUserIp(targetUser.id) || targetUser.last_ip || undefined);

  if (!blacklistIdentity && !blacklistIp) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'At least one blacklist dimension is required' } }));
    return;
  }

  if (blacklistIp && !targetIp) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Cannot apply IP blacklist without a known target IP' } }));
    return;
  }

  if (deleteMode !== 'none') {
    await deleteMessagesByUser(targetUser.id, deleteMode, deleteHours);
  }

  await createBanRule({
    targetUserId: targetUser.id,
    targetPublicKey: targetUser.public_key,
    targetIp,
    blacklistIdentity,
    blacklistIp,
    reason,
    moderatorUserId: moderator.id
  });

  const isOnlineNow = connectionManager.isUserOnline(targetUser.id);
  await createModerationAction({
    targetUserId: targetUser.id,
    moderatorUserId: moderator.id,
    actionType: 'ban',
    reason,
    deleteMode,
    deleteHours,
    blacklistIdentity,
    blacklistIp,
    targetIp,
    enforced: isOnlineNow
  });

  connectionManager.broadcastToAuthenticated({
    type: 'member_removed',
    payload: {
      actionType: 'ban',
      userId: targetUser.id,
      reason,
      deleteMode,
      deleteHours: deleteHours || null,
      blacklistIdentity,
      blacklistIp,
      targetIp
    }
  });

  if (isOnlineNow) {
    connectionManager.sendToUser(targetUser.id, {
      type: 'moderation_action_enforced',
      payload: {
        actionType: 'ban',
        reason,
        deleteMode,
        deleteHours: deleteHours || null,
        blacklistIdentity,
        blacklistIp,
        targetIp
      }
    });
    connectionManager.closeUserConnections(targetUser.id);
  }

  client.ws.send(JSON.stringify({
    type: 'moderation_action_applied',
    payload: {
      actionType: 'ban',
      targetUserId: targetUser.id,
      enforcedImmediately: isOnlineNow,
      reason,
      deleteMode,
      deleteHours: deleteHours || null,
      blacklistIdentity,
      blacklistIp,
      targetIp
    }
  }));
};

