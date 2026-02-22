import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export interface User {
  id: string;
  username: string;
  avatar_url: string | null;
  created_at: string;
}

export interface Server {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  created_at: string;
}

export interface Category {
  id: string;
  server_id: string;
  name: string;
  position: number;
}

export interface Channel {
  id: string;
  server_id: string;
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
  return arrayBufferToBase64(exported);
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
  return arrayBufferToBase64(signature);
};

export const useChatStore = defineStore('chat', () => {
  const ws = ref<WebSocket | null>(null);
  const isConnected = ref(false);
  const currentUser = ref<User | null>(null);
  const currentUserRole = ref<string>('user');
  
  const savedConnections = ref<SavedConnection[]>(JSON.parse(localStorage.getItem('savedConnections') || '[]'));
  const activeConnectionId = ref<string | null>(null);
  const localUsername = ref<string | null>(localStorage.getItem('username'));
  const users = ref<User[]>([]);
  
  const servers = ref<Server[]>([]);
  const categories = ref<Record<string, Category[]>>({}); // server_id -> Category[]
  const channels = ref<Record<string, Channel[]>>({}); // server_id -> Channel[]
  const messages = ref<Record<string, Message[]>>({}); // channel_id -> Message[]
  
  const activeServerId = ref<string | null>(null);
  const activeChannelId = ref<string | null>(null);

  const saveLocalUsername = (username: string) => {
    localUsername.value = username;
    localStorage.setItem('username', username);
  };

  const addSavedConnection = (name: string, address: string) => {
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
  };

  const getKeys = async () => {
    const storedPriv = localStorage.getItem('privateKey');
    const storedPub = localStorage.getItem('publicKey');
    
    if (storedPriv && storedPub) {
      try {
        const privateKey = await importPrivateKey(storedPriv);
        return { privateKey, publicKeyBase64: storedPub };
      } catch (e) {
        console.error("Failed to import stored key, generating new one", e);
      }
    }
    
    const keyPair = await generateKeyPair();
    const privateJwk = await exportPrivateKey(keyPair.privateKey);
    const publicBase64 = await exportPublicKey(keyPair.publicKey);
    
    localStorage.setItem('privateKey', privateJwk);
    localStorage.setItem('publicKey', publicBase64);
    
    return { privateKey: keyPair.privateKey, publicKeyBase64: publicBase64 };
  };

  const connect = (address?: string) => {
    if (ws.value) return;
    
    let wsUrl = address;
    if (!wsUrl) {
      // Use wss:// and the current hostname, fallback to localhost:1337
      const host = window.location.hostname || 'localhost';
      const port = '1337'; // Assuming server is on 1337
      // Use wss:// if the page is loaded over https, otherwise ws://
      const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      wsUrl = `${protocol}${host}:${port}`;
    } else if (wsUrl.startsWith('ws://') && window.location.protocol === 'https:') {
      wsUrl = wsUrl.replace(/^ws:\/\//i, 'wss://');
    }
    
    const connection = savedConnections.value.find(c => c.address === wsUrl);
    activeConnectionId.value = connection ? connection.id : null;
    
    ws.value = new WebSocket(wsUrl);
    
    ws.value.onopen = () => {
      isConnected.value = true;
      console.log('WebSocket connected');
      
      if (localUsername.value) {
        authenticate(localUsername.value);
      }
    };
    
    ws.value.onclose = () => {
      isConnected.value = false;
      ws.value = null;
      console.log('WebSocket disconnected, reconnecting in 3s...');
      setTimeout(() => connect(address), 3000);
    };
    
    ws.value.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    ws.value.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };
  };

  const disconnect = () => {
    if (ws.value) {
      ws.value.close();
      ws.value = null;
    }
    isConnected.value = false;
    activeConnectionId.value = null;
    servers.value = [];
    activeServerId.value = null;
    channels.value = {};
    activeChannelId.value = null;
    messages.value = {};
    users.value = [];
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
        getServers();
        break;
        
      case 'servers_list':
        servers.value = payload.servers || [];
        if (servers.value.length > 0) {
          setActiveServer(servers.value[0]!.id);
        } else {
          createServer('Default Server');
        }
        break;
        
      case 'server_created':
        servers.value.push(payload.server);
        setActiveServer(payload.server.id);
        break;
        
      case 'channels_list':
        categories.value[payload.server_id] = payload.categories;
        channels.value[payload.server_id] = payload.channels;
        
        // Auto-select first text channel if none selected
        if (activeServerId.value === payload.server_id && !activeChannelId.value) {
          const firstTextChannel = payload.channels?.find((c: Channel) => c.type === 'text');
          if (firstTextChannel) {
            setActiveChannel(firstTextChannel.id);
          }
        }
        break;
        
      case 'channel_created':
        if (!channels.value[payload.server_id]) {
          channels.value[payload.server_id] = [];
        }
        channels.value[payload.server_id]?.push(payload.channel);
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

  const getServers = () => {
    send('get_servers');
  };

  const createServer = (name: string) => {
    send('create_server', { name });
  };

  const getChannels = (server_id: string) => {
    send('get_channels', { server_id });
  };

  const createChannel = (server_id: string, category_id: string | null, name: string, type: 'text' | 'voice') => {
    send('create_channel', { server_id, category_id, name, type });
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

  const setActiveServer = (server_id: string) => {
    activeServerId.value = server_id;
    activeChannelId.value = null; // Reset channel when switching servers
    getChannels(server_id);
  };

  const setActiveChannel = (channel_id: string) => {
    activeChannelId.value = channel_id;
    getMessages(channel_id);
  };

  const activeServerChannels = computed(() => {
    if (!activeServerId.value) return [];
    return channels.value[activeServerId.value] || [];
  });

  const activeServerCategories = computed(() => {
    if (!activeServerId.value) return [];
    return categories.value[activeServerId.value] || [];
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
    servers,
    categories,
    channels,
    messages,
    activeServerId,
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
    createServer,
    createChannel,
    sendMessage,
    submitAdminKey,
    setActiveServer,
    setActiveChannel,
    send,
    ws,
    addMessageListener,
    removeMessageListener
  };
});
