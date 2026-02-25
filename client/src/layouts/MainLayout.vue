<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterView } from 'vue-router'
import { useChatStore } from '../stores/chat'
import LoginModal from '../components/layout/modals/LoginModal.vue'
import CreateServerModal from '../components/layout/modals/CreateServerModal.vue'
import CreateChannelModal from '../components/layout/modals/CreateChannelModal.vue'
import ServerSettingsModal from '../components/layout/modals/ServerSettingsModal.vue'
import ServerListSidebar from '../components/layout/ServerListSidebar.vue'
import ChannelListSidebar from '../components/layout/ChannelListSidebar.vue'
import MemberListSidebar from '../components/layout/MemberListSidebar.vue'

type ServerSettingsNavGroup = {
  id: string
  label: string
  expanded: boolean
  items: Array<{ id: string; label: string }>
}

const chatStore = useChatStore()

const usernameInput = ref('')
const showCreateServerModal = ref(false)
const newServerName = ref('')
const newServerAddress = ref('')

const showCreateChannelModal = ref(false)
const newChannelName = ref('')
const newChannelType = ref<'text' | 'voice'>('text')
const selectedCategoryId = ref<string | null>(null)
const createChannelError = ref<string | null>(null)

const showInviteModal = ref(false)
const showServerSettingsModal = ref(false)
const showAdminModal = ref(false)
const adminKeyInput = ref('')

const serverSettingsForm = ref({
  rulesChannelId: '',
  welcomeChannelId: ''
})

const activeServerSettingsSection = ref('general-settings')
const serverSettingsNavGroups = ref<ServerSettingsNavGroup[]>([
  {
    id: 'server',
    label: 'Server Settings',
    expanded: true,
    items: [{ id: 'general-settings', label: 'General Settings' }]
  }
])

const isAdmin = computed(() => chatStore.currentUserRole === 'admin')

const inviteLink = computed(() => {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || 'localhost'
  const port = window.location.port ? `:${window.location.port}` : ''
  return `${protocol}//${host}${port}`
})

const activeServer = computed(() => {
  if (chatStore.activeConnectionId) {
    const connection = chatStore.savedConnections.find((c) => c.id === chatStore.activeConnectionId)
    if (connection) {
      return { name: connection.name }
    }
  }
  return { name: 'RogueCord Server' }
})

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

const openCreateChannelModal = (payload: { categoryId: string | null; type?: 'text' | 'voice' }) => {
  if (!isAdmin.value) return

  createChannelError.value = null
  chatStore.clearError()
  selectedCategoryId.value = payload.categoryId
  if (payload.type) {
    newChannelType.value = payload.type
  }
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

const handleRemoveServer = () => {
  if (chatStore.activeConnectionId && confirm('Are you sure you want to remove this server?')) {
    chatStore.removeSavedConnection(chatStore.activeConnectionId)
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

const toggleServerSettingsGroup = (groupId: string) => {
  serverSettingsNavGroups.value = serverSettingsNavGroups.value.map((group) =>
    group.id === groupId ? { ...group, expanded: !group.expanded } : group
  )
}

const selectServerSettingsSection = (sectionId: string) => {
  activeServerSettingsSection.value = sectionId
}

const saveServerSettings = () => {
  if (chatStore.server) {
    chatStore.updateServerSettings(
      chatStore.server.id,
      serverSettingsForm.value.rulesChannelId || null,
      serverSettingsForm.value.welcomeChannelId || null
    )
    showServerSettingsModal.value = false
  }
}

watch(showServerSettingsModal, (newVal) => {
  if (newVal && chatStore.server) {
    activeServerSettingsSection.value = 'general-settings'
    serverSettingsNavGroups.value = serverSettingsNavGroups.value.map((group) => ({
      ...group,
      expanded: true
    }))
    serverSettingsForm.value.rulesChannelId = chatStore.server.rulesChannelId || ''
    serverSettingsForm.value.welcomeChannelId = chatStore.server.welcomeChannelId || ''
  }
})

onMounted(() => {
  chatStore.addMessageListener(handleChatStoreMessage)
  const lastUsedServer = localStorage.getItem('lastUsedServer')
  if (lastUsedServer) {
    chatStore.connect(lastUsedServer, true)
  }
})

onUnmounted(() => {
  chatStore.removeMessageListener(handleChatStoreMessage)
})
</script>

<template>
  <div class="flex h-screen w-full overflow-hidden bg-[#313338] text-[#dbdee1] font-sans">
    <LoginModal :visible="!chatStore.localUsername" v-model:username="usernameInput" @login="login" />

    <CreateServerModal
      v-model:visible="showCreateServerModal"
      v-model:server-name="newServerName"
      v-model:server-address="newServerAddress"
      @create="handleCreateServer"
    />

    <CreateChannelModal
      v-model:visible="showCreateChannelModal"
      v-model:channel-name="newChannelName"
      v-model:channel-type="newChannelType"
      :error-message="createChannelError || chatStore.lastError"
      @create="handleCreateChannel"
    />

    <ServerSettingsModal
      v-model:visible="showServerSettingsModal"
      v-model:form="serverSettingsForm"
      :active-section="activeServerSettingsSection"
      :nav-groups="serverSettingsNavGroups"
      @toggle-group="toggleServerSettingsGroup"
      @select-section="selectServerSettingsSection"
      @save="saveServerSettings"
    />

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

    <ServerListSidebar @open-create-server="showCreateServerModal = true" />

    <ChannelListSidebar
      :is-admin="isAdmin"
      @open-server-settings="showServerSettingsModal = true"
      @open-invite="showInviteModal = true"
      @remove-server="handleRemoveServer"
      @open-admin="showAdminModal = true"
      @open-create-channel="openCreateChannelModal"
    />

    <!-- Main Content Area -->
    <main class="flex-1 flex min-w-0 bg-[#313338]">
      <div class="flex-1 flex flex-col min-w-0">
        <RouterView />
      </div>

      <MemberListSidebar />
    </main>
  </div>
</template>
