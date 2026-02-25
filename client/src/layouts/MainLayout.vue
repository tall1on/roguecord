<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { RouterView } from 'vue-router'
import { Hash, Volume2, Settings, Mic, MicOff, Headphones, Plus, Link, PhoneOff, Trash2 } from 'lucide-vue-next'
import { useChatStore } from '../stores/chat'
import { useWebRtcStore } from '../stores/webrtc'

const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()

const showVoiceStats = ref(false)
const voiceStatsContainerRef = ref<HTMLElement | null>(null)

const handleClickOutside = (event: MouseEvent) => {
  if (showVoiceStats.value && voiceStatsContainerRef.value && !voiceStatsContainerRef.value.contains(event.target as Node)) {
    showVoiceStats.value = false
  }

  if (contextMenuVisible.value) {
    const target = event.target as HTMLElement | null
    if (!target?.closest('.channel-context-menu')) {
      contextMenuVisible.value = false
    }
  }
}

watch(() => webrtcStore.activeVoiceChannelId, (newVal) => {
  if (!newVal) {
    showVoiceStats.value = false
  }
})

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  chatStore.addMessageListener(handleChatStoreMessage)
  const lastUsedServer = localStorage.getItem('lastUsedServer')
  if (lastUsedServer) {
    chatStore.connect(lastUsedServer, true)
  }
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  chatStore.removeMessageListener(handleChatStoreMessage)
})

const usernameInput = ref('')
const showCreateServerModal = ref(false)
const newServerName = ref('')
const newServerAddress = ref('')

const showCreateChannelModal = ref(false)
const newChannelName = ref('')
const newChannelType = ref<'text' | 'voice'>('text')
const selectedCategoryId = ref<string | null>(null)
const createChannelError = ref<string | null>(null)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)

const showInviteModal = ref(false)
const inviteLink = computed(() => {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || 'localhost'
  const port = window.location.port ? `:${window.location.port}` : ''
  return `${protocol}//${host}${port}`
})

const showAdminModal = ref(false)
const adminKeyInput = ref('')
const isAdmin = computed(() => chatStore.currentUserRole === 'admin')

const login = () => {
  if (usernameInput.value.trim()) {
    chatStore.saveLocalUsername(usernameInput.value.trim())
  }
}

const handleCreateServer = () => {
  if (newServerName.value.trim() && newServerAddress.value.trim()) {
    chatStore.addSavedConnection(newServerName.value.trim(), newServerAddress.value.trim())
    showCreateServerModal.value = false
    newServerName.value = ''
    newServerAddress.value = ''
  }
}

const openCreateChannelModal = (categoryId: string | null = null) => {
  if (!isAdmin.value) return

  createChannelError.value = null
  chatStore.clearError()
  selectedCategoryId.value = categoryId
  showCreateChannelModal.value = true
}

const handleCreateChannel = () => {
  if (!isAdmin.value) return

  const trimmedName = newChannelName.value.trim()
  if (!trimmedName) {
    createChannelError.value = 'Channel name is required'
    return
  }

  createChannelError.value = null
  chatStore.clearError()
  chatStore.createChannel(selectedCategoryId.value, trimmedName, newChannelType.value)
}

const openCreateChannelFromContextMenu = (type: 'text' | 'voice') => {
  if (!isAdmin.value) return

  contextMenuVisible.value = false
  newChannelType.value = type
  openCreateChannelModal(null)
}

const openChannelListContextMenu = (event: MouseEvent) => {
  if (!isAdmin.value) return

  event.preventDefault()
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuVisible.value = true
}

const handleChatStoreMessage = (message: any) => {
  if (!showCreateChannelModal.value) return

  if (message.type === 'channel_created') {
    showCreateChannelModal.value = false
    newChannelName.value = ''
    newChannelType.value = 'text'
    createChannelError.value = null
    chatStore.clearError()
    return
  }

  if (message.type === 'error') {
    createChannelError.value = message.payload?.message || 'Failed to create channel'
  }
}

const copyInviteLink = () => {
  navigator.clipboard.writeText(inviteLink.value)
  showInviteModal.value = false
}

const handleAdminKeySubmit = () => {
  if (adminKeyInput.value.trim()) {
    chatStore.submitAdminKey(adminKeyInput.value.trim())
    showAdminModal.value = false
    adminKeyInput.value = ''
  }
}

const handleRemoveServer = () => {
  if (chatStore.activeConnectionId) {
    if (confirm('Are you sure you want to remove this server?')) {
      chatStore.removeSavedConnection(chatStore.activeConnectionId)
    }
  }
}

const handleChannelClick = (channel: any) => {
  if (channel.type === 'text') {
    chatStore.setActiveChannel(channel.id)
  } else if (channel.type === 'voice') {
    webrtcStore.joinVoiceChannel(channel.id)
  }
}

const activeServer = computed(() => {
  if (chatStore.activeConnectionId) {
    const connection = chatStore.savedConnections.find(c => c.id === chatStore.activeConnectionId)
    if (connection) {
      return { name: connection.name }
    }
  }
  return { name: 'RogueCord Server' }
})

const groupedMembers = computed(() => {
  const online = chatStore.users.filter(u => chatStore.onlineUserIds.has(u.id))
  const offline = chatStore.users.filter(u => !chatStore.onlineUserIds.has(u.id))

  // Group online by role
  const onlineByRole: Record<string, any[]> = {}
  online.forEach(u => {
    let role = u.role || 'user'
    // Format role name (e.g., 'admin' -> 'Admins', 'user' -> 'Users')
    role = role.charAt(0).toUpperCase() + role.slice(1) + 's'
    
    if (!onlineByRole[role]) onlineByRole[role] = []
    onlineByRole[role]!.push(u)
  })

  // Sort roles: Admins first, then others
  const sortedRoles = Object.keys(onlineByRole).sort((a, b) => {
    if (a === 'Admins') return -1;
    if (b === 'Admins') return 1;
    return a.localeCompare(b);
  });

  const sortedOnlineByRole: Record<string, any[]> = {};
  sortedRoles.forEach(role => {
    sortedOnlineByRole[role] = onlineByRole[role]!.sort((a, b) => a.username.localeCompare(b.username));
  });

  return {
    onlineByRole: sortedOnlineByRole,
    offline: offline.sort((a, b) => a.username.localeCompare(b.username))
  }
})
</script>

<template>
  <div class="flex h-screen w-full overflow-hidden bg-[#313338] text-[#dbdee1] font-sans">
    
    <!-- Login Modal -->
    <div v-if="!chatStore.localUsername" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div class="bg-[#313338] p-8 rounded-lg shadow-xl w-96 text-center">
        <h2 class="text-2xl font-bold text-white mb-2">Welcome back!</h2>
        <p class="text-gray-400 mb-6">We're so excited to see you again!</p>
        
        <div class="text-left mb-4">
          <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Username</label>
          <input 
            v-model="usernameInput" 
            @keyup.enter="login"
            type="text" 
            class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="Enter your username"
          />
        </div>
        
        <button 
          @click="login"
          class="w-full bg-indigo-500 hover:bg-indigo-600 text-white font-semibold py-2.5 rounded transition-colors"
        >
          Log In
        </button>
      </div>
    </div>

    <!-- Create Server Modal -->
    <div v-if="showCreateServerModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div class="bg-[#313338] p-6 rounded-lg shadow-xl w-96">
        <h2 class="text-2xl font-bold text-white mb-4 text-center">Add a Connection</h2>
        <p class="text-gray-400 mb-6 text-center text-sm">Connect to a new server.</p>
        
        <div class="mb-4">
          <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Connection Name</label>
          <input 
            v-model="newServerName" 
            type="text" 
            class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="My Server"
          />
        </div>

        <div class="mb-6">
          <label class="block text-xs font-bold text-gray-300 uppercase mb-2">WebSocket Address</label>
          <input 
            v-model="newServerAddress" 
            @keyup.enter="handleCreateServer"
            type="text" 
            class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="wss://localhost:3000"
          />
        </div>
        
        <div class="flex justify-between items-center">
          <button @click="showCreateServerModal = false" class="text-gray-400 hover:text-white text-sm">Back</button>
          <button @click="handleCreateServer" class="bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-2 rounded font-medium">Add</button>
        </div>
      </div>
    </div>

    <!-- Create Channel Modal -->
    <div v-if="showCreateChannelModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div class="bg-[#313338] p-6 rounded-lg shadow-xl w-96">
        <h2 class="text-xl font-bold text-white mb-4">Create Channel</h2>
        
        <div class="mb-4">
          <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Channel Type</label>
          <div class="space-y-2">
            <label class="flex items-center p-3 bg-[#2b2d31] rounded cursor-pointer hover:bg-[#3f4147]">
              <input type="radio" v-model="newChannelType" value="text" class="mr-3 text-indigo-500 focus:ring-indigo-500 bg-[#1e1f22] border-gray-600">
              <Hash class="w-5 h-5 text-gray-400 mr-2" />
              <div>
                <div class="text-white font-medium">Text</div>
                <div class="text-xs text-gray-400">Send messages, images, GIFs, emoji, opinions, and puns</div>
              </div>
            </label>
            <label class="flex items-center p-3 bg-[#2b2d31] rounded cursor-pointer hover:bg-[#3f4147]">
              <input type="radio" v-model="newChannelType" value="voice" class="mr-3 text-indigo-500 focus:ring-indigo-500 bg-[#1e1f22] border-gray-600">
              <Volume2 class="w-5 h-5 text-gray-400 mr-2" />
              <div>
                <div class="text-white font-medium">Voice</div>
                <div class="text-xs text-gray-400">Hang out together with voice, video, and screen share</div>
              </div>
            </label>
          </div>
        </div>

        <div class="mb-6">
          <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Channel Name</label>
          <div class="relative">
            <Hash v-if="newChannelType === 'text'" class="w-4 h-4 text-gray-400 absolute left-3 top-3" />
            <Volume2 v-else class="w-4 h-4 text-gray-400 absolute left-3 top-3" />
            <input 
              v-model="newChannelName" 
              @keyup.enter="handleCreateChannel"
              type="text" 
              class="w-full bg-[#1e1f22] text-white p-2.5 pl-9 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="new-channel"
            />
          </div>
          <p v-if="createChannelError || chatStore.lastError" class="mt-2 text-xs text-red-400">
            {{ createChannelError || chatStore.lastError }}
          </p>
        </div>
        
        <div class="flex justify-end gap-4">
          <button @click="showCreateChannelModal = false" class="text-gray-400 hover:text-white text-sm">Cancel</button>
          <button @click="handleCreateChannel" class="bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-2 rounded font-medium">Create Channel</button>
        </div>
      </div>
    </div>

    <!-- Invite Modal -->
    <div v-if="showInviteModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div class="bg-[#313338] p-6 rounded-lg shadow-xl w-96">
        <h2 class="text-xl font-bold text-white mb-2">Invite friends to {{ activeServer?.name || 'Server' }}</h2>
        <p class="text-gray-400 mb-4 text-sm">Share this link with others to grant them access to this server.</p>
        
        <div class="mb-6">
          <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Server Invite Link</label>
          <div class="flex bg-[#1e1f22] rounded p-1">
            <input 
              type="text" 
              readonly
              :value="inviteLink"
              class="w-full bg-transparent text-white p-2 focus:outline-none text-sm"
            />
            <button @click="copyInviteLink" class="bg-indigo-500 hover:bg-indigo-600 text-white px-4 py-1.5 rounded text-sm font-medium transition-colors">
              Copy
            </button>
          </div>
        </div>
        
        <div class="flex justify-end">
          <button @click="showInviteModal = false" class="text-gray-400 hover:text-white text-sm">Close</button>
        </div>
      </div>
    </div>

    <!-- Admin Key Modal -->
    <div v-if="showAdminModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div class="bg-[#313338] p-6 rounded-lg shadow-xl w-96">
        <h2 class="text-xl font-bold text-white mb-4">Enter Admin Key</h2>
        
        <div class="mb-6">
          <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Admin Key</label>
          <input 
            v-model="adminKeyInput" 
            @keyup.enter="handleAdminKeySubmit"
            type="password" 
            class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="Enter admin key"
          />
        </div>
        
        <div class="flex justify-end gap-4">
          <button @click="showAdminModal = false" class="text-gray-400 hover:text-white text-sm">Cancel</button>
          <button @click="handleAdminKeySubmit" class="bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-2 rounded font-medium">Submit</button>
        </div>
      </div>
    </div>

    <!-- Server List Sidebar (Leftmost) -->
    <nav class="w-[72px] bg-[#1e1f22] flex flex-col items-center py-3 gap-2 shrink-0 overflow-y-auto no-scrollbar">
      <!-- Direct Messages Icon -->
      <div class="w-12 h-12 rounded-[24px] hover:rounded-[16px] bg-[#313338] hover:bg-indigo-500 text-white flex items-center justify-center transition-all duration-200 cursor-pointer group">
        <svg class="w-7 h-7 text-gray-300 group-hover:text-white" fill="currentColor" viewBox="0 0 24 24">
          <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.21.4-.4.8-.58 1.21-1.69-.25-3.4-.25-5.1 0-.18-.41-.37-.82-.59-1.2-1.6.27-3.14.75-4.6 1.43A19.04 19.04 0 0 0 1.96 19.58c2.09 1.52 4.1 2.44 6.09 3.04.5-.66.95-1.36 1.35-2.09-1.08-.4-2.1-.89-3.06-1.46.26-.19.51-.39.75-.6 3.9 1.79 8.18 1.79 12.06 0 .24.21.49.41.75.6-.96.57-1.98 1.06-3.06 1.46.4.73.85 1.43 1.35 2.09 2-.6 4.01-1.52 6.1-3.04a19.02 19.02 0 0 0-2.32-14.71zM8.52 16.28c-1.21 0-2.21-1.08-2.21-2.4 0-1.33.98-2.4 2.21-2.4 1.23 0 2.23 1.07 2.21 2.4 0 1.32-.98 2.4-2.21 2.4zm6.96 0c-1.21 0-2.21-1.08-2.21-2.4 0-1.33.98-2.4 2.21-2.4 1.23 0 2.23 1.07 2.21 2.4 0 1.32-.98 2.4-2.21 2.4z"/>
        </svg>
      </div>
      
      <div class="w-8 h-[2px] bg-[#35363c] rounded-full my-1"></div>
      
      <!-- Server Icons -->
      <div 
        v-for="connection in chatStore.savedConnections" 
        :key="connection.id"
        @click="chatStore.connect(connection.address)"
        class="relative flex items-center justify-center w-full group cursor-pointer"
      >
        <!-- Active Indicator -->
        <div 
          class="absolute left-0 w-1 bg-white rounded-r-full transition-all duration-200"
          :class="chatStore.activeConnectionId === connection.id ? 'h-10' : 'h-2 opacity-0 group-hover:opacity-100 group-hover:h-5'"
        ></div>
        
        <div 
          class="w-12 h-12 flex items-center justify-center transition-all duration-200 font-bold text-lg overflow-hidden"
          :class="chatStore.activeConnectionId === connection.id ? 'rounded-[16px] bg-indigo-500 text-white' : 'rounded-[24px] hover:rounded-[16px] bg-[#313338] hover:bg-indigo-500 text-gray-100'"
        >
          <img v-if="connection.iconUrl" :src="connection.iconUrl" alt="Server Icon" class="w-full h-full object-cover" />
          <span v-else>{{ connection.name.charAt(0).toUpperCase() }}</span>
        </div>
      </div>
      
      <!-- Add Server -->
      <div 
        @click="showCreateServerModal = true"
        class="w-12 h-12 rounded-[24px] hover:rounded-[16px] bg-[#313338] hover:bg-green-500 text-green-500 hover:text-white flex items-center justify-center transition-all duration-200 cursor-pointer mt-2"
      >
        <Plus class="w-6 h-6" />
      </div>
    </nav>

    <!-- Channel List Sidebar -->
    <aside class="w-60 bg-[#2b2d31] flex flex-col shrink-0">
      <template v-if="chatStore.activeConnectionId">
        <!-- Server Header -->
        <header 
          v-if="activeServer"
          class="h-12 px-4 flex items-center justify-between shadow-sm border-b border-[#1e1f22] hover:bg-[#35373c] cursor-pointer transition-colors shrink-0"
        >
          <h1 class="font-bold text-white truncate">{{ activeServer.name }}</h1>
          <div class="flex items-center gap-3">
            <button @click.stop="showInviteModal = true" class="text-gray-400 hover:text-white" title="Invite People">
              <Link class="w-4 h-4" />
            </button>
            <button @click.stop="handleRemoveServer" class="text-gray-400 hover:text-red-500" title="Remove Server">
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </header>
        <header v-else class="h-12 px-4 flex items-center shadow-sm border-b border-[#1e1f22] shrink-0">
          <h1 class="font-bold text-white truncate">No Server Selected</h1>
        </header>

        <!-- Channels -->
        <div class="flex-1 overflow-y-auto p-2 space-y-[2px] custom-scrollbar" @contextmenu.prevent="openChannelListContextMenu">
          <template v-if="true">
          <div v-for="category in chatStore.activeServerCategories" :key="category.id">
            <!-- Category Header -->
            <div class="pt-4 pb-1 px-2 flex items-center justify-between group cursor-pointer">
              <div class="flex items-center text-xs font-semibold text-gray-400 group-hover:text-gray-300 uppercase tracking-wider">
                <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                {{ category.name }}
              </div>
              <button v-if="isAdmin" @click.stop="openCreateChannelModal(category.id)" class="text-gray-400 hover:text-gray-200 opacity-0 group-hover:opacity-100">
                <Plus class="w-4 h-4" />
              </button>
            </div>
            
            <!-- Channels in Category -->
            <div 
              v-for="channel in chatStore.activeServerChannels.filter(c => c.category_id === category.id)" 
              :key="channel.id"
            >
              <div
                @click="handleChannelClick(channel)"
                class="flex items-center px-2 py-1.5 rounded cursor-pointer group mb-[2px]"
                :class="(channel.type === 'text' && chatStore.activeChannelId === channel.id) || (channel.type === 'voice' && webrtcStore.activeVoiceChannelId === channel.id) ? 'bg-[#404249] text-white' : 'hover:bg-[#35373c] text-gray-400 hover:text-gray-300'"
              >
                <Hash v-if="channel.type === 'text'" class="w-5 h-5 mr-1.5 text-gray-400 group-hover:text-gray-300" />
                <Volume2 v-else class="w-5 h-5 mr-1.5 text-gray-400 group-hover:text-gray-300" />
                <span class="truncate font-medium">{{ channel.name }}</span>
              </div>
              
              <!-- Voice Participants -->
              <div v-if="channel.type === 'voice' && webrtcStore.channelParticipants.get(channel.id)?.length" class="pl-8 pr-2 pb-2 space-y-1">
                <div v-for="user in webrtcStore.channelParticipants.get(channel.id)" :key="user.id" class="flex items-center text-gray-300 text-sm">
                  <div class="w-6 h-6 rounded-full bg-indigo-500 mr-2 flex items-center justify-center text-xs font-bold text-white overflow-hidden">
                    <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover" />
                    <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
                  </div>
                  <span class="truncate flex-1">{{ user.username }}</span>
                  <div class="flex items-center gap-1 ml-2">
                    <MicOff v-if="user.isMuted || user.isDeafened" class="w-3.5 h-3.5 text-red-500" />
                    <div v-if="user.isDeafened" class="relative flex items-center justify-center">
                      <Headphones class="w-3.5 h-3.5 text-red-500" />
                      <div class="absolute w-4 h-[1.5px] bg-red-500 rotate-45 rounded-full"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Uncategorized Channels -->
          <div v-if="chatStore.activeServerChannels.filter(c => !c.category_id).length > 0">
            <div class="pt-4 pb-1 px-2 flex items-center justify-between group cursor-pointer">
              <div class="text-xs font-semibold text-gray-400 group-hover:text-gray-300 uppercase tracking-wider">
                Channels
              </div>
              <button v-if="isAdmin" @click.stop="openCreateChannelModal()" class="text-gray-400 hover:text-gray-200 opacity-0 group-hover:opacity-100">
                <Plus class="w-4 h-4" />
              </button>
            </div>
            <div 
              v-for="channel in chatStore.activeServerChannels.filter(c => !c.category_id)" 
              :key="channel.id"
            >
              <div
                @click="handleChannelClick(channel)"
                class="flex items-center px-2 py-1.5 rounded cursor-pointer group mb-[2px]"
                :class="(channel.type === 'text' && chatStore.activeChannelId === channel.id) || (channel.type === 'voice' && webrtcStore.activeVoiceChannelId === channel.id) ? 'bg-[#404249] text-white' : 'hover:bg-[#35373c] text-gray-400 hover:text-gray-300'"
              >
                <Hash v-if="channel.type === 'text'" class="w-5 h-5 mr-1.5 text-gray-400 group-hover:text-gray-300" />
                <Volume2 v-else class="w-5 h-5 mr-1.5 text-gray-400 group-hover:text-gray-300" />
                <span class="truncate font-medium">{{ channel.name }}</span>
              </div>
              
              <!-- Voice Participants -->
              <div v-if="channel.type === 'voice' && webrtcStore.channelParticipants.get(channel.id)?.length" class="pl-8 pr-2 pb-2 space-y-1">
                <div v-for="user in webrtcStore.channelParticipants.get(channel.id)" :key="user.id" class="flex items-center text-gray-300 text-sm">
                  <div class="w-6 h-6 rounded-full bg-indigo-500 mr-2 flex items-center justify-center text-xs font-bold text-white overflow-hidden">
                    <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover" />
                    <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
                  </div>
                  <span class="truncate flex-1">{{ user.username }}</span>
                  <div class="flex items-center gap-1 ml-2">
                    <MicOff v-if="user.isMuted || user.isDeafened" class="w-3.5 h-3.5 text-red-500" />
                    <div v-if="user.isDeafened" class="relative flex items-center justify-center">
                      <Headphones class="w-3.5 h-3.5 text-red-500" />
                      <div class="absolute w-4 h-[1.5px] bg-red-500 rotate-45 rounded-full"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div
        v-if="contextMenuVisible && isAdmin"
        class="channel-context-menu fixed z-50 w-52 rounded-md border border-[#1e1f22] bg-[#111214] shadow-xl py-1"
        :style="{ left: `${contextMenuX}px`, top: `${contextMenuY}px` }"
      >
        <button
          class="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-[#2b2d31] flex items-center gap-2"
          @click="openCreateChannelFromContextMenu('text')"
        >
          <Hash class="w-4 h-4" />
          Create text channel
        </button>
        <button
          class="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-[#2b2d31] flex items-center gap-2"
          @click="openCreateChannelFromContextMenu('voice')"
        >
          <Volume2 class="w-4 h-4" />
          Create voice channel
        </button>
      </div>
      </template>
      <template v-else>
        <div class="flex-1 flex items-center justify-center text-gray-500 text-sm p-4 text-center">
          Select a connection to view channels
        </div>
      </template>

      <!-- Voice Connection Status -->
      <div v-if="webrtcStore.activeVoiceChannelId" class="relative" ref="voiceStatsContainerRef">
        <div class="h-[52px] bg-[#292b2f] px-2 flex items-center shrink-0 border-b border-[#1e1f22] cursor-pointer hover:bg-[#35373c] transition-colors" @click="showVoiceStats = !showVoiceStats">
          <div class="flex items-center flex-1 min-w-0">
            <div class="mr-2" :class="{
              'text-green-500': webrtcStore.connectionQuality === 'good',
              'text-orange-500': webrtcStore.connectionQuality === 'warning',
              'text-red-500': webrtcStore.connectionQuality === 'bad'
            }">
              <Volume2 class="w-5 h-5" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-semibold truncate" :class="{
                'text-green-500': webrtcStore.connectionQuality === 'good',
                'text-orange-500': webrtcStore.connectionQuality === 'warning',
                'text-red-500': webrtcStore.connectionQuality === 'bad'
              }">Voice Connected</div>
              <div class="text-xs text-gray-400 truncate">
                {{ chatStore.activeServerChannels.find(c => c.id === webrtcStore.activeVoiceChannelId)?.name || 'Voice Channel' }}
              </div>
            </div>
          </div>
          <button @click.stop="webrtcStore.leaveVoiceChannel()" class="w-8 h-8 flex items-center justify-center rounded hover:bg-[#3f4147] text-gray-400 hover:text-red-400 transition-colors" title="Disconnect">
            <PhoneOff class="w-5 h-5" />
          </button>
        </div>

        <!-- Voice Stats Popover -->
        <div v-if="showVoiceStats" class="absolute bottom-[56px] left-2 w-64 bg-[#1e1f22] rounded-lg shadow-xl border border-[#3f4147] p-4 z-50">
          <div class="flex justify-between items-center mb-3">
            <h3 class="text-sm font-bold text-white uppercase">Voice Connection</h3>
            <div class="text-xs font-medium px-2 py-0.5 rounded" :class="{
              'bg-green-500/20 text-green-400': webrtcStore.connectionQuality === 'good',
              'bg-orange-500/20 text-orange-400': webrtcStore.connectionQuality === 'warning',
              'bg-red-500/20 text-red-400': webrtcStore.connectionQuality === 'bad'
            }">
              {{ webrtcStore.ping }} ms
            </div>
          </div>
          
          <div class="space-y-3">
            <div>
              <div class="text-xs text-gray-400 mb-1 flex justify-between">
                <span>Ping History</span>
                <span>{{ webrtcStore.ping }} ms</span>
              </div>
              <div class="h-12 flex items-end gap-[2px] bg-[#2b2d31] p-1 rounded">
                <div v-for="(p, i) in webrtcStore.pingHistory" :key="i" 
                     class="flex-1 rounded-t-sm min-w-[2px]"
                     :style="{ height: `${Math.min(100, Math.max(5, (p / 300) * 100))}%` }"
                     :class="{
                       'bg-green-500': p < 100,
                       'bg-orange-500': p >= 100 && p < 250,
                       'bg-red-500': p >= 250
                     }">
                </div>
              </div>
            </div>
            
            <div>
              <div class="text-xs text-gray-400 mb-1 flex justify-between">
                <span>Bandwidth</span>
                <span>{{ webrtcStore.bandwidth }} kbps</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- User Panel -->
      <div class="h-[52px] bg-[#232428] px-2 flex items-center shrink-0" v-if="chatStore.currentUser">
        <div class="flex items-center hover:bg-[#3f4147] p-1 rounded cursor-pointer flex-1 min-w-0">
          <div class="w-8 h-8 rounded-full bg-indigo-500 relative shrink-0 flex items-center justify-center text-white font-bold">
            {{ chatStore.currentUser.username.charAt(0).toUpperCase() }}
            <div class="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-[#232428]"></div>
          </div>
          <div class="ml-2 flex-1 min-w-0">
            <div class="text-sm font-semibold text-white truncate">{{ chatStore.currentUser.username }}</div>
            <div class="text-xs text-gray-400 truncate">Online</div>
          </div>
        </div>
        <div class="flex items-center gap-1 ml-1">
          <button @click="showAdminModal = true" class="w-8 h-8 flex items-center justify-center rounded hover:bg-[#3f4147] text-gray-400 hover:text-gray-300" title="Admin Access">
            <Settings class="w-5 h-5" />
          </button>
          <button @click="webrtcStore.toggleMute()" class="w-8 h-8 flex items-center justify-center rounded hover:bg-[#3f4147] transition-colors" :class="webrtcStore.isMuted || webrtcStore.isDeafened ? 'text-red-500 hover:text-red-400' : 'text-gray-400 hover:text-gray-300'" :title="webrtcStore.isMuted || webrtcStore.isDeafened ? 'Unmute' : 'Mute'">
            <MicOff v-if="webrtcStore.isMuted || webrtcStore.isDeafened" class="w-5 h-5" />
            <Mic v-else class="w-5 h-5" />
          </button>
          <button @click="webrtcStore.toggleDeafen()" class="w-8 h-8 flex items-center justify-center rounded hover:bg-[#3f4147] transition-colors relative" :class="webrtcStore.isDeafened ? 'text-red-500 hover:text-red-400' : 'text-gray-400 hover:text-gray-300'" :title="webrtcStore.isDeafened ? 'Undeafen' : 'Deafen'">
            <Headphones class="w-5 h-5" />
            <div v-if="webrtcStore.isDeafened" class="absolute w-6 h-[2px] bg-red-500 rotate-45 rounded-full"></div>
          </button>
        </div>
      </div>
    </aside>

    <!-- Main Content Area -->
    <main class="flex-1 flex min-w-0 bg-[#313338]">
      <div class="flex-1 flex flex-col min-w-0">
        <RouterView />
      </div>

      <!-- Member List Sidebar -->
      <aside v-if="chatStore.isConnected && chatStore.activeChannelId" class="w-60 bg-[#2b2d31] flex flex-col shrink-0 border-l border-[#1e1f22]">
        <div class="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
          <!-- Online Members Grouped by Role -->
          <div v-for="(members, role) in groupedMembers.onlineByRole" :key="role">
            <h3 class="text-xs font-bold text-gray-400 uppercase mb-2 px-2">
              {{ role }} — {{ members.length }}
            </h3>
            <div class="space-y-1">
              <div 
                v-for="user in members" 
                :key="user.id"
                class="flex items-center px-2 py-1.5 hover:bg-[#3f4147] rounded cursor-pointer group"
              >
                <div class="relative w-8 h-8 rounded-full bg-indigo-500 shrink-0 flex items-center justify-center text-white font-bold mr-3">
                  <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover rounded-full" />
                  <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
                  <div class="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 rounded-full border-2 border-[#2b2d31] group-hover:border-[#3f4147]"></div>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium truncate group-hover:text-gray-100" :class="user.role === 'admin' ? 'text-red-500' : 'text-gray-300'">{{ user.username }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Offline Members -->
          <div v-if="groupedMembers.offline.length > 0">
            <h3 class="text-xs font-bold text-gray-400 uppercase mb-2 px-2">
              Offline — {{ groupedMembers.offline.length }}
            </h3>
            <div class="space-y-1">
              <div 
                v-for="user in groupedMembers.offline" 
                :key="user.id"
                class="flex items-center px-2 py-1.5 hover:bg-[#3f4147] rounded cursor-pointer group opacity-50 hover:opacity-100"
              >
                <div class="relative w-8 h-8 rounded-full bg-gray-600 shrink-0 flex items-center justify-center text-white font-bold mr-3">
                  <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover rounded-full grayscale" />
                  <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
                  <div class="absolute bottom-0 right-0 w-3.5 h-3.5 bg-gray-500 rounded-full border-2 border-[#2b2d31] group-hover:border-[#3f4147]"></div>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium truncate group-hover:text-gray-300" :class="user.role === 'admin' ? 'text-red-500' : 'text-gray-400'">{{ user.username }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </main>
  </div>
</template>
