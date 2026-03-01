import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useWebRtcStore } from './webrtc';

const NEW_NOTIFICATION_SOUND_DEBOUNCE_MS = 1000;

export interface User {
  id: string;
  username: string;
  avatar_url: string | null;
  role: string;
  created_at: string;
}

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

export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: string;
  user?: User;
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
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
}

export interface ServerStorageTestResult {
  ok: boolean;
  message: string;
}

export interface ServerStorageSettings {
  storageType: 'data_dir' | 's3';
  storageLastError: string | null;
  s3: ServerStorageS3Settings;
}

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
  const currentUserRole = ref<string>('user');
  const server = ref<Server | null>(null);
  const serverStorageSettings = ref<ServerStorageSettings>({
    storageType: 'data_dir',
    storageLastError: null,
    s3: {
      endpoint: '',
      region: '',
      bucket: '',
      accessKey: '',
      secretKey: '',
      prefix: ''
    }
  });
  const lastError = ref<string | null>(null);
  
  const savedConnections = ref<SavedConnection[]>(
    JSON.parse(localStorage.getItem('savedConnections') || '[]').map((c: SavedConnection) => ({
      ...c,
      address: c.address.replace(/(ws:\/\/|wss:\/\/)?0\.0\.0\.0/, (_match, p1) => `${p1 || ''}localhost`)
    }))
  );
  const activeConnectionId = ref<string | null>(null);
  const localUsername = ref<string | null>(localStorage.getItem('username'));
  const users = ref<User[]>([]);
  const onlineUserIds = ref<Set<string>>(new Set());
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
  
  let pingInterval: number | null = null;
  let pongTimeout: number | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let isIntentionalDisconnect = false;
  let pendingStorageTestResolve: ((result: ServerStorageTestResult) => void) | null = null;
  let pendingStorageTestTimeout: number | null = null;
  const lastMarkedReadMessageByChannel = ref<Record<string, string>>({});

  const saveLocalUsername = (username: string) => {
    localUsername.value = username;
    localStorage.setItem('username', username);
  };

  const normalizeServerAddress = (address: string) => {
    let wsUrl = address.trim();
    if (!wsUrl) return wsUrl;

    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      wsUrl = `${protocol}${wsUrl}`;
    } else if (wsUrl.startsWith('ws://') && window.location.protocol === 'https:') {
      wsUrl = wsUrl.replace(/^ws:\/\//i, 'wss://');
    }

    return wsUrl.replace(/(ws:\/\/|wss:\/\/)?0\.0\.0\.0/, (_match, p1) => `${p1 || ''}localhost`);
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

      const baseUrl = wsAddress
        ? getHttpBaseFromWsAddress(wsAddress)
        : (activeConnectionId.value
          ? getHttpBaseFromWsAddress(savedConnections.value.find((connection) => connection.id === activeConnectionId.value)?.address || '')
          : window.location.origin);

      return appendServerIconVersion(`${baseUrl}/server-icons/s3/${encodeURIComponent(key)}`, version);
    }

    if (/^(data:|blob:|https?:\/\/|\/\/)/i.test(path)) {
      return path;
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (wsAddress) {
      return appendServerIconVersion(`${getHttpBaseFromWsAddress(wsAddress)}${normalizedPath}`, version);
    }

    const activeConnection = activeConnectionId.value
      ? savedConnections.value.find((connection) => connection.id === activeConnectionId.value)
      : null;

    const baseUrl = activeConnection
      ? getHttpBaseFromWsAddress(activeConnection.address)
      : window.location.origin;

    return appendServerIconVersion(`${baseUrl}${normalizedPath}`, version);
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
      address
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
      const port = '1337'; // Assuming server is on 1337
      // Use wss:// if the page is loaded over https, otherwise ws://
      const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      wsUrl = `${protocol}${host}:${port}`;
    } else if (wsUrl.startsWith('ws://') && window.location.protocol === 'https:') {
      wsUrl = wsUrl.replace(/^ws:\/\//i, 'wss://');
    }

    // Replace 0.0.0.0 with localhost in the final URL to prevent browser connection errors
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
    activeChannelId.value = null;
    activeMainPanel.value = { type: 'text', channelId: null };
    messages.value = {};
    folderFiles.value = {};
    messagePageState.value = {};
    unreadChannelIds.value = new Set();
    lastMarkedReadMessageByChannel.value = {};
    users.value = [];
    onlineUserIds.value.clear();
    currentUser.value = null;
    server.value = null;
    serverStorageSettings.value = {
      storageType: 'data_dir',
      storageLastError: null,
      s3: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKey: '',
        secretKey: '',
        prefix: ''
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
        let hasChanges = false;

        if (nextTitle && currentConnection.name !== nextTitle) {
          currentConnection.name = nextTitle;
          hasChanges = true;
        }

        if ((currentConnection.iconUrl || null) !== resolvedIconUrl) {
          currentConnection.iconUrl = resolvedIconUrl;
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
        currentUser.value = payload.user;
        currentUserRole.value = payload.user.role || 'user';
        if (payload.server) {
          applyServerState(payload.server);
        }
        if ((payload.user.role || 'user') === 'admin') {
          requestServerStorageSettings();
        }
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
        serverStorageSettings.value = {
          storageType: payload.storageType === 's3' ? 's3' : 'data_dir',
          storageLastError: typeof payload.storageLastError === 'string' ? payload.storageLastError : null,
          s3: {
            endpoint: payload?.s3?.endpoint || '',
            region: payload?.s3?.region || '',
            bucket: payload?.s3?.bucket || '',
            accessKey: payload?.s3?.accessKey || '',
            secretKey: payload?.s3?.secretKey || '',
            prefix: payload?.s3?.prefix || ''
          }
        };
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
        
      case 'member_list':
        users.value = payload.members;
        onlineUserIds.value = new Set(payload.onlineUserIds);
        memberIps.value = payload.memberIps || {};
        break;

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
          users.value.push(payload.user);
        }
        break;
        
      case 'user_offline':
        onlineUserIds.value.delete(payload.userId);
        break;
        
      case 'user_updated':
        const index = users.value.findIndex(u => u.id === payload.user.id);
        if (index !== -1) {
          users.value[index] = payload.user;
        } else {
          users.value.push(payload.user);
        }
        if (currentUser.value?.id === payload.user.id) {
          currentUser.value = payload.user;
          currentUserRole.value = payload.user.role;
        }
        break;
        
      case 'channels_list':
        categories.value = payload.categories;
        channels.value = payload.channels;
        applyUnreadStatesFromServer(payload.unreadStates as ChannelUnreadState[] | undefined);
        pruneUnreadChannels(payload.channels || []);
        
        if (!activeChannelId.value) {
          setFallbackActiveTextChannel(payload.channels || []);
        } else {
          const activeChannel = (payload.channels || []).find((c: Channel) => c.id === activeChannelId.value);
          if (activeChannel && (activeChannel.type === 'text' || activeChannel.type === 'rss')) {
            // Re-fetch messages for active channel in case we missed any while disconnected
            getMessages(activeChannelId.value);
          } else {
            setFallbackActiveTextChannel(payload.channels || []);
          }
        }
        break;
        
      case 'channel_created':
        channels.value.push(payload.channel);
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
        const incomingMessages = (payload.messages || []) as Message[];
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
        const msg = payload.message;
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
        
      case 'error':
        lastError.value = payload.message;
        console.error('Server error:', payload.message);
        break;
        
      case 'role_updated':
        currentUserRole.value = payload.role;
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
      send('auth:request', { username, publicKey: publicKeyBase64 });
    } catch (e) {
      console.error("Authentication request failed", e);
    }
  };

  const getChannels = () => {
    send('get_channels');
  };

  const setFallbackActiveTextChannel = (availableChannels: Channel[]) => {
    const firstTextChannel = availableChannels.find((c: Channel) => c.type === 'text' || c.type === 'rss');
    if (firstTextChannel) {
      activeChannelId.value = firstTextChannel.id;
      activeMainPanel.value = { type: 'text', channelId: firstTextChannel.id };
      clearChannelUnread(firstTextChannel.id);
      getMessages(firstTextChannel.id);
    } else {
      activeChannelId.value = null;
      activeMainPanel.value = { type: 'text', channelId: null };
    }
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

  const deleteChannel = (channel_id: string) => {
    if (!channel_id) {
      lastError.value = 'Channel ID is required';
      return;
    }
    send('delete_channel', { channel_id });
  };

  const updateServerSettings = (
    serverId: string,
    title: string,
    rulesChannelId: string | null,
    welcomeChannelId: string | null,
    storage?: {
      enabled: boolean;
      endpoint: string;
      region: string;
      bucket: string;
      accessKey: string;
      secretKey: string;
      prefix: string;
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

    send('UPDATE_SERVER_SETTINGS', {
      serverId,
      title,
      rulesChannelId,
      welcomeChannelId,
      iconDataUrl: icon?.iconDataUrl,
      removeIcon: icon?.removeIcon === true,
      storage: storage
        ? {
          enabled: storage.enabled,
          endpoint: storage.endpoint,
          region: storage.region,
          bucket: storage.bucket,
          accessKey: storage.accessKey,
          secretKey: storage.secretKey,
          prefix: storage.prefix
        }
        : undefined
    });
  };

  const testServerStorageSettings = async (storage: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    prefix: string;
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
            message: 'S3 connection test timed out. Please try again.'
          });
          pendingStorageTestResolve = null;
        }
        pendingStorageTestTimeout = null;
      }, 15000);

      send('test_server_storage_s3', {
        storage: {
          endpoint: storage.endpoint,
          accessKey: storage.accessKey,
          secretKey: storage.secretKey,
          prefix: storage.prefix
        }
      });
    });
  };

  const requestServerStorageSettings = () => {
    send('get_server_storage_settings');
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

  const sendMessage = (channel_id: string, content: string) => {
    send('send_message', { channel_id, content });
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
    activeChannelId.value = channel_id;
    const channel = channels.value.find((c) => c.id === channel_id);
    if (channel?.type === 'folder') {
      activeMainPanel.value = { type: 'folder', channelId: channel_id };
      requestFolderFiles(channel_id);
      return;
    }

    activeMainPanel.value = { type: 'text', channelId: channel_id };
    clearChannelUnread(channel_id);
    getMessages(channel_id);
  };

  const requestFolderFiles = (channel_id: string) => {
    send('folder_list_files', { channel_id });
  };

  const uploadFolderFile = async (channel_id: string, file: File) => {
    const blockedExtension = getBlockedFolderUploadExtension(file.name);
    if (blockedExtension) {
      throw new Error(`Upload blocked: .${blockedExtension} files are not allowed in folder channels.`);
    }

    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          console.error('[FOLDER_UPLOAD] FileReader result was not a string', { channel_id, fileName: file.name });
          reject(new Error('Failed to read file'));
          return;
        }

        const commaIndex = result.indexOf(',');
        if (commaIndex === -1) {
          console.error('[FOLDER_UPLOAD] Unexpected FileReader result format', { channel_id, fileName: file.name });
          reject(new Error('Failed to read file'));
          return;
        }

        const base64 = result.slice(commaIndex + 1);
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });

    send('folder_upload_file', {
      channel_id,
      file_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      data_base64: dataBase64
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

  return {
    isConnected,
    currentUser,
    currentUserRole,
    server,
    serverStorageSettings,
    lastError,
    savedConnections,
    activeConnectionId,
    localUsername,
    users,
    onlineUserIds,
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
    addSavedConnection,
    addServerConnection,
    removeSavedConnection,
    connect,
    disconnect,
    authenticate,
    createChannel,
    deleteChannel,
    updateServerSettings,
    testServerStorageSettings,
    requestServerStorageSettings,
    requestServerRefresh,
    clearError,
    sendMessage,
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
