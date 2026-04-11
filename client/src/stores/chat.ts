import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useWebRtcStore } from './webrtc';
import { readStoredAvatar, removeLegacyStoredAvatar, saveStoredAvatar } from '../utils/avatarStorage';
import { cacheServerIcon, getCachedServerIcon, removeCachedServerIcon } from '../utils/serverIconCache';

const NEW_NOTIFICATION_SOUND_DEBOUNCE_MS = 1000;

export interface User {
  id: string;
  username: string;
  avatar_url: string | null;
  avatar_mime_type?: string | null;
  status_emoji?: string | null;
  status_text?: string | null;
  status?: PresenceStatus;
  role: string;
  role_ids?: string[];
  roles?: ServerRole[];
  created_at: string;
}

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export interface Category {
  id: string;
  name: string;
  position: number;
}

export interface Channel {
  id: string;
  category_id: string | null;
  name: string;
  type: 'text' | 'voice' | 'rss' | 'folder';
  position: number;
  feed_url?: string | null;
}

const compareChannels = (a: Channel, b: Channel) => {
  const aCategory = a.category_id || '';
  const bCategory = b.category_id || '';
  if (aCategory !== bCategory) {
    return aCategory.localeCompare(bCategory);
  }
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  return a.name.localeCompare(b.name);
};

export interface FolderChannelFile {
  id: string;
  channel_id: string;
  original_name: string;
  storage_name?: string;
  mime_type: string | null;
  size_bytes: number;
  uploader_user_id: string;
  uploader_username?: string;
  created_at: string;
  updated_at: string;
}

export type MessageEmbedType = 'youtube' | 'twitch' | 'spotify' | 'link';

export interface MessageEmbed {
  type: MessageEmbedType;
  provider: string;
  url: string;
  displayUrl: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  embedUrl: string | null;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reacted_by_current_user: boolean;
}

export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: string;
  user?: User;
  embeds?: MessageEmbed[];
  attachments?: MessageAttachment[];
  reply_to_message_id?: string | null;
  reply_to_message?: MessageReplyReference | null;
  reactions: MessageReaction[];
}

export interface MessageReplyReference {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: string;
  user?: User;
  attachments?: MessageAttachment[];
  reactions?: MessageReaction[];
}

export interface MessageAttachment {
  id: string;
  message_id?: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number;
  storage_provider?: 'data_dir' | 's3';
  storage_key?: string | null;
  url: string | null;
}

export interface PendingMessageUploadProgress {
  fileName: string;
  loadedBytes: number;
  totalBytes: number;
}

interface ChannelUnreadState {
  channel_id: string;
  unread: boolean | number;
  last_read_message_id?: string | null;
  last_read_message_created_at?: string | null;
  latest_message_id?: string | null;
  latest_message_created_at?: string | null;
}

interface ChannelMessagePageState {
  hasMore: boolean;
  isLoading: boolean;
  oldestMessageCreatedAt: string | null;
  oldestMessageId: string | null;
  initialized: boolean;
}

export interface SavedConnection {
  id: string;
  name: string;
  address: string;
  iconUrl?: string | null;
  cachedIconUrl?: string | null;
}

export interface Server {
  id: string;
  name: string;
  title: string;
  iconPath?: string | null;
  updatedAt?: string | null;
  rulesChannelId?: string | null;
  welcomeChannelId?: string | null;
  storageType?: 'data_dir' | 's3';
}

export interface ServerStorageS3Settings {
  provider: 'generic_s3' | 'cloudflare_r2';
  providerUrl: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  hasAccessKey: boolean;
  hasSecretKey: boolean;
}

export interface ServerStorageTestResult {
  ok: boolean;
  message: string;
}

export type ServerStorageMigrationStatus = 'idle' | 'running' | 'failed';

export interface ServerStorageMigrationState {
  status: ServerStorageMigrationStatus;
  target: 'data_dir' | 's3' | null;
  total: number;
  done: number;
  message: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface ServerStorageSettings {
  storageType: 'data_dir' | 's3';
  storageLastError: string | null;
  s3: ServerStorageS3Settings;
  migration: ServerStorageMigrationState;
}

export interface ServerRole {
  id: string;
  serverId: string;
  key: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  isDeletable: boolean;
  position: number;
  createdAt: string | null;
  updatedAt: string | null;
}

type ServerRoleFormInput = {
  id: string;
  name: string;
  color: string | null;
};

export interface ActiveMainPanel {
  type: 'text' | 'voice' | 'folder';
  channelId: string | null;
}

export type ModerationDeleteMode = 'none' | 'hours' | 'all';

export interface ModerationNotice {
  title: string;
  message: string;
  action: 'kick' | 'ban';
}

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return window.btoa(binary);
};

const arrayBufferToHex = (buffer: ArrayBuffer) => {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

const readLegacyStoredAvatar = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem('avatarUrl');
  } catch {
    return null;
  }
};

const generateKeyPair = async () => {
  return await window.crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  );
};

const exportPublicKey = async (key: CryptoKey) => {
  const exported = await window.crypto.subtle.exportKey("spki", key);
  const base64 = arrayBufferToBase64(exported);
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
};

const exportPrivateKey = async (key: CryptoKey) => {
  const exported = await window.crypto.subtle.exportKey("jwk", key);
  return JSON.stringify(exported);
};

const importPrivateKey = async (jwkString: string) => {
  const jwk = JSON.parse(jwkString);
  return await window.crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign"]
  );
};

const signChallenge = async (privateKey: CryptoKey, challenge: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(challenge);
  const signature = await window.crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: { name: "SHA-256" },
    },
    privateKey,
    data
  );
  return arrayBufferToHex(signature);
};

export interface ClientIdentityExport {
  version: 1;
  exportedAt: string;
  algorithm: 'ECDSA-P256-SHA256';
  publicKey: string;
  privateKeyJwk: string;
}

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

const getBlockedFolderUploadExtension = (fileName: string) => {
  const extension = fileName.split('.').pop()?.trim().toLowerCase() || '';
  if (!extension) {
    return null;
  }
  return BLOCKED_FOLDER_UPLOAD_EXTENSIONS.has(extension) ? extension : null;
};

export const useChatStore = defineStore('chat', () => {
  let lastNewNotificationSoundAt = 0;
  const ws = ref<WebSocket | null>(null);
  const isConnected = ref(false);
  const currentUser = ref<User | null>(null);
  const localAvatar = ref<string | null>(null);
  const currentUserRole = ref<string>('user');
  const server = ref<Server | null>(null);
  const serverRoles = ref<ServerRole[]>([]);
  const uncategorizedCategoryDeleted = ref(false);
  const serverStorageSettings = ref<ServerStorageSettings>({
    storageType: 'data_dir',
    storageLastError: null,
    s3: {
      provider: 'generic_s3',
      providerUrl: '',
      endpoint: '',
      region: '',
      bucket: '',
      prefix: '',
      hasAccessKey: false,
      hasSecretKey: false
    },
    migration: {
      status: 'idle',
      target: null,
      total: 0,
      done: 0,
      message: null,
      startedAt: null,
      updatedAt: null
    }
  });
  const lastError = ref<string | null>(null);
  
  const DEFAULT_NEW_USER_SERVER_ADDRESS = 'wss://rc1.exatek.de:1337';

  const seedDefaultSavedConnections = (): SavedConnection[] => {
    const defaultAddress = DEFAULT_NEW_USER_SERVER_ADDRESS.trim();
    const normalizedDefaultAddress = defaultAddress.replace(/(ws:\/\/|wss:\/\/)?0\.0\.0\.0(?=[:/]|$)/i, (_match, protocol) => `${protocol || ''}localhost`);

    return [
      {
        id: crypto.randomUUID(),
        name: 'rc1.exatek.de',
        address: normalizedDefaultAddress,
        cachedIconUrl: null
      }
    ];
  };

  const readSavedConnections = (): SavedConnection[] => {
    const rawStoredConnections = JSON.parse(localStorage.getItem('savedConnections') || '[]');
    const normalizedConnections = (Array.isArray(rawStoredConnections) ? rawStoredConnections : []).map((c: SavedConnection) => ({
      ...c,
      address: c.address.replace(/(ws:\/\/|wss:\/\/)?0\.0\.0\.0/, (_match, p1) => `${p1 || ''}localhost`),
      cachedIconUrl: c.cachedIconUrl || getCachedServerIcon(c.id)?.dataUrl || null
    }));

    if (normalizedConnections.length > 0) {
      return normalizedConnections;
    }

    const defaultConnections = seedDefaultSavedConnections();
    localStorage.setItem('savedConnections', JSON.stringify(defaultConnections));
    return defaultConnections;
  };

  const savedConnections = ref<SavedConnection[]>(readSavedConnections());
  const activeConnectionId = ref<string | null>(null);
  const localUsername = ref<string | null>(localStorage.getItem('username'));
  const localStatusEmoji = ref<string | null>(localStorage.getItem('statusEmoji'));
  const localStatusText = ref<string | null>(localStorage.getItem('statusText'));
  const users = ref<User[]>([]);
  const onlineUserIds = ref<Set<string>>(new Set());
  const pendingPresenceStatus = ref<PresenceStatus>('online');
  const memberIps = ref<Record<string, string>>({});
  const moderationNotice = ref<ModerationNotice | null>(null);
  
  const categories = ref<Category[]>([]);
  const channels = ref<Channel[]>([]);
  const messages = ref<Record<string, Message[]>>({}); // channel_id -> Message[]
  const folderFiles = ref<Record<string, FolderChannelFile[]>>({});
  const messagePageState = ref<Record<string, ChannelMessagePageState>>({});
  const unreadChannelIds = ref<Set<string>>(new Set());
  
  const activeChannelId = ref<string | null>(null);
  const activeMainPanel = ref<ActiveMainPanel>({ type: 'text', channelId: null });

  const getLastActiveChannelStorageKey = (serverAddress: string) => `lastActiveChannel:${serverAddress}`;

  const getSavedActiveChannelId = (serverAddress: string | null | undefined): string | null => {
    if (!serverAddress) {
      return null;
    }

    const storedChannelId = localStorage.getItem(getLastActiveChannelStorageKey(serverAddress));
    return storedChannelId && storedChannelId.trim() ? storedChannelId : null;
  };

  const getActiveConnectionAddress = (): string | null => {
    if (!activeConnectionId.value) {
      return null;
    }

    return savedConnections.value.find((connection) => connection.id === activeConnectionId.value)?.address || null;
  };

  const persistActiveChannelId = (channelId: string | null, serverAddress: string | null = getActiveConnectionAddress()) => {
    if (!serverAddress) {
      return;
    }

    const storageKey = getLastActiveChannelStorageKey(serverAddress);

    if (channelId && channelId.trim()) {
      localStorage.setItem(storageKey, channelId);
      return;
    }

    localStorage.removeItem(storageKey);
  };

  const getValidSavedActiveTextChannel = (availableChannels: Channel[], serverAddress: string | null = getActiveConnectionAddress()): Channel | null => {
    const savedChannelId = getSavedActiveChannelId(serverAddress);
    if (!savedChannelId) {
      return null;
    }

    return availableChannels.find((channel: Channel) => channel.id === savedChannelId && (channel.type === 'text' || channel.type === 'rss')) || null;
  };

  const activateChannel = (channel: Channel | null) => {
    if (channel && (channel.type === 'text' || channel.type === 'rss')) {
      activeChannelId.value = channel.id;
      activeMainPanel.value = { type: 'text', channelId: channel.id };
      persistActiveChannelId(channel.id);
      clearChannelUnread(channel.id);
      getMessages(channel.id);
      return;
    }

    activeChannelId.value = null;
    activeMainPanel.value = { type: 'text', channelId: null };
    persistActiveChannelId(null);
  };
  
  let pingInterval: number | null = null;
  let pongTimeout: number | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let isIntentionalDisconnect = false;
  let pendingStorageTestResolve: ((result: ServerStorageTestResult) => void) | null = null;
  let pendingStorageTestTimeout: number | null = null;
  const lastMarkedReadMessageByChannel = ref<Record<string, string>>({});
  const pendingMessageUploadProgress = ref<PendingMessageUploadProgress[] | null>(null);

  const setPendingMessageUploadProgress = (progress: PendingMessageUploadProgress[] | null) => {
    pendingMessageUploadProgress.value = progress;
  };

  const clearPendingMessageUploadProgress = () => {
    pendingMessageUploadProgress.value = null;
  };

  const uploadChunkSizeBytes = 8 * 1024 * 1024;

  const normalizeServerStorageSettings = (payload: any): ServerStorageSettings => ({
    storageType: payload.storageType === 's3' ? 's3' : 'data_dir',
    storageLastError: typeof payload.storageLastError === 'string' ? payload.storageLastError : null,
    s3: {
      provider: payload?.s3?.provider === 'cloudflare_r2' ? 'cloudflare_r2' : 'generic_s3',
      providerUrl: payload?.s3?.providerUrl || '',
      endpoint: payload?.s3?.endpoint || '',
      region: payload?.s3?.region || '',
      bucket: payload?.s3?.bucket || '',
      prefix: payload?.s3?.prefix || '',
      hasAccessKey: payload?.s3?.hasAccessKey === true,
      hasSecretKey: payload?.s3?.hasSecretKey === true
    },
    migration: {
      status: payload?.migration?.status === 'running' || payload?.migration?.status === 'failed'
        ? payload.migration.status
        : 'idle',
      target: payload?.migration?.target === 's3' || payload?.migration?.target === 'data_dir'
        ? payload.migration.target
        : null,
      total: Number.isFinite(Number(payload?.migration?.total)) ? Math.max(0, Number(payload.migration.total)) : 0,
      done: Number.isFinite(Number(payload?.migration?.done)) ? Math.max(0, Number(payload.migration.done)) : 0,
      message: typeof payload?.migration?.message === 'string' && payload.migration.message.trim()
        ? payload.migration.message
        : null,
      startedAt: typeof payload?.migration?.startedAt === 'string' && payload.migration.startedAt.trim()
        ? payload.migration.startedAt
        : null,
      updatedAt: typeof payload?.migration?.updatedAt === 'string' && payload.migration.updatedAt.trim()
        ? payload.migration.updatedAt
        : null
    }
  });

  const normalizeServerRole = (role: any): ServerRole | null => {
    if (!role || typeof role !== 'object') {
      return null;
    }

    const id = typeof role.id === 'string' ? role.id : '';
    const serverId = typeof role.serverId === 'string'
      ? role.serverId
      : (typeof role.server_id === 'string' ? role.server_id : '');
    const key = typeof role.key === 'string' ? role.key : '';
    const normalizedName = typeof role.name === 'string' ? role.name.trim() : '';
    const rawColor = typeof role.color === 'string' ? role.color.trim() : '';

    if (!id || !serverId || !key) {
      return null;
    }

    return {
      id,
      serverId,
      key,
      name: normalizedName || key,
      color: /^#([0-9a-fA-F]{6})$/.test(rawColor) ? rawColor.toLowerCase() : null,
      isDefault: role.isDefault === true || role.is_default === true || role.is_default === 1,
      isDeletable: role.isDeletable === true || role.is_deletable === true || role.is_deletable === 1,
      position: Number.isFinite(Number(role.position)) ? Number(role.position) : 0,
      createdAt: typeof role.createdAt === 'string'
        ? role.createdAt
        : (typeof role.created_at === 'string' ? role.created_at : null),
      updatedAt: typeof role.updatedAt === 'string'
        ? role.updatedAt
        : (typeof role.updated_at === 'string' ? role.updated_at : null)
    };
  };

  const normalizeServerRoles = (roles: unknown): ServerRole[] => {
    if (!Array.isArray(roles)) {
      return [];
    }

    return roles
      .map((role) => normalizeServerRole(role))
      .filter((role): role is ServerRole => Boolean(role))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  };

  const applyServerRoles = (roles: unknown) => {
    serverRoles.value = normalizeServerRoles(roles);
  };

  const normalizePresenceStatus = (status: unknown): PresenceStatus => {
    return status === 'idle' || status === 'dnd' || status === 'invisible' ? status : 'online';
  };

  const getNormalizedUserStatus = (user: any): PresenceStatus => {
    return normalizePresenceStatus(
      user?.presence_status ?? user?.effective_presence_status ?? user?.status
    );
  };

  const normalizeUser = (user: any): User => {
    const normalizedRoles = normalizeServerRoles(user?.roles);
    const normalizedRoleIds = Array.isArray(user?.role_ids)
      ? user.role_ids.filter((roleId: unknown): roleId is string => typeof roleId === 'string' && roleId.trim().length > 0)
      : [];
    const statusEmoji = typeof user?.status_emoji === 'string' && user.status_emoji.trim().length > 0
      ? user.status_emoji.trim()
      : null;
    const statusText = typeof user?.status_text === 'string' && user.status_text.trim().length > 0
      ? user.status_text.trim()
      : null;

    return {
      ...user,
      avatar_url: user?.avatar_url || null,
      avatar_mime_type: user?.avatar_mime_type || null,
      status_emoji: statusEmoji,
      status_text: statusText,
      status: getNormalizedUserStatus(user),
      role: typeof user?.role === 'string' && user.role.trim() ? user.role : 'user',
      role_ids: normalizedRoleIds,
      roles: normalizedRoles
    };
  };

  const isUserEffectivelyOnline = (user: User | null | undefined) => {
    if (!user?.id || !onlineUserIds.value.has(user.id)) {
      return false;
    }

    return normalizePresenceStatus(user.status) !== 'invisible';
  };

  const getUserPresenceStatus = (user: User | null | undefined): PresenceStatus => {
    if (!user?.id) {
      return 'invisible';
    }

    if (!onlineUserIds.value.has(user.id)) {
      return 'invisible';
    }

    return normalizePresenceStatus(user.status);
  };

  const setPresenceStatus = (status: PresenceStatus) => {
    const normalizedStatus = normalizePresenceStatus(status);
    pendingPresenceStatus.value = normalizedStatus;

    if (currentUser.value) {
      currentUser.value = {
        ...currentUser.value,
        status: normalizedStatus
      };

      const existingIndex = users.value.findIndex((user) => user.id === currentUser.value?.id);
      if (existingIndex >= 0) {
        const nextUsers = [...users.value];
        nextUsers[existingIndex] = {
          ...nextUsers[existingIndex],
          status: normalizedStatus
        };
        users.value = nextUsers;
      }
    }

    send('set_presence', { status: normalizedStatus });
  };

  const getPrimaryServerRole = (user: User | null | undefined) => {
    if (!user) {
      return null;
    }

    const userRoleIds = Array.isArray(user.role_ids) ? user.role_ids : [];
    const userRoles = Array.isArray(user.roles) ? user.roles : [];
    const resolvedRoles = userRoles.length > 0
      ? userRoles
      : serverRoles.value.filter((role) => userRoleIds.includes(role.id));

    return resolvedRoles.find((role) => role.key !== 'all_users')
      || resolvedRoles[0]
      || getServerRoleByKey(user.role)
      || null;
  };

  const getUserRoleKeys = (user: User | null | undefined): string[] => {
    const primaryRole = user?.role || 'user';
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    const keys = roles.map((role) => role.key).filter(Boolean);
    return Array.from(new Set([primaryRole, ...keys]));
  };

  const userHasRole = (user: User | null | undefined, roleKeys: string[]) => {
    const keys = new Set(getUserRoleKeys(user));
    return roleKeys.some((roleKey) => keys.has(roleKey));
  };

  const getServerRoleByKey = (roleKey: string | null | undefined) => {
    const normalizedRoleKey = typeof roleKey === 'string' ? roleKey.trim() : '';
    if (!normalizedRoleKey) {
      return null;
    }

    return serverRoles.value.find((role) => role.key === normalizedRoleKey) || null;
  };

  const getServerRoleColor = (roleKey: string | null | undefined) => {
    return getServerRoleByKey(roleKey)?.color || null;
  };

  const readBlobAsArrayBuffer = (blob: Blob) => {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new Error('Failed to read file chunk'));
          return;
        }
        resolve(reader.result);
      };
      reader.onerror = () => reject(new Error('Failed to read file chunk'));
      reader.readAsArrayBuffer(blob);
    });
  };

  const readFileAsDataBase64WithProgress = async (file: File, onProgress?: (loadedBytes: number, totalBytes: number) => void) => {
    const parts: string[] = [];
    let offset = 0;

    while (offset < file.size) {
      const end = Math.min(offset + uploadChunkSizeBytes, file.size);
      const chunk = file.slice(offset, end);
      const arrayBuffer = await readBlobAsArrayBuffer(chunk);
      parts.push(arrayBufferToBase64(arrayBuffer));
      offset = end;
      onProgress?.(offset, file.size);
    }

    return parts.join('');
  };

  const waitForSocketMessage = <T>(matcher: (message: any) => T | null, timeoutMs = 30000): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        removeMessageListener(listener);
        reject(new Error('Upload request timed out'));
      }, timeoutMs);

      const listener = (message: any) => {
        const matched = matcher(message);
        if (matched === null) {
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        removeMessageListener(listener);
        resolve(matched);
      };

      addMessageListener(listener);
    });
  };

  const uploadFileOverWebSocket = async (input: {
    kind: 'message_attachment' | 'folder_file';
    channelId: string;
    file: File;
    onProgress?: (loadedBytes: number, totalBytes: number) => void;
    content?: string;
    replyToMessageId?: string | null;
  }) => {
    const readyPromise = waitForSocketMessage((message) => {
      if (message?.type === 'file_upload_ready' && message?.payload?.channel_id === input.channelId) {
        return message.payload as { upload_id: string; chunk_size_bytes?: number };
      }
      if (message?.type === 'error') {
        throw new Error(message?.payload?.message || 'Upload initialization failed');
      }
      return null;
    });

    send('begin_file_upload', {
      kind: input.kind,
      channel_id: input.channelId,
      file_name: input.file.name,
      mime_type: input.file.type || 'application/octet-stream',
      size_bytes: input.file.size
    });

    const ready = await readyPromise;
    const uploadId = ready.upload_id;
    const chunkSize = typeof ready.chunk_size_bytes === 'number' && ready.chunk_size_bytes > 0
      ? ready.chunk_size_bytes
      : uploadChunkSizeBytes;

    let offset = 0;
    while (offset < input.file.size) {
      const end = Math.min(offset + chunkSize, input.file.size);
      const arrayBuffer = await readBlobAsArrayBuffer(input.file.slice(offset, end));
      const dataBase64 = arrayBufferToBase64(arrayBuffer);

      const ackPromise = waitForSocketMessage((message) => {
        if (message?.type === 'file_upload_chunk_ack' && message?.payload?.upload_id === uploadId) {
          return message.payload as { received_bytes: number };
        }
        if (message?.type === 'error') {
          throw new Error(message?.payload?.message || 'Upload chunk failed');
        }
        return null;
      });

      send('upload_file_chunk', {
        upload_id: uploadId,
        offset,
        data_base64: dataBase64
      });

      const ack = await ackPromise;
      offset = ack.received_bytes;
      input.onProgress?.(offset, input.file.size);
    }

    send('complete_file_upload', {
      upload_id: uploadId,
      content: input.content,
      reply_to_message_id: input.replyToMessageId || null
    });
  };

  const saveLocalUsername = (username: string) => {
    localUsername.value = username;
    localStorage.setItem('username', username);
  };

  const saveLocalStatusEmoji = (statusEmoji: string | null) => {
    const normalizedStatusEmoji = typeof statusEmoji === 'string' && statusEmoji.trim().length > 0
      ? statusEmoji.trim()
      : null;

    localStatusEmoji.value = normalizedStatusEmoji;
    if (normalizedStatusEmoji) {
      localStorage.setItem('statusEmoji', normalizedStatusEmoji);
    } else {
      localStorage.removeItem('statusEmoji');
    }

    if (currentUser.value) {
      currentUser.value = {
        ...currentUser.value,
        status_emoji: normalizedStatusEmoji
      };
    }
  };

  const saveLocalStatusText = (statusText: string | null) => {
    const normalizedStatusText = typeof statusText === 'string' && statusText.trim().length > 0
      ? statusText.trim()
      : null;

    localStatusText.value = normalizedStatusText;
    if (normalizedStatusText) {
      localStorage.setItem('statusText', normalizedStatusText);
    } else {
      localStorage.removeItem('statusText');
    }

    if (currentUser.value) {
      currentUser.value = {
        ...currentUser.value,
        status_text: normalizedStatusText
      };
    }
  };

  const saveStatusPreference = async (input: { statusEmoji: string | null; statusText: string | null }) => {
    saveLocalStatusEmoji(input.statusEmoji);
    saveLocalStatusText(input.statusText);

    if (!ws.value || !isConnected.value) {
      return;
    }

    send('set_status_profile', {
      statusEmoji: localStatusEmoji.value,
      statusText: localStatusText.value
    });
  };

  const initializeStoredAvatar = async () => {
    const storedAvatar = await readStoredAvatar();
    if (storedAvatar !== null) {
      localAvatar.value = storedAvatar;
      removeLegacyStoredAvatar();
      return storedAvatar;
    }

    const legacyStoredAvatar = readLegacyStoredAvatar();
    if (legacyStoredAvatar !== null) {
      localAvatar.value = legacyStoredAvatar;
      await saveStoredAvatar(legacyStoredAvatar);
      removeLegacyStoredAvatar();
      return legacyStoredAvatar;
    }

    localAvatar.value = null;
    removeLegacyStoredAvatar();
    return null;
  };

  const saveLocalAvatar = async (avatarUrl: string | null) => {
    localAvatar.value = avatarUrl;
    await saveStoredAvatar(avatarUrl);
    removeLegacyStoredAvatar();
  };

  const getLocalAvatar = () => localAvatar.value;

  const getAuthAvatarDataUrl = () => {
    if (typeof localAvatar.value !== 'string') {
      return null;
    }

    return /^data:image\/(png|jpeg|gif);base64,/i.test(localAvatar.value)
      ? localAvatar.value
      : null;
  };

  const DEFAULT_SERVER_PORT = '1337';
  const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

  const isLocalServerHostname = (hostname: string) => {
    const normalizedHostname = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
    return LOCALHOST_HOSTNAMES.has(normalizedHostname);
  };

  const normalizeServerAddress = (address: string) => {
    const wsUrl = address.trim();
    if (!wsUrl) return wsUrl;

    const hasProtocol = /^wss?:\/\//i.test(wsUrl);
    const rawAddress = hasProtocol ? wsUrl.replace(/^wss?:\/\//i, '') : wsUrl;
    const [rawHostAndPort = '', ...pathParts] = rawAddress.split('/');
    const normalizedHostAndPort = rawHostAndPort.replace(/^0\.0\.0\.0(?=[:$])/i, 'localhost');
    const hostMatch = normalizedHostAndPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
    const hostForProtocol = hostMatch
      ? hostMatch[1] || ''
      : normalizedHostAndPort.replace(/:(\d+)$/, '');
    const protocol = hasProtocol
      ? (wsUrl.toLowerCase().startsWith('wss://') ? 'wss://' : 'ws://')
      : (isLocalServerHostname(hostForProtocol) ? 'ws://' : 'wss://');
    const hasPort = hostMatch ? Boolean(hostMatch[2]) : /:\d+$/.test(normalizedHostAndPort);
    const normalizedPath = pathParts.length > 0 ? `/${pathParts.join('/')}` : '';

    console.log('[DEBUG] normalizeServerAddress', {
      input: address,
      trimmedInput: wsUrl,
      hasProtocol,
      rawHostAndPort,
      normalizedHostAndPort,
      hostForProtocol,
      selectedProtocol: protocol,
      hasPort,
      normalizedPath,
    });

    return `${protocol}${normalizedHostAndPort}${hasPort ? '' : `:${DEFAULT_SERVER_PORT}`}${normalizedPath}`;
  };

  const getHttpBaseFromWsAddress = (address: string) => {
    try {
      const normalizedAddress = normalizeServerAddress(address);
      const wsUrl = new URL(normalizedAddress);
      const protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
      return `${protocol}//${wsUrl.host}`;
    } catch {
      return window.location.origin;
    }
  };

  const appendServerIconVersion = (url: string, version?: string | null) => {
    const normalizedVersion = (version || '').trim();
    if (!normalizedVersion) {
      return url;
    }

    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}v=${encodeURIComponent(normalizedVersion)}`;
  };

  const resolveConnectedServerBaseUrl = (wsAddress?: string | null) => {
    if (wsAddress) {
      return getHttpBaseFromWsAddress(wsAddress);
    }

    const activeConnection = activeConnectionId.value
      ? savedConnections.value.find((connection) => connection.id === activeConnectionId.value)
      : null;

    return activeConnection
      ? getHttpBaseFromWsAddress(activeConnection.address)
      : window.location.origin;
  };

  const resolveAttachmentUrl = (attachmentUrl?: string | null, wsAddress?: string | null) => {
    const url = (attachmentUrl || '').trim();
    if (!url) {
      return null;
    }

    if (/^(data:|blob:|https?:\/\/|\/\/)/i.test(url)) {
      return url;
    }

    const normalizedPath = url.startsWith('/') ? url : `/${url}`;
    return `${resolveConnectedServerBaseUrl(wsAddress)}${normalizedPath}`;
  };

  const normalizeMessageAttachments = (message: Message, wsAddress?: string | null): Message => {
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
      return message;
    }

    return {
      ...message,
      attachments: message.attachments.map((attachment) => ({
        ...attachment,
        url: resolveAttachmentUrl(attachment.url, wsAddress)
      }))
    };
  };

  const normalizeMessageReactions = (reactions: unknown): MessageReaction[] => {
    if (!Array.isArray(reactions)) {
      return [];
    }

    return reactions
      .map((reaction): MessageReaction | null => {
        if (!reaction || typeof reaction !== 'object') {
          return null;
        }

        const emoji = typeof (reaction as { emoji?: unknown }).emoji === 'string'
          ? (reaction as { emoji: string }).emoji.trim()
          : '';
        const rawCount = (reaction as { count?: unknown }).count;
        const count = typeof rawCount === 'number' && Number.isFinite(rawCount)
          ? Math.max(0, Math.floor(rawCount))
          : 0;

        if (!emoji || count <= 0) {
          return null;
        }

        return {
          emoji,
          count,
          reacted_by_current_user: (reaction as { reacted_by_current_user?: unknown }).reacted_by_current_user === true
        };
      })
      .filter((reaction): reaction is MessageReaction => Boolean(reaction))
      .sort((a, b) => a.emoji.localeCompare(b.emoji));
  };

  const normalizeMessageShape = <T extends Message | MessageReplyReference>(message: T): T => {
    return {
      ...message,
      reactions: normalizeMessageReactions((message as { reactions?: unknown }).reactions)
    } as T;
  };

  const normalizeIncomingMessage = (message: Message, wsAddress?: string | null) => {
    const normalizedMessage = normalizeMessageShape(normalizeMessageAttachments(message, wsAddress));

    if (!normalizedMessage.reply_to_message) {
      return normalizedMessage;
    }

    return {
      ...normalizedMessage,
      reply_to_message: normalizeMessageShape(normalizeMessageAttachments(normalizedMessage.reply_to_message as Message, wsAddress))
    };
  };

  const normalizeIncomingMessages = (incomingMessages: Message[], wsAddress?: string | null) => {
    return incomingMessages.map((message) => normalizeIncomingMessage(message, wsAddress));
  };

  const resolveServerIconUrl = (iconPath?: string | null, wsAddress?: string | null, version?: string | null) => {
    const path = (iconPath || '').trim();
    if (!path) {
      return null;
    }

    if (path.startsWith('s3:')) {
      const key = path.slice(3).trim();
      if (!key) {
        return null;
      }

      return appendServerIconVersion(`${resolveConnectedServerBaseUrl(wsAddress)}/server-icons/s3/${encodeURIComponent(key)}`, version);
    }

    if (/^(data:|blob:|https?:\/\/|\/\/)/i.test(path)) {
      return path;
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return appendServerIconVersion(`${resolveConnectedServerBaseUrl(wsAddress)}${normalizedPath}`, version);
  };

  const requestServerRefresh = () => {
    send('get_server');
  };

  const getConnectionNameFromAddress = (address: string) => {
    try {
      const normalizedForParsing = address.startsWith('ws://') || address.startsWith('wss://')
        ? address
        : `ws://${address}`;
      const url = new URL(normalizedForParsing);
      return url.hostname || address;
    } catch {
      return address;
    }
  };

  const addSavedConnection = (address: string, name?: string) => {
    // Replace 0.0.0.0 with localhost to prevent browser connection errors
    address = normalizeServerAddress(address);

    const existing = savedConnections.value.find((c) => c.address === address);
    if (existing) {
      return existing;
    }

    const newConnection: SavedConnection = {
      id: crypto.randomUUID(),
      name: (name || getConnectionNameFromAddress(address)).trim() || 'Server',
      address,
      cachedIconUrl: null
    };
    savedConnections.value.push(newConnection);
    localStorage.setItem('savedConnections', JSON.stringify(savedConnections.value));
    return newConnection;
  };

  const validateServerConnection = (address: string) => {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = normalizeServerAddress(address);
      if (!wsUrl) {
        reject(new Error('WebSocket address is required'));
        return;
      }

      let settled = false;
      const testSocket = new WebSocket(wsUrl);
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        testSocket.close();
        reject(new Error('Connection timed out'));
      }, 5000);

      testSocket.onopen = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        testSocket.close();
        resolve();
      };

      testSocket.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error('Failed to connect to server'));
      };

      testSocket.onclose = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error('Failed to connect to server'));
      };
    });
  };

  const addServerConnection = async (address: string) => {
    lastError.value = null;
    const wsUrl = normalizeServerAddress(address);
    if (!wsUrl) {
      lastError.value = 'WebSocket address is required';
      return false;
    }

    try {
      await validateServerConnection(wsUrl);
      const connection = addSavedConnection(wsUrl);
      connect(connection.address);
      return true;
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to connect to server';
      return false;
    }
  };

  const removeSavedConnection = (id: string) => {
    savedConnections.value = savedConnections.value.filter(c => c.id !== id);
    localStorage.setItem('savedConnections', JSON.stringify(savedConnections.value));
    
    if (activeConnectionId.value === id) {
      disconnect();
      localStorage.removeItem('lastUsedServer');
    }
  };

  const hasStoredIdentity = computed(() => {
    const storedPriv = localStorage.getItem('privateKey');
    const storedPub = localStorage.getItem('publicKey');
    return Boolean(storedPriv && storedPub);
  });

  const getStoredIdentityExport = (): ClientIdentityExport | null => {
    const storedPriv = localStorage.getItem('privateKey');
    const storedPub = localStorage.getItem('publicKey');

    if (!storedPriv || !storedPub) {
      return null;
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      algorithm: 'ECDSA-P256-SHA256',
      publicKey: storedPub,
      privateKeyJwk: storedPriv
    };
  };

  const importStoredIdentity = async (identity: ClientIdentityExport) => {
    if (identity.version !== 1) {
      throw new Error('Unsupported identity export version.');
    }

    if (identity.algorithm !== 'ECDSA-P256-SHA256') {
      throw new Error('Unsupported identity algorithm.');
    }

    if (typeof identity.publicKey !== 'string' || !identity.publicKey.includes('-----BEGIN PUBLIC KEY-----')) {
      throw new Error('Identity file is missing a valid public key.');
    }

    if (typeof identity.privateKeyJwk !== 'string' || !identity.privateKeyJwk.trim()) {
      throw new Error('Identity file is missing a valid private key.');
    }

    await importPrivateKey(identity.privateKeyJwk);

    localStorage.setItem('privateKey', identity.privateKeyJwk);
    localStorage.setItem('publicKey', identity.publicKey);
  };

  const getKeys = async () => {
    const storedPriv = localStorage.getItem('privateKey');
    const storedPub = localStorage.getItem('publicKey');
    
    if (storedPriv && storedPub && storedPub.includes('-----BEGIN PUBLIC KEY-----')) {
      try {
        const privateKey = await importPrivateKey(storedPriv);
        return { privateKey, publicKeyBase64: storedPub };
      } catch (e) {
        console.error("Failed to import stored key, generating new one", e);
      }
    }
    
    const keyPair = await generateKeyPair();
    const privateJwk = await exportPrivateKey(keyPair.privateKey);
    const publicPem = await exportPublicKey(keyPair.publicKey);
    
    localStorage.setItem('privateKey', privateJwk);
    localStorage.setItem('publicKey', publicPem);
    
    return { privateKey: keyPair.privateKey, publicKeyBase64: publicPem };
  };

  const scheduleReconnect = (url: string) => {
    if (reconnectTimer) return;
    
    // Fast initial reconnect (500ms), exponential backoff with jitter, max 5000ms
    const baseDelay = Math.min(500 * Math.pow(1.5, reconnectAttempts), 5000);
    const jitter = Math.random() * 200; // Add up to 200ms of jitter
    const delay = Math.floor(baseDelay + jitter);
    
    console.log(`Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts + 1})`);
    
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempts++;
      connect(url, false); 
    }, delay);
  };

  const connect = (address?: string, isAutoStartup: boolean = false) => {
    isIntentionalDisconnect = false;
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    console.log(`[DEBUG] connect called with address: ${address}`);
    console.log(`[DEBUG] window.location.hostname: ${window.location.hostname}`);
    
    let wsUrl = address;
    if (!wsUrl) {
      // Use wss:// and the current hostname, fallback to localhost:1337
      let host = window.location.hostname || 'localhost';
      if (host === '0.0.0.0') {
        host = 'localhost';
      }
      const port = DEFAULT_SERVER_PORT; // Assuming server is on 1337
      // Use wss:// if the page is loaded over https, otherwise ws://
      const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      wsUrl = `${protocol}${host}:${port}`;
    } else if (wsUrl.startsWith('ws://') && window.location.protocol === 'https:') {
      console.log('[DEBUG] Preserving explicit ws:// address on https page', { input: wsUrl });
    }

    console.log('[DEBUG] connect pre-normalize wsUrl', { inputAddress: address, preNormalizedWsUrl: wsUrl });

    wsUrl = normalizeServerAddress(wsUrl);

    console.log(`[DEBUG] Final wsUrl: ${wsUrl}`);

    if (ws.value) {
      if (ws.value.url === wsUrl) return;
      disconnect();
    }
    
    isIntentionalDisconnect = false;
    
    const connection = savedConnections.value.find(c => c.address === wsUrl);
    activeConnectionId.value = connection ? connection.id : null;
    
    localStorage.setItem('lastUsedServer', wsUrl);
    
    ws.value = new WebSocket(wsUrl);
    
    let hasConnectedOnce = false;

    ws.value.onopen = () => {
      hasConnectedOnce = true;
      isConnected.value = true;
      reconnectAttempts = 0;
      console.log('WebSocket connected');
      
      if (localUsername.value) {
        authenticate(localUsername.value);
      }

      // Start client-side heartbeat
      pingInterval = window.setInterval(() => {
        if (ws.value?.readyState === WebSocket.OPEN) {
          // Send a custom ping message if needed, or just rely on server pings.
          // Since we are using native ws.ping() on the server, the browser handles pongs automatically.
          // However, we still want to ensure the connection is alive from the client's perspective.
          // We can send a custom ping message to the server.
          send('ping', {});
          
          // Set a timeout to wait for a pong response
          pongTimeout = window.setTimeout(() => {
            console.warn('WebSocket pong timeout, reconnecting...');
            if (ws.value) {
              ws.value.close(); // This will trigger onclose and schedule a reconnect
            }
          }, 10000); // 10 seconds to respond
        }
      }, 30000); // 30 seconds interval
    };
    
    ws.value.onclose = () => {
      isConnected.value = false;
      ws.value = null;
      console.log('WebSocket disconnected');
      
      if (pingInterval) {
        window.clearInterval(pingInterval);
        pingInterval = null;
      }
      if (pongTimeout) {
        window.clearTimeout(pongTimeout);
        pongTimeout = null;
      }
      
      if (!isIntentionalDisconnect) {
        if (isAutoStartup && !hasConnectedOnce) {
          console.log('Connection failed on automatic startup, not reconnecting.');
          return;
        }
        
        scheduleReconnect(wsUrl);
      }
    };
    
    ws.value.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    ws.value.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong') {
          if (pongTimeout) {
            window.clearTimeout(pongTimeout);
            pongTimeout = null;
          }
          return;
        }
        handleMessage(data);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };
  };

  const disconnect = () => {
    isIntentionalDisconnect = true;
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingInterval) {
      window.clearInterval(pingInterval);
      pingInterval = null;
    }
    if (pongTimeout) {
      window.clearTimeout(pongTimeout);
      pongTimeout = null;
    }

    if (ws.value) {
      ws.value.onclose = null;
      ws.value.close();
      ws.value = null;
    }
    isConnected.value = false;
    activeConnectionId.value = null;
    categories.value = [];
    channels.value = [];
    uncategorizedCategoryDeleted.value = false;
    activeChannelId.value = null;
    activeMainPanel.value = { type: 'text', channelId: null };
    messages.value = {};
    folderFiles.value = {};
    messagePageState.value = {};
    unreadChannelIds.value = new Set();
    lastMarkedReadMessageByChannel.value = {};
    users.value = [];
    serverRoles.value = [];
    onlineUserIds.value.clear();
    currentUser.value = null;
    server.value = null;
      serverStorageSettings.value = {
        storageType: 'data_dir',
        storageLastError: null,
        s3: {
          provider: 'generic_s3',
          providerUrl: '',
          endpoint: '',
          region: '',
          bucket: '',
          hasAccessKey: false,
          hasSecretKey: false,
          prefix: ''
        },
        migration: {
          status: 'idle',
          target: null,
          total: 0,
          done: 0,
          message: null,
          startedAt: null,
          updatedAt: null
        }
      };
  };

  const messageListeners = ref<((message: any) => void)[]>([]);

  const applyServerState = (nextServer: Server) => {
    server.value = nextServer;

    if (activeConnectionId.value) {
      const currentConnection = savedConnections.value.find((c) => c.id === activeConnectionId.value);
      if (currentConnection) {
        const nextTitle = (nextServer.title || '').trim();
        const resolvedIconUrl = resolveServerIconUrl(nextServer.iconPath || null, currentConnection.address, nextServer.updatedAt || null);
        const cachedEntry = getCachedServerIcon(currentConnection.id);
        let hasChanges = false;

        if (nextTitle && currentConnection.name !== nextTitle) {
          currentConnection.name = nextTitle;
          hasChanges = true;
        }

        if ((currentConnection.iconUrl || null) !== resolvedIconUrl) {
          currentConnection.iconUrl = resolvedIconUrl;
          hasChanges = true;
        }

        const nextCachedIconUrl = cachedEntry?.dataUrl || currentConnection.cachedIconUrl || null;
        if ((currentConnection.cachedIconUrl || null) !== nextCachedIconUrl) {
          currentConnection.cachedIconUrl = nextCachedIconUrl;
          hasChanges = true;
        }

        if (resolvedIconUrl) {
          void cacheServerIcon(currentConnection.id, resolvedIconUrl).then((entry) => {
            if (!entry) {
              return;
            }

            const refreshedConnection = savedConnections.value.find((c) => c.id === currentConnection.id);
            if (!refreshedConnection) {
              return;
            }

            if (refreshedConnection.cachedIconUrl !== entry.dataUrl) {
              refreshedConnection.cachedIconUrl = entry.dataUrl;
              localStorage.setItem('savedConnections', JSON.stringify(savedConnections.value));
            }
          });
        } else if (currentConnection.cachedIconUrl || cachedEntry) {
          currentConnection.cachedIconUrl = null;
          removeCachedServerIcon(currentConnection.id);
          hasChanges = true;
        }

        if (hasChanges) {
          localStorage.setItem('savedConnections', JSON.stringify(savedConnections.value));
        }
      }

      if (!currentConnection && nextServer.title) {
        localStorage.setItem('savedConnections', JSON.stringify(savedConnections.value));
      }
    }
  };

  const removeCurrentServerAndFallback = () => {
    const removedConnectionId = activeConnectionId.value;
    if (!removedConnectionId) {
      disconnect();
      return;
    }

    const currentConnection = savedConnections.value.find((c) => c.id === removedConnectionId);
    removeCachedServerIcon(removedConnectionId);
    savedConnections.value = savedConnections.value.filter((c) => c.id !== removedConnectionId);
    localStorage.setItem('savedConnections', JSON.stringify(savedConnections.value));

    const lastUsedServer = localStorage.getItem('lastUsedServer');
    if (currentConnection && lastUsedServer === currentConnection.address) {
      const fallbackConnection = savedConnections.value[0];
      if (fallbackConnection) {
        localStorage.setItem('lastUsedServer', fallbackConnection.address);
      } else {
        localStorage.removeItem('lastUsedServer');
      }
    }

    const fallbackConnection = savedConnections.value[0];
    disconnect();

    if (fallbackConnection) {
      connect(fallbackConnection.address);
    }
  };

  const addMessageListener = (listener: (message: any) => void) => {
    messageListeners.value.push(listener);
  };

  const createDefaultMessagePageState = (): ChannelMessagePageState => ({
    hasMore: false,
    isLoading: false,
    oldestMessageCreatedAt: null,
    oldestMessageId: null,
    initialized: false
  });

  const ensureMessagePageState = (channelId: string): ChannelMessagePageState => {
    if (!messagePageState.value[channelId]) {
      messagePageState.value[channelId] = createDefaultMessagePageState();
    }
    return messagePageState.value[channelId]!;
  };

  const isUnreadEligibleChannel = (channel: Channel | undefined) => {
    return channel?.type === 'text' || channel?.type === 'rss';
  };

  const markChannelUnread = (channelId: string) => {
    const channel = channels.value.find((c) => c.id === channelId);
    if (!isUnreadEligibleChannel(channel)) {
      return;
    }

    if (activeMainPanel.value.type === 'text' && activeMainPanel.value.channelId === channelId) {
      return;
    }

    const next = new Set(unreadChannelIds.value);
    next.add(channelId);
    unreadChannelIds.value = next;
  };

  const clearChannelUnread = (channelId: string) => {
    if (!unreadChannelIds.value.has(channelId)) {
      return;
    }

    const next = new Set(unreadChannelIds.value);
    next.delete(channelId);
    unreadChannelIds.value = next;
  };

  const removeMessageFromChannel = (channelId: string, messageId: string) => {
    if (!channelId || !messageId) {
      return;
    }

    const existingMessages = messages.value[channelId];
    if (!existingMessages?.length) {
      return;
    }

    messages.value[channelId] = existingMessages.filter((message) => message.id !== messageId);
    markActiveChannelReadFromMessages(channelId);
  };

  const updateMessageInChannel = (channelId: string, messageId: string, updater: (message: Message) => Message) => {
    if (!channelId || !messageId) {
      return;
    }

    const existingMessages = messages.value[channelId];
    if (!existingMessages?.length) {
      return;
    }

    let didUpdate = false;
    messages.value[channelId] = existingMessages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }

      didUpdate = true;
      return updater(message);
    });

    if (!didUpdate) {
      return;
    }
  };

  const markChannelReadOnServer = (channelId: string, message: Message | null | undefined) => {
    if (!message?.id || !message?.created_at) {
      return;
    }

    if (lastMarkedReadMessageByChannel.value[channelId] === message.id) {
      return;
    }

    lastMarkedReadMessageByChannel.value = {
      ...lastMarkedReadMessageByChannel.value,
      [channelId]: message.id
    };

    send('mark_channel_read', {
      channel_id: channelId,
      last_read_message_id: message.id,
      last_read_message_created_at: message.created_at
    });
  };

  const markActiveChannelReadFromMessages = (channelId: string) => {
    if (activeMainPanel.value.type !== 'text' || activeMainPanel.value.channelId !== channelId) {
      return;
    }

    const channelMessages = messages.value[channelId] || [];
    const lastMessage = channelMessages.length > 0 ? channelMessages[channelMessages.length - 1] : null;
    clearChannelUnread(channelId);
    markChannelReadOnServer(channelId, lastMessage);
  };

  const applyUnreadStatesFromServer = (incomingStates: ChannelUnreadState[] | undefined) => {
    if (!incomingStates) return;

    const unreadIds = incomingStates
      .filter((state) => state && (state.unread === true || state.unread === 1))
      .map((state) => state.channel_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    unreadChannelIds.value = new Set(unreadIds);
  };

  const pruneUnreadChannels = (availableChannels: Channel[]) => {
    const allowedIds = new Set(
      availableChannels
        .filter((c) => c.type === 'text' || c.type === 'rss')
        .map((c) => c.id)
    );

    unreadChannelIds.value = new Set(
      Array.from(unreadChannelIds.value).filter((id) => allowedIds.has(id))
    );
  };

  const removeMessageListener = (listener: (message: any) => void) => {
    messageListeners.value = messageListeners.value.filter(l => l !== listener);
  };

  const playNewMessageNotificationSound = () => {
    const webRtcStore = useWebRtcStore();
    if (webRtcStore.isDeafened) {
      return;
    }

    const now = Date.now();
    if (now - lastNewNotificationSoundAt < NEW_NOTIFICATION_SOUND_DEBOUNCE_MS) {
      return;
    }
    lastNewNotificationSoundAt = now;

    const audio = new Audio('/wav/new_notification.mp3');
    audio.volume = 0.7;
    void audio.play().catch((error) => {
      console.debug('[Chat][sound] new message notification playback blocked/failed', error);
    });
  };

  const handleMessage = async (message: any) => {
    const { type, payload } = message;
    
    // Notify listeners
    messageListeners.value.forEach(listener => listener(message));
    
    switch (type) {
      case 'auth:challenge':
        try {
          const { privateKey } = await getKeys();
          const signature = await signChallenge(privateKey, payload.challenge);
          send('auth:response', { signature });
        } catch (e) {
          console.error("Failed to sign challenge", e);
        }
        break;

      case 'authenticated':
        currentUser.value = normalizeUser(payload.user);
        pendingPresenceStatus.value = normalizePresenceStatus(currentUser.value.status);
        currentUserRole.value = currentUser.value.role || 'user';
        removeLegacyStoredAvatar();
        if ((currentUser.value.avatar_url || null) !== localAvatar.value) {
          localAvatar.value = currentUser.value.avatar_url || null;
          void saveStoredAvatar(localAvatar.value);
        }
        saveLocalStatusEmoji(currentUser.value.status_emoji || null);
        saveLocalStatusText(currentUser.value.status_text || null);
        if (payload.server) {
          applyServerState(payload.server);
        }
        if ((payload.user.role || 'user') === 'admin') {
          requestServerStorageSettings();
        }
        requestServerRoles();
        saveLocalUsername(payload.user.username);
        getChannels();
        break;
        
      case 'SERVER_SETTINGS_UPDATED':
      case 'server_settings_updated':
      case 'SERVER_UPDATED':
        if (payload.server) {
          applyServerState(payload.server);
        }
        break;

      case 'server_state':
        if (payload.server) {
          applyServerState(payload.server);
        }
        break;

      case 'server_storage_settings':
        serverStorageSettings.value = normalizeServerStorageSettings(payload);
        break;

      case 'server_storage_migration_progress':
        serverStorageSettings.value = normalizeServerStorageSettings(payload);
        break;

      case 'server_storage_test_result': {
        const result: ServerStorageTestResult = {
          ok: payload?.ok === true,
          message: typeof payload?.message === 'string' && payload.message.trim()
            ? payload.message
            : (payload?.ok === true ? 'S3 connection test succeeded.' : 'S3 connection test failed.')
        };

        if (pendingStorageTestTimeout) {
          window.clearTimeout(pendingStorageTestTimeout);
          pendingStorageTestTimeout = null;
        }

        if (pendingStorageTestResolve) {
          pendingStorageTestResolve(result);
          pendingStorageTestResolve = null;
        }
        break;
      }

      case 'server_roles_list':
      case 'server_roles_updated':
        applyServerRoles(payload.roles);
        break;
        
      case 'member_list':
        users.value = Array.isArray(payload.members) ? payload.members.map((member: any) => normalizeUser(member)) : [];
        onlineUserIds.value = new Set(payload.onlineUserIds);
        memberIps.value = payload.memberIps || {};
        if (currentUser.value) {
          const refreshedCurrentUser = users.value.find((user) => user.id === currentUser.value?.id) || currentUser.value;
          currentUser.value = {
            ...refreshedCurrentUser,
            status: normalizePresenceStatus(refreshedCurrentUser.status)
          };
          pendingPresenceStatus.value = normalizePresenceStatus(currentUser.value.status);
        }
        break;

      case 'member_roles_updated': {
        const updatedUser = normalizeUser(payload.user);
        const existingIndex = users.value.findIndex((user) => user.id === updatedUser.id);
        if (existingIndex >= 0) {
          const nextUsers = [...users.value];
          nextUsers.splice(existingIndex, 1, updatedUser);
          users.value = nextUsers;
        }

        if (currentUser.value?.id === updatedUser.id) {
          currentUser.value = updatedUser;
          pendingPresenceStatus.value = normalizePresenceStatus(updatedUser.status);
          currentUserRole.value = updatedUser.role;
        }
        break;
      }

      case 'presence_updated':
      case 'user_presence_updated': {
        const updatedUser = normalizeUser(payload.user);
        const existingIndex = users.value.findIndex((user) => user.id === updatedUser.id);
        if (existingIndex >= 0) {
          const nextUsers = [...users.value];
          nextUsers.splice(existingIndex, 1, {
            ...nextUsers[existingIndex],
            ...updatedUser
          });
          users.value = nextUsers;
        } else {
          users.value = [...users.value, updatedUser];
        }

        if (currentUser.value?.id === updatedUser.id) {
          currentUser.value = {
            ...currentUser.value,
            ...updatedUser
          };
          pendingPresenceStatus.value = normalizePresenceStatus(updatedUser.status);
          currentUserRole.value = currentUser.value.role;
        }
        break;
      }

      case 'status_profile_updated': {
        const updatedUser = normalizeUser(payload.user);
        const existingIndex = users.value.findIndex((user) => user.id === updatedUser.id);
        if (existingIndex >= 0) {
          const nextUsers = [...users.value];
          nextUsers.splice(existingIndex, 1, {
            ...nextUsers[existingIndex],
            ...updatedUser
          });
          users.value = nextUsers;
        } else {
          users.value = [...users.value, updatedUser];
        }

        if (currentUser.value?.id === updatedUser.id) {
          currentUser.value = {
            ...currentUser.value,
            ...updatedUser
          };
          saveLocalStatusEmoji(updatedUser.status_emoji || null);
          saveLocalStatusText(updatedUser.status_text || null);
          currentUserRole.value = currentUser.value.role;
        }
        break;
      }

      case 'member_removed': {
        const removedUserId = (payload.userId || payload.targetUserId) as string | undefined;
        if (!removedUserId) break;
        users.value = users.value.filter((u) => u.id !== removedUserId);
        onlineUserIds.value.delete(removedUserId);
        if (memberIps.value[removedUserId]) {
          const nextIps = { ...memberIps.value };
          delete nextIps[removedUserId];
          memberIps.value = nextIps;
        }
        break;
      }

      case 'moderation_action_enforced': {
        const incomingAction = payload.actionType || payload.action;
        const action = incomingAction === 'ban' ? 'ban' : 'kick';
        const reasonText = payload.reason ? ` Reason: ${payload.reason}` : '';
        moderationNotice.value = {
          action,
          title: action === 'ban' ? 'You were banned' : 'You were kicked',
          message:
            action === 'ban'
              ? `A moderator banned you from this server.${reasonText}`
              : `A moderator kicked you from this server.${reasonText}`
        };
        removeCurrentServerAndFallback();
        break;
      }

      case 'auth:banned': {
        const reasonText = payload?.reason ? ` Reason: ${payload.reason}` : '';
        moderationNotice.value = {
          action: 'ban',
          title: 'Access denied (banned)',
          message: `You are banned from this server.${reasonText}`
        };
        removeCurrentServerAndFallback();
        break;
      }
        
      case 'user_online':
        onlineUserIds.value.add(payload.user.id);
        if (!users.value.find(u => u.id === payload.user.id)) {
          users.value.push(normalizeUser(payload.user));
        } else {
          const nextUser = normalizeUser(payload.user);
          users.value = users.value.map((user) => user.id === nextUser.id ? { ...user, ...nextUser } : user);
        }
        if (currentUser.value?.id === payload.user.id) {
          const nextUser = normalizeUser(payload.user);
          currentUser.value = nextUser;
          pendingPresenceStatus.value = normalizePresenceStatus(nextUser.status);
        }
        break;

      case 'user_offline':
        onlineUserIds.value.delete(payload.userId);
        if (currentUser.value?.id === payload.userId) {
          currentUser.value!.status = 'invisible';
        }
        break;

      case 'user_updated':
        const updatedUser = normalizeUser(payload.user);
        const index = users.value.findIndex(u => u.id === updatedUser.id);
        if (index !== -1) {
          users.value[index] = updatedUser;
        } else {
          users.value.push(updatedUser);
        }
        if (currentUser.value?.id === updatedUser.id) {
          currentUser.value = updatedUser;
          pendingPresenceStatus.value = normalizePresenceStatus(currentUser.value.status);
          currentUserRole.value = currentUser.value.role;
        }
        break;
        
      case 'channels_list':
        categories.value = payload.categories;
        channels.value = Array.isArray(payload.channels) ? [...payload.channels].sort(compareChannels) : [];
        uncategorizedCategoryDeleted.value = payload.uncategorized_category_deleted === true;
        applyUnreadStatesFromServer(payload.unreadStates as ChannelUnreadState[] | undefined);
        pruneUnreadChannels(payload.channels || []);
        
        if (!activeChannelId.value) {
          const restoredChannel = getValidSavedActiveTextChannel(payload.channels || []);
          if (restoredChannel) {
            activateChannel(restoredChannel);
          } else {
            setFallbackActiveTextChannel(payload.channels || []);
          }
        } else {
          const activeChannel = (payload.channels || []).find((c: Channel) => c.id === activeChannelId.value);
          if (activeChannel && (activeChannel.type === 'text' || activeChannel.type === 'rss')) {
            // Re-fetch messages for active channel in case we missed any while disconnected
            persistActiveChannelId(activeChannel.id);
            getMessages(activeChannelId.value);
          } else {
            setFallbackActiveTextChannel(payload.channels || []);
          }
        }
        break;
        
      case 'channel_created':
        channels.value.push(payload.channel);
        if (payload.channel?.category_id == null) {
          uncategorizedCategoryDeleted.value = false;
        }
        channels.value.sort((a, b) => {
          const aCategory = a.category_id || '';
          const bCategory = b.category_id || '';
          if (aCategory !== bCategory) {
            return aCategory.localeCompare(bCategory);
          }
          if (a.position !== b.position) {
            return a.position - b.position;
          }
          return a.name.localeCompare(b.name);
        });
        break;

      case 'category_created':
        categories.value.push(payload.category);
        categories.value.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
        break;

      case 'channels_reordered':
        channels.value = Array.isArray(payload.channels) ? [...payload.channels].sort(compareChannels) : [];
        pruneUnreadChannels(channels.value);
        break;

      case 'categories_reordered':
        categories.value = Array.isArray(payload.categories)
          ? [...payload.categories].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
          : [];
        break;

      case 'category_deleted': {
        const nextCategories = Array.isArray(payload.categories) ? payload.categories : null;
        const deletedCategoryId = payload.category_id as string | undefined;

        if (nextCategories) {
          categories.value = [...nextCategories].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
        } else if (deletedCategoryId) {
          categories.value = categories.value.filter((category) => category.id !== deletedCategoryId);
        }

        break;
      }

      case 'uncategorized_category_deleted':
        uncategorizedCategoryDeleted.value = true;
        break;

      case 'channel_deleted': {
        const deletedChannelId = payload.channel_id as string;
        if (!deletedChannelId) break;

        const deletedChannel = channels.value.find((c: Channel) => c.id === deletedChannelId);
        channels.value = channels.value.filter((c: Channel) => c.id !== deletedChannelId);
        delete messages.value[deletedChannelId];
        delete folderFiles.value[deletedChannelId];
        delete messagePageState.value[deletedChannelId];
        clearChannelUnread(deletedChannelId);

        if ((deletedChannel?.type === 'text' || deletedChannel?.type === 'rss') && activeChannelId.value === deletedChannelId) {
          setFallbackActiveTextChannel(channels.value);
        } else if (deletedChannel?.type === 'folder' && activeMainPanel.value.type === 'folder' && activeMainPanel.value.channelId === deletedChannelId) {
          setFallbackActiveTextChannel(channels.value);
        } else if (deletedChannel?.type === 'voice' && activeMainPanel.value.type === 'voice' && activeMainPanel.value.channelId === deletedChannelId) {
          setFallbackActiveTextChannel(channels.value);
        }
        break;
      }

      case 'folder_files_list': {
        const channelId = payload.channel_id as string;
        if (!channelId) break;
        folderFiles.value[channelId] = Array.isArray(payload.files) ? payload.files : [];
        break;
      }

      case 'folder_file_uploaded': {
        const channelId = payload.channel_id as string;
        const file = payload.file as FolderChannelFile | undefined;
        if (!channelId || !file?.id) break;
        const existing = folderFiles.value[channelId] || [];
        if (existing.some((f) => f.id === file.id)) {
          break;
        }
        folderFiles.value[channelId] = [file, ...existing];
        break;
      }

      case 'folder_file_deleted': {
        const channelId = payload.channel_id as string;
        const fileId = payload.file_id as string;
        if (!channelId || !fileId) break;

        const existing = folderFiles.value[channelId] || [];
        folderFiles.value[channelId] = existing.filter((file) => file.id !== fileId);
        break;
      }

      case 'folder_file_download': {
        const file = payload.file as { original_name?: string; mime_type?: string | null } | undefined;
        const dataBase64 = payload.data_base64 as string | undefined;
        if (!file?.original_name || !dataBase64) break;

        const binary = atob(dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }

        const blob = new Blob([bytes], { type: file.mime_type || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.original_name;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
        break;
      }
        
      case 'messages_list': {
        const channelId = payload.channel_id as string;
        const pageState = ensureMessagePageState(channelId);
        const incomingMessages = normalizeIncomingMessages((payload.messages || []) as Message[]);
        const isOlderPage = payload.is_older_page === true;

        if (isOlderPage) {
          const existingMessages = messages.value[channelId] || [];
          const seen = new Set<string>();
          const merged: Message[] = [];

          for (const message of [...incomingMessages, ...existingMessages]) {
            if (!message?.id || seen.has(message.id)) {
              continue;
            }
            seen.add(message.id);
            merged.push(message);
          }

          messages.value[channelId] = merged;
        } else {
          messages.value[channelId] = incomingMessages;
        }

        pageState.hasMore = payload.has_more === true;
        pageState.oldestMessageCreatedAt = typeof payload.before_created_at === 'string' ? payload.before_created_at : null;
        pageState.oldestMessageId = typeof payload.before_id === 'string' ? payload.before_id : null;
        pageState.initialized = true;
        pageState.isLoading = false;
        markActiveChannelReadFromMessages(channelId);
        break;
      }
        
      case 'new_message':
        const msg = normalizeIncomingMessage(payload.message as Message);
        const pageState = ensureMessagePageState(msg.channel_id);
        const alreadyPresent = Boolean(messages.value[msg.channel_id]?.some((existing) => existing.id === msg.id));
        if (!messages.value[msg.channel_id]) {
          messages.value[msg.channel_id] = [];
        }
        if (!alreadyPresent) {
          messages.value[msg.channel_id]?.push(msg);
          if (msg.user_id !== currentUser.value?.id) {
            playNewMessageNotificationSound();
          }
        }
        if (!pageState.initialized) {
          pageState.initialized = true;
        }
        if (activeMainPanel.value.type === 'text' && activeMainPanel.value.channelId === msg.channel_id) {
          markChannelReadOnServer(msg.channel_id, msg);
          clearChannelUnread(msg.channel_id);
        } else {
          markChannelUnread(msg.channel_id);
        }
        break;

      case 'message_deleted': {
        const channelId = payload.channel_id as string;
        const messageId = payload.message_id as string;
        removeMessageFromChannel(channelId, messageId);
        break;
      }

      case 'message_reactions_updated': {
        const channelId = payload.channel_id as string;
        const messageId = payload.message_id as string;
        const reactions = normalizeMessageReactions(payload.reactions);
        updateMessageInChannel(channelId, messageId, (existingMessage) => ({
          ...existingMessage,
          reactions
        }));
        break;
      }
        
      case 'error':
        lastError.value = payload.message;
        console.error('Server error:', payload.message);
        break;
        
      case 'role_updated':
        currentUserRole.value = typeof payload.role === 'string' ? payload.role : currentUser.value?.role || 'user';
        if (payload.user) {
          currentUser.value = normalizeUser(payload.user);
        }
        break;
    }
  };

  const send = (type: string, payload: any = {}) => {
    if (ws.value && isConnected.value) {
      ws.value.send(JSON.stringify({ type, payload }));
    } else {
      console.warn('Cannot send message, WebSocket not connected');
    }
  };

  const authenticate = async (username: string) => {
    try {
      const { publicKeyBase64 } = await getKeys();
      if (localAvatar.value === null) {
        await initializeStoredAvatar();
      }
      const authAvatarUrl = getAuthAvatarDataUrl();
      send('auth:request', {
        username,
        publicKey: publicKeyBase64,
        avatarUrl: authAvatarUrl,
        statusEmoji: localStatusEmoji.value,
        statusText: localStatusText.value
      });
    } catch (e) {
      console.error("Authentication request failed", e);
    }
  };

  const getChannels = () => {
    send('get_channels');
  };

  const setFallbackActiveTextChannel = (availableChannels: Channel[]) => {
    const firstTextChannel = availableChannels.find((c: Channel) => c.type === 'text' || c.type === 'rss');
    activateChannel(firstTextChannel || null);
  };

  const createChannel = (category_id: string | null, name: string, type: 'text' | 'voice' | 'rss' | 'folder', feed_url?: string) => {
    if (!name.trim()) {
      lastError.value = 'Channel name is required';
      return;
    }

    const normalizedFeedUrl = (feed_url || '').trim();
    if (type === 'rss' && !normalizedFeedUrl) {
      lastError.value = 'RSS feed URL is required';
      return;
    }

    send('create_channel', { category_id, name, type, feed_url: type === 'rss' ? normalizedFeedUrl : undefined });
  };

  const createCategory = (name: string) => {
    if (!name.trim()) {
      lastError.value = 'Category name is required';
      return;
    }

    send('create_category', { name });
  };

  const reorderCategories = (updatedCategories: Array<Pick<Category, 'id' | 'position'>>) => {
    if (!updatedCategories.length) {
      return;
    }

    send('reorder_categories', {
      categories: updatedCategories.map((category) => ({
        id: category.id,
        position: category.position
      }))
    });
  };

  const deleteCategory = (category_id: string) => {
    if (!category_id) {
      lastError.value = 'Category ID is required';
      return;
    }

    send('delete_category', { category_id });
  };

  const deleteUncategorizedCategory = () => {
    send('delete_uncategorized_category');
  };

  const deleteChannel = (channel_id: string) => {
    if (!channel_id) {
      lastError.value = 'Channel ID is required';
      return;
    }
    send('delete_channel', { channel_id });
  };

  const reorderChannels = (updatedChannels: Array<Pick<Channel, 'id' | 'category_id' | 'position'>>) => {
    if (!updatedChannels.length) {
      return;
    }

    send('reorder_channels', {
      channels: updatedChannels.map((channel) => ({
        id: channel.id,
        category_id: channel.category_id,
        position: channel.position
      }))
    });
  };

  const updateServerSettings = (
    serverId: string,
    title: string,
    rulesChannelId: string | null,
    welcomeChannelId: string | null,
    storage?: {
      storageType: 'data_dir' | 's3';
      s3?: {
        provider: 'generic_s3' | 'cloudflare_r2';
        providerUrl: string;
        endpoint: string;
        region: string;
        bucket: string;
        accessKey: string;
        secretKey: string;
        prefix: string;
      };
    },
    icon?: {
      iconDataUrl?: string | null;
      removeIcon?: boolean;
    }
  ) => {
    if (server.value && server.value.id === serverId) {
      applyServerState({
        ...server.value,
        title: (title || '').trim() || server.value.title,
        rulesChannelId,
        welcomeChannelId
      });
    }

    send('update_server_settings', {
      serverId,
      title,
      rulesChannelId,
      welcomeChannelId,
      iconDataUrl: icon?.iconDataUrl,
      removeIcon: icon?.removeIcon === true,
      storage: storage
        ? {
          enabled: storage.storageType === 's3',
          provider: storage.s3?.provider,
          providerUrl: storage.s3?.providerUrl,
          endpoint: storage.s3?.endpoint,
          region: storage.s3?.region,
          bucket: storage.s3?.bucket,
          accessKey: storage.s3?.accessKey,
          secretKey: storage.s3?.secretKey,
          prefix: storage.s3?.prefix
        }
        : undefined
    });
  };

  const testServerStorageSettings = async (storage: {
    storageType: 'data_dir' | 's3';
    s3?: {
      provider: 'generic_s3' | 'cloudflare_r2';
      providerUrl: string;
      endpoint: string;
      region: string;
      bucket: string;
      accessKey: string;
      secretKey: string;
      prefix: string;
    };
  }): Promise<ServerStorageTestResult> => {
    if (pendingStorageTestTimeout) {
      window.clearTimeout(pendingStorageTestTimeout);
      pendingStorageTestTimeout = null;
    }

    return new Promise<ServerStorageTestResult>((resolve) => {
      pendingStorageTestResolve = resolve;
      pendingStorageTestTimeout = window.setTimeout(() => {
        if (pendingStorageTestResolve) {
          pendingStorageTestResolve({
            ok: false,
            message: 'Storage connection test timed out. Please try again.'
          });
          pendingStorageTestResolve = null;
        }
        pendingStorageTestTimeout = null;
      }, 15000);

      send('test_server_storage_s3', {
        storage: {
          enabled: storage.storageType === 's3',
          provider: storage.s3?.provider,
          providerUrl: storage.s3?.providerUrl,
          endpoint: storage.s3?.endpoint,
          region: storage.s3?.region,
          bucket: storage.s3?.bucket,
          accessKey: storage.s3?.accessKey,
          secretKey: storage.s3?.secretKey,
          prefix: storage.s3?.prefix
        }
      });
    });
  };

  const requestServerStorageSettings = () => {
    send('get_server_storage_settings');
  };

  const requestServerRoles = () => {
    const activeServerId = server.value?.id?.trim();
    if (!activeServerId) {
      return;
    }

    send('get_server_roles', {
      serverId: activeServerId
    });
  };

  const updateServerRole = (serverId: string, roleId: string, name: string, color: string | null) => {
    send('update_server_role', {
      serverId,
      roleId,
      name,
      color
    });
  };

  const assignMemberRoles = (serverId: string, userId: string, roleIds: string[]) => {
    send('assign_member_roles', {
      serverId,
      userId,
      roleIds
    });
  };

  const updateServerRoles = async (roles: ServerRoleFormInput[]) => {
    const normalizedRoles = roles.map((role) => ({
      id: role.id,
      name: role.name.trim(),
      color: (() => {
        const normalizedColor = (role.color || '').trim().toLowerCase();
        return /^#([0-9a-f]{6})$/.test(normalizedColor) ? normalizedColor : null;
      })()
    }));

    const existingRoles = normalizedRoles.map((role) => serverRoles.value.find((existingRole) => existingRole.id === role.id));
    const invalidRole = normalizedRoles.find((role) => !role.name);
    if (invalidRole) {
      throw new Error('Role name is required');
    }

    if (existingRoles.some((role) => !role)) {
      throw new Error('Role metadata is out of date. Reopen server settings and try again.');
    }

    const changedRoles = normalizedRoles.filter((role, index) => {
      const existingRole = existingRoles[index];
      if (!existingRole) {
        return false;
      }

      return role.name !== existingRole.name || role.color !== existingRole.color;
    });

    const activeServerId = server.value?.id?.trim();
    if (!activeServerId) {
      throw new Error('Server metadata is unavailable. Reopen server settings and try again.');
    }

    for (const role of changedRoles) {
      updateServerRole(activeServerId, role.id, role.name, role.color);
    }

    return changedRoles.length;
  };

  const clearError = () => {
    lastError.value = null;
  };

  const getMessages = (channel_id: string) => {
    const pageState = ensureMessagePageState(channel_id);
    pageState.isLoading = true;
    send('get_messages', { channel_id });
  };

  const loadOlderMessages = (channel_id: string) => {
    const pageState = ensureMessagePageState(channel_id);
    if (pageState.isLoading || !pageState.initialized || !pageState.hasMore) {
      return false;
    }

    if (!pageState.oldestMessageCreatedAt || !pageState.oldestMessageId) {
      pageState.hasMore = false;
      return false;
    }

    pageState.isLoading = true;
    send('get_messages', {
      channel_id,
      before_created_at: pageState.oldestMessageCreatedAt,
      before_id: pageState.oldestMessageId
    });
    return true;
  };

  const isLoadingMessagesForChannel = (channel_id: string) => {
    return ensureMessagePageState(channel_id).isLoading;
  };

  const hasOlderMessagesForChannel = (channel_id: string) => {
    const state = ensureMessagePageState(channel_id);
    return state.initialized && state.hasMore;
  };

  const submitAdminKey = (key: string) => {
    send('submit_admin_key', { key });
  };

  const sendMessage = (channel_id: string, content: string, reply_to_message_id?: string | null) => {
    send('send_message', { channel_id, content, reply_to_message_id: reply_to_message_id || null });
  };

  const deleteMessage = (channel_id: string, message_id: string) => {
    if (!channel_id || !message_id) {
      lastError.value = 'Channel ID and message ID are required';
      return;
    }

    send('delete_message', { channel_id, message_id });
  };

  const toggleMessageReaction = (channel_id: string, message_id: string, emoji: string) => {
    const normalizedEmoji = emoji.trim();
    if (!channel_id || !message_id || !normalizedEmoji) {
      lastError.value = 'Channel ID, message ID, and emoji are required';
      return;
    }

    send('toggle_message_reaction', { channel_id, message_id, emoji: normalizedEmoji });
  };

  const sendMessageWithAttachments = async (channel_id: string, content: string, files: File[], reply_to_message_id?: string | null) => {
    const initialProgress = files.map((file) => ({
      fileName: file.name,
      loadedBytes: 0,
      totalBytes: file.size
    }));
    setPendingMessageUploadProgress(initialProgress);

    try {
      if (files.length === 1) {
        const [file] = files;
        if (!file) {
          return;
        }
        await uploadFileOverWebSocket({
          kind: 'message_attachment',
          channelId: channel_id,
          file,
          content,
          replyToMessageId: reply_to_message_id || null,
          onProgress: (loadedBytes, totalBytes) => {
            const currentProgress = pendingMessageUploadProgress.value || initialProgress;
            const nextProgress = currentProgress.map((entry, entryIndex) => entryIndex === 0
              ? { fileName: file.name, loadedBytes, totalBytes }
              : entry);
            setPendingMessageUploadProgress(nextProgress);
          }
        });
      } else {
        const attachments = await Promise.all(files.map(async (file, index) => {
          const dataBase64 = await readFileAsDataBase64WithProgress(file, (loadedBytes, totalBytes) => {
            const currentProgress = pendingMessageUploadProgress.value || initialProgress;
            const nextProgress = currentProgress.map((entry, entryIndex) => entryIndex === index
              ? {
                  fileName: file.name,
                  loadedBytes,
                  totalBytes
                }
              : entry);
            setPendingMessageUploadProgress(nextProgress);
          });

          return {
            file_name: file.name,
            mime_type: file.type || 'application/octet-stream',
            data_base64: dataBase64
          };
        }));

        send('send_message', { channel_id, content, attachments, reply_to_message_id: reply_to_message_id || null });
      }
    } catch (error) {
      clearPendingMessageUploadProgress();
      throw error;
    }
  };

  const kickMember = (targetUserId: string, options: { reason?: string; deleteMode?: ModerationDeleteMode; deleteHours?: number }) => {
    const reason = (options.reason || '').trim();
    const deleteMode = options.deleteMode || 'none';
    const payload: {
      targetUserId: string;
      reason?: string;
      deleteMode?: ModerationDeleteMode;
      deleteHours?: number;
    } = {
      targetUserId,
      deleteMode
    };

    if (reason) {
      payload.reason = reason;
    }
    if (deleteMode === 'hours' && typeof options.deleteHours === 'number' && options.deleteHours > 0) {
      payload.deleteHours = options.deleteHours;
    }

    users.value = users.value.filter((u) => u.id !== targetUserId);
    onlineUserIds.value.delete(targetUserId);
    console.debug('[WS DEBUG] Sending kick_member', {
      targetUserId: payload.targetUserId,
      deleteMode: payload.deleteMode,
      deleteHours: payload.deleteHours ?? null,
      hasReason: Boolean(payload.reason)
    });
    send('kick_member', payload);
  };

  const banMember = (
    targetUserId: string,
    options: {
      reason?: string;
      deleteMode?: ModerationDeleteMode;
      deleteHours?: number;
      blacklistIdentity?: boolean;
      blacklistIp?: boolean;
    }
  ) => {
    const reason = (options.reason || '').trim();
    const deleteMode = options.deleteMode || 'none';
    const payload: {
      targetUserId: string;
      reason?: string;
      deleteMode?: ModerationDeleteMode;
      deleteHours?: number;
      blacklistIdentity?: boolean;
      blacklistIp?: boolean;
    } = {
      targetUserId,
      deleteMode
    };

    if (reason) {
      payload.reason = reason;
    }
    if (deleteMode === 'hours' && typeof options.deleteHours === 'number' && options.deleteHours > 0) {
      payload.deleteHours = options.deleteHours;
    }
    if (options.blacklistIdentity) {
      payload.blacklistIdentity = true;
    }
    if (options.blacklistIp) {
      payload.blacklistIp = true;
    }

    users.value = users.value.filter((u) => u.id !== targetUserId);
    onlineUserIds.value.delete(targetUserId);
    console.debug('[WS DEBUG] Sending ban_member', {
      targetUserId: payload.targetUserId,
      deleteMode: payload.deleteMode,
      deleteHours: payload.deleteHours ?? null,
      blacklistIdentity: payload.blacklistIdentity === true,
      blacklistIp: payload.blacklistIp === true,
      hasReason: Boolean(payload.reason)
    });
    send('ban_member', payload);
  };

  const clearModerationNotice = () => {
    moderationNotice.value = null;
  };

  const setActiveChannel = (channel_id: string) => {
    const channel = channels.value.find((c) => c.id === channel_id);
    if (channel?.type === 'folder') {
      activeChannelId.value = channel_id;
      activeMainPanel.value = { type: 'folder', channelId: channel_id };
      requestFolderFiles(channel_id);
      return;
    }

    activateChannel(channel && (channel.type === 'text' || channel.type === 'rss') ? channel : null);
  };

  const requestFolderFiles = (channel_id: string) => {
    send('folder_list_files', { channel_id });
  };

  const uploadFolderFile = async (channel_id: string, file: File) => {
    const blockedExtension = getBlockedFolderUploadExtension(file.name);
    if (blockedExtension) {
      throw new Error(`Upload blocked: .${blockedExtension} files are not allowed in folder channels.`);
    }
    await uploadFileOverWebSocket({
      kind: 'folder_file',
      channelId: channel_id,
      file
    });
  };

  const downloadFolderFile = (channel_id: string, file_id: string) => {
    send('folder_download_file', { channel_id, file_id });
  };

  const deleteFolderFile = (channel_id: string, file_id: string) => {
    if (!channel_id || !file_id) {
      lastError.value = 'Channel ID and file ID are required';
      return;
    }

    send('folder_delete_file', { channel_id, file_id });
  };

  const setActiveVoicePanel = (channel_id: string) => {
    activeMainPanel.value = { type: 'voice', channelId: channel_id };
  };

  const activeServerChannels = computed(() => {
    return channels.value || [];
  });

  const activeServerCategories = computed(() => {
    return categories.value || [];
  });

  const activeChannelMessages = computed(() => {
    if (activeMainPanel.value.type !== 'text' || !activeChannelId.value) return [];
    return messages.value[activeChannelId.value] || [];
  });

  void initializeStoredAvatar();

  return {
    isConnected,
    currentUser,
    currentUserRole,
    server,
    serverRoles,
    uncategorizedCategoryDeleted,
    serverStorageSettings,
    lastError,
    savedConnections,
    activeConnectionId,
    hasStoredIdentity,
    localUsername,
    localStatusEmoji,
    localStatusText,
    users,
    onlineUserIds,
    pendingPresenceStatus,
    memberIps,
    moderationNotice,
    categories,
    channels,
    messages,
    folderFiles,
    unreadChannelIds,
    activeChannelId,
    activeMainPanel,
    activeServerChannels,
    activeServerCategories,
    activeChannelMessages,
    saveLocalUsername,
    saveLocalStatusEmoji,
    saveLocalStatusText,
    saveStatusPreference,
    saveLocalAvatar,
    getLocalAvatar,
    getStoredIdentityExport,
    importStoredIdentity,
    addSavedConnection,
    addServerConnection,
    removeSavedConnection,
    connect,
    disconnect,
    authenticate,
    createCategory,
    reorderCategories,
    createChannel,
    deleteCategory,
    deleteUncategorizedCategory,
    deleteChannel,
    reorderChannels,
    updateServerSettings,
    requestServerRoles,
    updateServerRole,
    updateServerRoles,
    assignMemberRoles,
    isUserEffectivelyOnline,
    getUserPresenceStatus,
    setPresenceStatus,
    getServerRoleByKey,
    getServerRoleColor,
    getPrimaryServerRole,
    getUserRoleKeys,
    userHasRole,
    testServerStorageSettings,
    requestServerStorageSettings,
    requestServerRefresh,
    clearError,
    sendMessage,
    deleteMessage,
    toggleMessageReaction,
    sendMessageWithAttachments,
    pendingMessageUploadProgress,
    clearPendingMessageUploadProgress,
    loadOlderMessages,
    isLoadingMessagesForChannel,
    hasOlderMessagesForChannel,
    kickMember,
    banMember,
    clearModerationNotice,
    submitAdminKey,
    setActiveChannel,
    setActiveVoicePanel,
    requestFolderFiles,
    uploadFolderFile,
    downloadFolderFile,
    deleteFolderFile,
    resolveServerIconUrl,
    send,
    ws,
    addMessageListener,
    removeMessageListener
  };
});
