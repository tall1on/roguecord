import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

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
  type: 'text' | 'voice';
  position: number;
}

export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: string;
  user?: User;
}

export interface SavedConnection {
  id: string;
  name: string;
  address: string;
  iconUrl?: string;
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

export const useChatStore = defineStore('chat', () => {
  const ws = ref<WebSocket | null>(null);
  const isConnected = ref(false);
  const currentUser = ref<User | null>(null);
  const currentUserRole = ref<string>('user');
  
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
  
  const categories = ref<Category[]>([]);
  const channels = ref<Channel[]>([]);
  const messages = ref<Record<string, Message[]>>({}); // channel_id -> Message[]
  
  const activeChannelId = ref<string | null>(null);
  
  let pingInterval: number | null = null;
  let pongTimeout: number | null = null;

  const saveLocalUsername = (username: string) => {
    localUsername.value = username;
    localStorage.setItem('username', username);
  };

  const addSavedConnection = (name: string, address: string) => {
    // Replace 0.0.0.0 with localhost to prevent browser connection errors
    address = address.replace(/(ws:\/\/|wss:\/\/)?0\.0\.0\.0/, (_match, p1) => `${p1 || ''}localhost`);
    const newConnection: SavedConnection = {
      id: crypto.randomUUID(),
      name,
      address
    };
    savedConnections.value.push(newConnection);
    localStorage.setItem('savedConnections', JSON.stringify(savedConnections.value));
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

  const connect = (address?: string) => {
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
    wsUrl = wsUrl.replace(/(ws:\/\/|wss:\/\/)?0\.0\.0\.0/, (_match, p1) => `${p1 || ''}localhost`);

    console.log(`[DEBUG] Final wsUrl: ${wsUrl}`);

    if (ws.value) {
      if (ws.value.url === wsUrl) return;
      disconnect();
    }
    
    const connection = savedConnections.value.find(c => c.address === wsUrl);
    activeConnectionId.value = connection ? connection.id : null;
    
    localStorage.setItem('lastUsedServer', wsUrl);
    
    ws.value = new WebSocket(wsUrl);
    
    ws.value.onopen = () => {
      isConnected.value = true;
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
            console.warn('WebSocket pong timeout, disconnecting...');
            disconnect();
            // Optionally trigger a reconnect here if desired, but the prompt says "trigger a reconnect if necessary"
            // and the existing code says "Removed endless reconnect loop as requested: 'make it so it only tries once'"
            // So we'll just disconnect and let the user reconnect manually or handle it via existing logic.
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
      // Removed endless reconnect loop as requested: "make it so it only tries once"
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
    messages.value = {};
    users.value = [];
    onlineUserIds.value.clear();
    currentUser.value = null;
  };

  const messageListeners = ref<((message: any) => void)[]>([]);

  const addMessageListener = (listener: (message: any) => void) => {
    messageListeners.value.push(listener);
  };

  const removeMessageListener = (listener: (message: any) => void) => {
    messageListeners.value = messageListeners.value.filter(l => l !== listener);
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
        saveLocalUsername(payload.user.username);
        getChannels();
        break;
        
      case 'member_list':
        users.value = payload.members;
        onlineUserIds.value = new Set(payload.onlineUserIds);
        break;
        
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
        
        // Auto-select first text channel if none selected
        if (!activeChannelId.value) {
          const firstTextChannel = payload.channels?.find((c: Channel) => c.type === 'text');
          if (firstTextChannel) {
            setActiveChannel(firstTextChannel.id);
          }
        }
        break;
        
      case 'channel_created':
        channels.value.push(payload.channel);
        break;
        
      case 'messages_list':
        messages.value[payload.channel_id] = payload.messages;
        break;
        
      case 'new_message':
        const msg = payload.message;
        if (!messages.value[msg.channel_id]) {
          messages.value[msg.channel_id] = [];
        }
        messages.value[msg.channel_id]?.push(msg);
        break;
        
      case 'error':
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

  const createChannel = (category_id: string | null, name: string, type: 'text' | 'voice') => {
    send('create_channel', { category_id, name, type });
  };

  const getMessages = (channel_id: string) => {
    send('get_messages', { channel_id });
  };

  const submitAdminKey = (key: string) => {
    send('submit_admin_key', { key });
  };

  const sendMessage = (channel_id: string, content: string) => {
    send('send_message', { channel_id, content });
  };

  const setActiveChannel = (channel_id: string) => {
    activeChannelId.value = channel_id;
    getMessages(channel_id);
  };

  const activeServerChannels = computed(() => {
    return channels.value || [];
  });

  const activeServerCategories = computed(() => {
    return categories.value || [];
  });

  const activeChannelMessages = computed(() => {
    if (!activeChannelId.value) return [];
    return messages.value[activeChannelId.value] || [];
  });

  return {
    isConnected,
    currentUser,
    currentUserRole,
    savedConnections,
    activeConnectionId,
    localUsername,
    users,
    onlineUserIds,
    categories,
    channels,
    messages,
    activeChannelId,
    activeServerChannels,
    activeServerCategories,
    activeChannelMessages,
    saveLocalUsername,
    addSavedConnection,
    removeSavedConnection,
    connect,
    disconnect,
    authenticate,
    createChannel,
    sendMessage,
    submitAdminKey,
    setActiveChannel,
    send,
    ws,
    addMessageListener,
    removeMessageListener
  };
});
