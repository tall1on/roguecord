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
  MessageDeleteMode,
  getChannelUnreadStatesForUser,
  markChannelReadUpToMessage,
  createFolderChannelFile,
  getFolderChannelFiles,
  getFolderChannelFileById,
  deleteFolderChannelFileById,
  getServerStorageSettings,
  updateServerStorageSettings,
  updateServerStorageLastError,
  updateFolderChannelFileStorage,
  getAllFolderChannelFiles
} from '../models';
import { getOrCreateRoom, getPeer, createWebRtcTransport, rooms } from '../mediasoup';
import crypto from 'node:crypto';
import { adminKey } from '../admin';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db';
import {
  buildS3StorageKey,
  deleteFileFromS3,
  downloadFileFromS3,
  listS3KeysByPrefix,
  type S3StorageConfig,
  uploadFileToS3,
  validateS3Configuration
} from '../storage/s3Storage';

const filesRootDir = path.join(dataDir, 'files');
const serverIconsRootDir = path.join(dataDir, 'server-icons');
const MAX_FOLDER_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_SERVER_ICON_SIZE_BYTES = 2 * 1024 * 1024;
const BLOCKED_FOLDER_UPLOAD_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'html', 'htm', 'php', 'phtml',
  'exe', 'dll', 'so', 'com', 'scr', 'msi',
  'py', 'pyw', 'python',
  'sh', 'bash', 'zsh',
  'bat', 'cmd',
  'ps1', 'psm1',
  'vbs', 'vbe', 'wsf', 'wsh',
  'jar', 'appimage'
]);

const ensureFilesRootDir = () => {
  if (!fs.existsSync(filesRootDir)) {
    fs.mkdirSync(filesRootDir, { recursive: true });
  }
};

const ensureServerIconsRootDir = () => {
  if (!fs.existsSync(serverIconsRootDir)) {
    fs.mkdirSync(serverIconsRootDir, { recursive: true });
  }
};

const sanitizeServerIdForPath = (serverId: string) => (serverId || '').replace(/[^a-zA-Z0-9-]/g, '');

const getSafeServerIconPath = (serverId: string, storageName: string) => {
  ensureServerIconsRootDir();
  const safeServerId = sanitizeServerIdForPath(serverId);
  const safeStorageName = path.basename(storageName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  if (!safeServerId || !safeStorageName) {
    throw new Error('Invalid server icon path');
  }

  const dir = path.resolve(serverIconsRootDir, safeServerId);
  const root = path.resolve(serverIconsRootDir);
  if (!dir.startsWith(root)) {
    throw new Error('Unsafe server icon directory');
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fullPath = path.resolve(dir, safeStorageName);
  if (!fullPath.startsWith(dir)) {
    throw new Error('Unsafe server icon file path');
  }

  return fullPath;
};

const parseServerIconDataUrl = (value: unknown): { buffer: Buffer; mimeType: string; extension: string } | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/i);
  if (!match) return null;

  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
  const base64 = match[3] || '';
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return null;
  return { buffer, mimeType, extension };
};

const buildServerIconPathForClient = (serverId: string, storageName: string) => {
  const safeServerId = sanitizeServerIdForPath(serverId);
  const safeStorageName = path.basename(storageName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  return `/server-icons/${safeServerId}/${safeStorageName}`;
};

const buildServerIconStorageName = (extension: string) => {
  const safeExtension = (extension || '').trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!safeExtension) {
    throw new Error('Invalid icon extension');
  }
  return `icon.${safeExtension}`;
};

const buildS3ServerIconPrefix = (prefix: string | null | undefined, serverId: string) => {
  const marker = '__server_icon_marker__';
  const keyWithMarker = buildS3StorageKey(prefix, `server-icons/${serverId}`, marker);
  return keyWithMarker.slice(0, -marker.length);
};

const isSafeS3IconKeyForServer = (serverId: string, key: string) => {
  const trimmed = (key || '').trim();
  const safeServerId = sanitizeServerIdForPath(serverId);
  if (!trimmed || !safeServerId) {
    return false;
  }
  if (trimmed.includes('\\') || /[\u0000-\u001F]/.test(trimmed)) {
    return false;
  }
  const segments = trimmed.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    return false;
  }

  const marker = `server-icons/${safeServerId}/`;
  return trimmed === `server-icons/${safeServerId}` || trimmed.includes(marker);
};

const parseSafeLocalServerIconStorageName = (serverId: string, iconPath: string): string | null => {
  const safeServerId = sanitizeServerIdForPath(serverId);
  if (!safeServerId) {
    return null;
  }

  const normalizedPath = (iconPath || '').trim();
  const expectedPrefix = `/server-icons/${safeServerId}/`;
  if (!normalizedPath.startsWith(expectedPrefix)) {
    return null;
  }

  const storageName = normalizedPath.slice(expectedPrefix.length).trim();
  if (!storageName || storageName.includes('/') || storageName.includes('\\')) {
    return null;
  }

  const safeStorageName = path.basename(storageName).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  if (!safeStorageName || safeStorageName !== storageName) {
    return null;
  }

  return safeStorageName;
};

const cleanupServerIconReference = async (serverId: string, iconPath: string | null | undefined) => {
  const trimmed = (iconPath || '').trim();
  if (!trimmed) {
    return;
  }

  if (trimmed.startsWith('s3:')) {
    const key = trimmed.slice('s3:'.length).trim();
    if (!isSafeS3IconKeyForServer(serverId, key)) {
      console.warn('[WS DEBUG] Skipping unsafe server icon S3 cleanup key', { serverId, key });
      return;
    }

    const persistedS3Config = await getPersistedS3Config();
    if (!persistedS3Config) {
      console.warn('[WS DEBUG] Skipping server icon S3 cleanup because S3 config is unavailable', { serverId, key });
      return;
    }

    try {
      await deleteFileFromS3({ config: persistedS3Config, key });
    } catch (error) {
      console.warn('[WS DEBUG] Failed cleaning up old server icon from S3', { serverId, key, error });
    }
    return;
  }

  const storageName = parseSafeLocalServerIconStorageName(serverId, trimmed);
  if (!storageName) {
    console.warn('[WS DEBUG] Skipping unsafe server icon local cleanup path', { serverId, iconPath: trimmed });
    return;
  }

  try {
    const localIconPath = getSafeServerIconPath(serverId, storageName);
    if (!fs.existsSync(localIconPath)) {
      return;
    }
    fs.unlinkSync(localIconPath);
  } catch (error) {
    console.warn('[WS DEBUG] Failed cleaning up old local server icon', { serverId, iconPath: trimmed, error });
  }
};

const cleanupStaleS3ServerIcons = async (input: {
  serverId: string;
  s3Config: S3StorageConfig;
  activeKey: string | null;
}) => {
  const serverIconPrefix = buildS3ServerIconPrefix(input.s3Config.prefix, input.serverId);
  const existingKeys = await listS3KeysByPrefix({
    config: input.s3Config,
    prefix: serverIconPrefix
  });

  for (const existingKey of existingKeys) {
    if (input.activeKey && existingKey === input.activeKey) {
      continue;
    }
    if (!isSafeS3IconKeyForServer(input.serverId, existingKey)) {
      continue;
    }

    const currentServer = await getServer();
    if (currentServer?.id === input.serverId && currentServer.iconPath === `s3:${existingKey}`) {
      continue;
    }

    await deleteFileFromS3({
      config: input.s3Config,
      key: existingKey
    });
  }
};

const cleanupStaleLocalServerIcons = (serverId: string, activeStorageName: string) => {
  const activePath = getSafeServerIconPath(serverId, activeStorageName);
  const iconDir = path.dirname(activePath);
  const files = fs.readdirSync(iconDir);
  for (const fileName of files) {
    const safeName = path.basename(fileName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
    if (!safeName || safeName !== fileName || safeName === activeStorageName) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(iconDir, safeName));
    } catch {
      // keep stale local icon when cleanup fails
    }
  }
};

const storeServerIcon = async (serverId: string, iconDataUrl: string): Promise<string> => {
  const parsed = parseServerIconDataUrl(iconDataUrl);
  if (!parsed) {
    throw new Error('Invalid icon data. Expected base64 data URL image.');
  }

  if (parsed.buffer.length > MAX_SERVER_ICON_SIZE_BYTES) {
    throw new Error('Server icon exceeds 2MB size limit.');
  }

  const runtimeStorage = await getStorageRuntimeConfig();
  const storageName = buildServerIconStorageName(parsed.extension);

  if (runtimeStorage.storageType === 's3') {
    if (!runtimeStorage.s3Config) {
      throw new Error('S3 storage is enabled but configuration is missing');
    }

    const key = buildS3StorageKey(runtimeStorage.s3Config.prefix, `server-icons/${serverId}`, storageName);
    await uploadFileToS3({
      config: runtimeStorage.s3Config,
      key,
      buffer: parsed.buffer,
      mimeType: parsed.mimeType
    });
    return `s3:${key}`;
  }

  const targetPath = getSafeServerIconPath(serverId, storageName);
  fs.writeFileSync(targetPath, parsed.buffer);
  cleanupStaleLocalServerIcons(serverId, storageName);
  return buildServerIconPathForClient(serverId, storageName);
};

const sanitizeFileName = (name: string) => {
  const base = path.basename(name || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  return base || 'file';
};

const getNormalizedFileExtension = (name: string) => {
  const extension = path.extname(name || '');
  return extension.replace('.', '').trim().toLowerCase();
};

const getSafeChannelFilesDir = (channelId: string) => {
  ensureFilesRootDir();
  const safeChannelId = (channelId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const dir = path.resolve(filesRootDir, safeChannelId);
  const root = path.resolve(filesRootDir);
  if (!dir.startsWith(root)) {
    throw new Error('Unsafe channel path');
  }
  return dir;
};

const ensureChannelFilesDir = (channelId: string) => {
  const dir = getSafeChannelFilesDir(channelId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const resolveSafeStoredFilePath = (channelId: string, storageName: string) => {
  const channelDir = getSafeChannelFilesDir(channelId);
  const safeStorageName = path.basename(storageName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  if (!safeStorageName) {
    throw new Error('Invalid storage name');
  }
  const fullPath = path.resolve(channelDir, safeStorageName);
  if (!fullPath.startsWith(channelDir)) {
    throw new Error('Unsafe file path');
  }
  return fullPath;
};

const hasFolderManagementAccess = (role: string | null | undefined) => {
  return role === 'admin' || role === 'owner';
};

const sanitizeStoragePrefix = (prefix: string | null | undefined) => {
  const trimmed = (prefix || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeS3Endpoint = (endpoint: string) => {
  const trimmed = (endpoint || '').trim();
  if (!trimmed) {
    throw new Error('S3 endpoint is required');
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  return parsed.origin;
};

const parseHetznerEndpointHost = (endpoint: string): { bucket: string; region: string } | null => {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    const labels = host.split('.').filter(Boolean);
    if (labels.length < 4) {
      return null;
    }

    const suffix = labels.slice(-2).join('.');
    if (suffix !== 'your-objectstorage.com') {
      return null;
    }

    const region = labels[labels.length - 3];
    const bucket = labels.slice(0, labels.length - 3).join('.');
    if (!region || !bucket) {
      return null;
    }

    return { bucket, region };
  } catch {
    return null;
  }
};

const normalizeS3Config = (input: {
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  accessKey?: string | null;
  secretKey?: string | null;
  prefix?: string | null;
}): S3StorageConfig => {
  const endpoint = sanitizeS3Endpoint(input.endpoint || '');
  const requestedRegion = (input.region || '').trim();
  const requestedBucket = (input.bucket || '').trim();
  const accessKey = (input.accessKey || '').trim();
  const secretKey = (input.secretKey || '').trim();

  const parsedHetzner = parseHetznerEndpointHost(endpoint);
  const region = requestedRegion || parsedHetzner?.region || '';
  const bucket = requestedBucket || parsedHetzner?.bucket || '';

  if ((!requestedRegion || !requestedBucket) && !parsedHetzner) {
    throw new Error('Hetzner endpoint URL must match https://<bucket-name>.<location>.your-objectstorage.com');
  }

  if (parsedHetzner) {
    if (requestedRegion && requestedRegion !== parsedHetzner.region) {
      throw new Error('S3 region does not match endpoint URL location segment');
    }
    if (requestedBucket && requestedBucket !== parsedHetzner.bucket) {
      throw new Error('S3 bucket does not match endpoint URL bucket segment');
    }
  }

  if (!region) {
    throw new Error('S3 region is required');
  }
  if (!bucket) {
    throw new Error('S3 bucket is required');
  }
  if (!accessKey) {
    throw new Error('S3 access key is required');
  }
  if (!secretKey) {
    throw new Error('S3 secret key is required');
  }

  return {
    endpoint,
    region,
    bucket,
    accessKey,
    secretKey,
    prefix: sanitizeStoragePrefix(input.prefix)
  };
};

const getPersistedS3Config = async (): Promise<S3StorageConfig | null> => {
  const settings = await getServerStorageSettings();
  if (!settings || !settings.s3) {
    return null;
  }

  try {
    return normalizeS3Config(settings.s3);
  } catch {
    return null;
  }
};

const getStorageRuntimeConfig = async (): Promise<{ storageType: 'data_dir' | 's3'; s3Config: S3StorageConfig | null }> => {
  const settings = await getServerStorageSettings();
  if (!settings || settings.storageType !== 's3') {
    return { storageType: 'data_dir', s3Config: null };
  }

  if (!settings.s3) {
    throw new Error('S3 storage is enabled but configuration is missing');
  }

  return {
    storageType: 's3',
    s3Config: normalizeS3Config(settings.s3)
  };
};

const buildStorageSettingsPayloadForClient = (settings: Awaited<ReturnType<typeof getServerStorageSettings>>) => {
  return {
    storageType: settings?.storageType || 'data_dir',
    storageLastError: settings?.storageLastError || null,
    s3: settings?.s3
      ? {
        endpoint: settings.s3.endpoint,
        region: settings.s3.region,
        bucket: settings.s3.bucket,
        accessKey: settings.s3.accessKey,
        secretKey: settings.s3.secretKey,
        prefix: settings.s3.prefix || ''
      }
      : {
        endpoint: '',
        region: '',
        bucket: '',
        accessKey: '',
        secretKey: '',
        prefix: ''
      }
  };
};

const migrateDataDirFilesToS3 = async (serverId: string, s3Config: S3StorageConfig) => {
  const allFiles = await getAllFolderChannelFiles();

  for (const file of allFiles) {
    if (file.storage_provider === 's3' && file.storage_key) {
      continue;
    }

    const legacyPath = resolveSafeStoredFilePath(file.channel_id, file.storage_name);
    if (!fs.existsSync(legacyPath)) {
      console.warn('[WS DEBUG] Skipping legacy file migration because source is missing', {
        channelId: file.channel_id,
        fileId: file.id
      });
      continue;
    }

    const storageKey = buildS3StorageKey(s3Config.prefix, file.channel_id, file.storage_name);
    try {
      const buffer = fs.readFileSync(legacyPath);
      await uploadFileToS3({
        config: s3Config,
        key: storageKey,
        buffer,
        mimeType: file.mime_type
      });

      await updateFolderChannelFileStorage({
        fileId: file.id,
        storageProvider: 's3',
        storageKey,
        migratedToS3At: new Date().toISOString()
      });

      try {
        fs.unlinkSync(legacyPath);
      } catch {
        // keep source file when cleanup fails
      }
    } catch (error) {
      console.error('[WS DEBUG] Failed migrating legacy file to S3', {
        fileId: file.id,
        channelId: file.channel_id,
        error
      });
      await updateServerStorageLastError({
        serverId,
        storageLastError: 'Some legacy files could not be migrated to S3. Check server logs.'
      });
    }
  }
};

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
      case 'mark_channel_read':
        await handleMarkChannelRead(client, payload);
        break;
      case 'send_message':
        await handleSendMessage(client, payload);
        break;
      case 'folder_list_files':
        await handleFolderListFiles(client, payload);
        break;
      case 'folder_upload_file':
        await handleFolderUploadFile(client, payload);
        break;
      case 'folder_download_file':
        await handleFolderDownloadFile(client, payload);
        break;
      case 'folder_delete_file':
        await handleFolderDeleteFile(client, payload);
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
      case 'get_server_storage_settings':
        await handleGetServerStorageSettings(client);
        break;
      case 'get_server':
        await handleGetServer(client);
        break;
      case 'test_server_storage_s3':
        await handleTestServerStorageS3(client, payload);
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
  const unreadStates = await getChannelUnreadStatesForUser(client.userId);

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
    payload: { categories, channels, unreadStates }
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

const handleMarkChannelRead = async (
  client: ClientConnection,
  payload: { channel_id?: string; last_read_message_id?: string; last_read_message_created_at?: string }
) => {
  if (!client.userId) return;

  const channelId = typeof payload?.channel_id === 'string' ? payload.channel_id : '';
  const messageId = typeof payload?.last_read_message_id === 'string' ? payload.last_read_message_id : '';
  const messageCreatedAt = typeof payload?.last_read_message_created_at === 'string' ? payload.last_read_message_created_at : '';

  if (!channelId || !messageId || !messageCreatedAt) {
    return;
  }

  const channel = await getChannelById(channelId);
  if (!channel || (channel.type !== 'text' && channel.type !== 'rss')) {
    return;
  }

  await markChannelReadUpToMessage({
    userId: client.userId,
    channelId,
    messageId,
    messageCreatedAt
  });
};

const handleCreateChannel = async (
  client: ClientConnection,
  payload: { category_id: string | null, name: string, type: 'text' | 'voice' | 'rss' | 'folder', feed_url?: string }
) => {
  if (!client.userId) return;
  const { category_id, name, type } = payload;

  const normalizedName = (name || '').trim();
  if (!normalizedName) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Channel name is required' } }));
    return;
  }

  if (type !== 'text' && type !== 'voice' && type !== 'rss' && type !== 'folder') {
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

    if (channel.type === 'folder') {
      try {
        const channelDir = getSafeChannelFilesDir(channel_id);
        if (fs.existsSync(channelDir)) {
          fs.rmSync(channelDir, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        console.warn('[WS DEBUG] Failed to cleanup folder channel files directory:', cleanupError);
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

  await markChannelReadUpToMessage({
    userId: client.userId,
    channelId: channel_id,
    messageId: message.id,
    messageCreatedAt: message.created_at
  });
  
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

const handleFolderListFiles = async (client: ClientConnection, payload: { channel_id?: string }) => {
  if (!client.userId) return;
  const channelId = typeof payload?.channel_id === 'string' ? payload.channel_id : '';
  if (!channelId) return;

  const channel = await getChannelById(channelId);
  if (!channel || channel.type !== 'folder') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Folder channel not found' } }));
    return;
  }

  const files = await getFolderChannelFiles(channelId);
  client.ws.send(JSON.stringify({
    type: 'folder_files_list',
    payload: { channel_id: channelId, files }
  }));
};

const handleFolderUploadFile = async (
  client: ClientConnection,
  payload: { channel_id?: string; file_name?: string; mime_type?: string; data_base64?: string }
) => {
  if (!client.userId) return;
  const channelId = typeof payload?.channel_id === 'string' ? payload.channel_id : '';
  const originalName = sanitizeFileName(typeof payload?.file_name === 'string' ? payload.file_name : '');
  const mimeType = typeof payload?.mime_type === 'string' && payload.mime_type.trim() ? payload.mime_type.trim() : null;
  const dataBase64 = payload?.data_base64;

  if (!channelId || typeof dataBase64 !== 'string') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid upload payload' } }));
    return;
  }

  const channel = await getChannelById(channelId);
  if (!channel || channel.type !== 'folder') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Folder channel not found' } }));
    return;
  }

  const user = await getUserById(client.userId);
  if (!user || user.role !== 'admin') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Only admins can upload files' } }));
    return;
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = Buffer.from(dataBase64, 'base64');
  } catch {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid file payload encoding' } }));
    return;
  }

  if (fileBuffer.length > MAX_FOLDER_FILE_SIZE_BYTES) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Uploaded file exceeds size limit (25 MB)' } }));
    return;
  }

  const extension = getNormalizedFileExtension(originalName);
  if (extension && BLOCKED_FOLDER_UPLOAD_EXTENSIONS.has(extension)) {
    client.ws.send(JSON.stringify({
      type: 'error',
      payload: {
        message: `Upload blocked: .${extension} files are not allowed in folder channels.`
      }
    }));
    return;
  }

  const ext = path.extname(originalName).slice(0, 20);
  const storageName = `${crypto.randomUUID()}${ext}`;
  let filePath: string | null = null;

  try {
    const storageRuntime = await getStorageRuntimeConfig();
    let storageProvider: 'data_dir' | 's3' = 'data_dir';
    let storageKey: string | null = null;

    if (storageRuntime.storageType === 's3' && storageRuntime.s3Config) {
      storageProvider = 's3';
      storageKey = buildS3StorageKey(storageRuntime.s3Config.prefix, channelId, storageName);
      await uploadFileToS3({
        config: storageRuntime.s3Config,
        key: storageKey,
        buffer: fileBuffer,
        mimeType
      });
    } else {
      filePath = resolveSafeStoredFilePath(channelId, storageName);
      ensureChannelFilesDir(channelId);
      fs.writeFileSync(filePath, fileBuffer);
    }

    const created = await createFolderChannelFile({
      channelId,
      originalName,
      storageName,
      storageProvider,
      storageKey,
      mimeType,
      sizeBytes: fileBuffer.length,
      uploaderUserId: client.userId
    });

    const payloadFile = {
      ...created,
      uploader_username: user.username
    };

    connectionManager.broadcastToAuthenticated({
      type: 'folder_file_uploaded',
      payload: {
        channel_id: channelId,
        file: payloadFile
      }
    });

    client.ws.send(JSON.stringify({
      type: 'folder_upload_success',
      payload: { channel_id: channelId, file_id: created.id }
    }));
  } catch (error) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // no-op
    }
    console.error('[WS DEBUG] Failed to upload folder file:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to upload file' } }));
  }
};

const handleFolderDownloadFile = async (
  client: ClientConnection,
  payload: { channel_id?: string; file_id?: string }
) => {
  if (!client.userId) return;
  const channelId = typeof payload?.channel_id === 'string' ? payload.channel_id : '';
  const fileId = typeof payload?.file_id === 'string' ? payload.file_id : '';
  if (!channelId || !fileId) return;

  const channel = await getChannelById(channelId);
  if (!channel || channel.type !== 'folder') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Folder channel not found' } }));
    return;
  }

  const file = await getFolderChannelFileById(fileId);
  if (!file || file.channel_id !== channelId) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'File not found' } }));
    return;
  }

  try {
    let fileBuffer: Buffer;
    if (file.storage_provider === 's3') {
      const persistedS3Config = await getPersistedS3Config();
      if (!persistedS3Config || !file.storage_key) {
        client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'S3 storage is not configured for this file' } }));
        return;
      }
      fileBuffer = await downloadFileFromS3({ config: persistedS3Config, key: file.storage_key });
    } else {
      const fullPath = resolveSafeStoredFilePath(channelId, file.storage_name);
      if (!fs.existsSync(fullPath)) {
        client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Stored file is missing' } }));
        return;
      }
      fileBuffer = fs.readFileSync(fullPath);
    }

    const dataBase64 = fileBuffer.toString('base64');
    client.ws.send(JSON.stringify({
      type: 'folder_file_download',
      payload: {
        channel_id: channelId,
        file: {
          id: file.id,
          original_name: file.original_name,
          mime_type: file.mime_type,
          size_bytes: file.size_bytes
        },
        data_base64: dataBase64
      }
    }));
  } catch (error) {
    console.error('[WS DEBUG] Failed to read folder file:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to download file' } }));
  }
};

const handleFolderDeleteFile = async (
  client: ClientConnection,
  payload: { channel_id?: string; file_id?: string }
) => {
  if (!client.userId) return;

  const channelId = typeof payload?.channel_id === 'string' ? payload.channel_id : '';
  const fileId = typeof payload?.file_id === 'string' ? payload.file_id : '';
  if (!channelId || !fileId) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid delete payload' } }));
    return;
  }

  const channel = await getChannelById(channelId);
  if (!channel || channel.type !== 'folder') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Folder channel not found' } }));
    return;
  }

  const user = await getUserById(client.userId);
  if (!user || !hasFolderManagementAccess(user.role)) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Insufficient permissions to delete files' } }));
    return;
  }

  const file = await getFolderChannelFileById(fileId);
  if (!file || file.channel_id !== channelId) {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'File not found' } }));
    return;
  }

  try {
    if (file.storage_provider === 's3') {
      const persistedS3Config = await getPersistedS3Config();
      if (persistedS3Config && file.storage_key) {
        await deleteFileFromS3({ config: persistedS3Config, key: file.storage_key });
      }
    } else {
      const fullPath = resolveSafeStoredFilePath(channelId, file.storage_name);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch (error) {
    console.error('[WS DEBUG] Failed to delete stored folder file:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to delete file' } }));
    return;
  }

  try {
    await deleteFolderChannelFileById(file.id);
  } catch (error) {
    console.error('[WS DEBUG] Failed to delete folder file metadata:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to delete file' } }));
    return;
  }

  connectionManager.broadcastToAuthenticated({
    type: 'folder_file_deleted',
    payload: {
      channel_id: channelId,
      file_id: file.id
    }
  });

  client.ws.send(JSON.stringify({
    type: 'folder_delete_success',
    payload: {
      channel_id: channelId,
      file_id: file.id
    }
  }));
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

  // Voice mute/deafen flags should only gate microphone producers.
  // Screen-share audio must continue to flow so viewers can hear shared system audio,
  // and screen/camera video must not be paused by voice-state flags.
  const normalizedSource: 'mic' | 'screen' | 'camera' =
    source === 'mic' || source === 'screen' || source === 'camera'
      ? source
      : (kind === 'audio' ? 'mic' : 'camera');

  if (normalizedSource === 'mic' && (peer.isMuted || peer.isDeafened)) {
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

  const typedPayload = payload as {
    serverId: string;
    title: string;
    rulesChannelId: string | null;
    welcomeChannelId: string | null;
    iconDataUrl?: string | null;
    removeIcon?: boolean;
    storage?: {
      enabled?: boolean;
      endpoint?: string;
      region?: string;
      bucket?: string;
      accessKey?: string;
      secretKey?: string;
      prefix?: string;
    };
  };

  const { serverId, title, rulesChannelId, welcomeChannelId } = typedPayload;
  
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
    const currentServer = await getServer();
    const previousIconPath = currentServer?.id === serverId ? currentServer.iconPath || null : null;

    if (typedPayload.storage) {
      const currentStorage = await getServerStorageSettings();
      const currentS3 = currentStorage?.s3;
      const storageInput = typedPayload.storage;

      if (storageInput.enabled) {
        const mergedS3Config = normalizeS3Config({
          endpoint: storageInput.endpoint || currentS3?.endpoint || null,
          region: storageInput.region || currentS3?.region || null,
          bucket: storageInput.bucket || currentS3?.bucket || null,
          accessKey: storageInput.accessKey || currentS3?.accessKey || null,
          secretKey: storageInput.secretKey || currentS3?.secretKey || null,
          prefix: storageInput.prefix ?? currentS3?.prefix ?? null
        });

        const validation = await validateS3Configuration(mergedS3Config);
        if (!validation.ok) {
          await updateServerStorageLastError({
            serverId,
            storageLastError: validation.message
          });
          client.ws.send(JSON.stringify({
            type: 'error',
            payload: { message: validation.message }
          }));
          return;
        }

        await updateServerStorageSettings({
          serverId,
          storageType: 's3',
          s3Endpoint: mergedS3Config.endpoint,
          s3Region: mergedS3Config.region,
          s3Bucket: mergedS3Config.bucket,
          s3AccessKey: mergedS3Config.accessKey,
          s3SecretKey: mergedS3Config.secretKey,
          s3Prefix: mergedS3Config.prefix || null,
          storageLastError: null
        });

        migrateDataDirFilesToS3(serverId, mergedS3Config).catch((migrationError) => {
          console.error('[WS DEBUG] Background migration to S3 failed:', migrationError);
        });
      } else {
        await updateServerStorageSettings({
          serverId,
          storageType: 'data_dir',
          s3Endpoint: currentS3?.endpoint || null,
          s3Region: currentS3?.region || null,
          s3Bucket: currentS3?.bucket || null,
          s3AccessKey: currentS3?.accessKey || null,
          s3SecretKey: currentS3?.secretKey || null,
          s3Prefix: currentS3?.prefix || null,
          storageLastError: null
        });
      }
    }

    let nextIconPath: string | null | undefined = undefined;
    if (typedPayload.removeIcon === true) {
      nextIconPath = null;
    } else if (typeof typedPayload.iconDataUrl === 'string' && typedPayload.iconDataUrl.trim()) {
      nextIconPath = await storeServerIcon(serverId, typedPayload.iconDataUrl);
    }

    await updateServerSettings(serverId, normalizedTitle, rulesChannelId, welcomeChannelId, nextIconPath);

    if (typeof nextIconPath !== 'undefined' && previousIconPath && previousIconPath !== nextIconPath) {
      await cleanupServerIconReference(serverId, previousIconPath);
    }

    if (typeof nextIconPath !== 'undefined') {
      const persistedS3Config = await getPersistedS3Config();
      if (persistedS3Config) {
        const activeKey = nextIconPath && nextIconPath.startsWith('s3:')
          ? nextIconPath.slice('s3:'.length).trim()
          : null;
        try {
          await cleanupStaleS3ServerIcons({
            serverId,
            s3Config: persistedS3Config,
            activeKey: activeKey || null
          });
        } catch (error) {
          console.warn('[WS DEBUG] Failed cleaning up stale S3 server icon objects', { serverId, error });
        }
      }
    }

    const updatedServer = await getServer();
    const updatedStorageSettings = await getServerStorageSettings();
    
    connectionManager.broadcastToAuthenticated({
      type: 'server_settings_updated',
      payload: { server: updatedServer }
    });

    connectionManager.broadcastToAuthenticated({
      type: 'SERVER_UPDATED',
      payload: { server: updatedServer }
    });

    client.ws.send(JSON.stringify({
      type: 'server_storage_settings',
      payload: buildStorageSettingsPayloadForClient(updatedStorageSettings)
    }));
  } catch (error) {
    console.error('[WS DEBUG] Failed to update server settings:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to update server settings' } }));
  }
};

const handleTestServerStorageS3 = async (
  client: ClientConnection,
  payload: {
    storage?: {
      endpoint?: string;
      region?: string;
      bucket?: string;
      accessKey?: string;
      secretKey?: string;
      prefix?: string;
    };
  }
) => {
  if (!client.userId) return;

  const user = await getUserById(client.userId);
  if (!user || user.role !== 'admin') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Only admins can test storage settings' } }));
    return;
  }

  const currentStorage = await getServerStorageSettings();
  const currentS3 = currentStorage?.s3;
  const storageInput = payload?.storage || {};

  try {
    const mergedS3Config = normalizeS3Config({
      endpoint: storageInput.endpoint || currentS3?.endpoint || null,
      region: storageInput.region || currentS3?.region || null,
      bucket: storageInput.bucket || currentS3?.bucket || null,
      accessKey: storageInput.accessKey || currentS3?.accessKey || null,
      secretKey: storageInput.secretKey || currentS3?.secretKey || null,
      prefix: storageInput.prefix ?? currentS3?.prefix ?? null
    });

    const validation = await validateS3Configuration(mergedS3Config);
    client.ws.send(JSON.stringify({
      type: 'server_storage_test_result',
      payload: validation.ok
        ? { ok: true, message: 'S3 connection test succeeded.' }
        : { ok: false, message: validation.message }
    }));
  } catch (error) {
    client.ws.send(JSON.stringify({
      type: 'server_storage_test_result',
      payload: {
        ok: false,
        message: error instanceof Error ? error.message : 'Invalid S3 configuration'
      }
    }));
  }
};

const handleGetServerStorageSettings = async (client: ClientConnection) => {
  if (!client.userId) return;

  const user = await getUserById(client.userId);
  if (!user || user.role !== 'admin') {
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Only admins can read storage settings' } }));
    return;
  }

  try {
    const settings = await getServerStorageSettings();
    client.ws.send(JSON.stringify({
      type: 'server_storage_settings',
      payload: buildStorageSettingsPayloadForClient(settings)
    }));
  } catch (error) {
    console.error('[WS DEBUG] Failed to read storage settings:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to read storage settings' } }));
  }
};

const handleGetServer = async (client: ClientConnection) => {
  if (!client.userId) return;

  try {
    const server = await getServer();
    client.ws.send(JSON.stringify({
      type: 'server_state',
      payload: { server }
    }));
  } catch (error) {
    console.error('[WS DEBUG] Failed to read server state:', error);
    client.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to read server state' } }));
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
  await handleUpdateServerSettings(client, payload);
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

