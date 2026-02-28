<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterView } from 'vue-router'
import { useRouter } from 'vue-router'
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
const router = useRouter()

const usernameInput = ref('')
const showCreateServerModal = ref(false)
const newServerAddress = ref('')

const showCreateChannelModal = ref(false)
const newChannelName = ref('')
const newChannelType = ref<'text' | 'voice' | 'rss' | 'folder'>('text')
const newChannelFeedUrl = ref('')
const selectedCategoryId = ref<string | null>(null)
const createChannelError = ref<string | null>(null)

const showInviteModal = ref(false)
const showServerSettingsModal = ref(false)
const showAdminModal = ref(false)
const adminKeyInput = ref('')

const serverSettingsForm = ref({
  title: '',
  rulesChannelId: '',
  welcomeChannelId: '',
  storage: {
    enabled: false,
    endpoint: '',
    region: '',
    bucket: '',
    accessKey: '',
    secretKey: '',
    prefix: '',
    status: 'data_dir' as 'data_dir' | 's3',
    lastError: null as string | null
  }
})

const activeServerSettingsSection = ref('general-settings')
const serverSettingsNavGroups = ref<ServerSettingsNavGroup[]>([
  {
    id: 'server',
    label: 'Server Settings',
    expanded: true,
    items: [
      { id: 'general-settings', label: 'General Settings' },
      { id: 'storage-settings', label: 'Storage / S3' }
    ]
  }
])

const isAdmin = computed(() => chatStore.currentUserRole === 'admin')

const shouldShowMemberList = computed(() => chatStore.activeMainPanel.type !== 'voice')

const inviteLink = computed(() => {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || 'localhost'
  const port = window.location.port ? `:${window.location.port}` : ''
  return `${protocol}//${host}${port}`
})

const activeServer = computed(() => {
  if (chatStore.server?.title) {
    return { name: chatStore.server.title }
  }
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

const handleCreateServer = async () => {
  const added = await chatStore.addServerConnection(newServerAddress.value.trim())
  if (added) {
    showCreateServerModal.value = false
    newServerAddress.value = ''
  }
}

const openCreateChannelModal = (payload: { categoryId: string | null; type?: 'text' | 'voice' | 'rss' | 'folder' }) => {
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
  const trimmedFeedUrl = newChannelFeedUrl.value.trim()
  if (!trimmedName) {
    createChannelError.value = 'Channel name is required'
    return
  }

  if (newChannelType.value === 'rss' && !trimmedFeedUrl) {
    createChannelError.value = 'RSS feed URL is required'
    return
  }

  createChannelError.value = null
  chatStore.clearError()
  chatStore.createChannel(selectedCategoryId.value, trimmedName, newChannelType.value, trimmedFeedUrl)
}

const handleChatStoreMessage = (message: any) => {
  if (!showCreateChannelModal.value) return

  if (message.type === 'channel_created') {
    showCreateChannelModal.value = false
    newChannelName.value = ''
    newChannelType.value = 'text'
    newChannelFeedUrl.value = ''
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
      serverSettingsForm.value.title,
      serverSettingsForm.value.rulesChannelId || null,
      serverSettingsForm.value.welcomeChannelId || null,
      {
        enabled: serverSettingsForm.value.storage.enabled,
        endpoint: serverSettingsForm.value.storage.endpoint,
        region: serverSettingsForm.value.storage.region,
        bucket: serverSettingsForm.value.storage.bucket,
        accessKey: serverSettingsForm.value.storage.accessKey,
        secretKey: serverSettingsForm.value.storage.secretKey,
        prefix: serverSettingsForm.value.storage.prefix
      }
    )
    showServerSettingsModal.value = false
  }
}

watch(showServerSettingsModal, (newVal) => {
  if (newVal && chatStore.server) {
    activeServerSettingsSection.value = 'general-settings'
    chatStore.requestServerStorageSettings()
    serverSettingsNavGroups.value = serverSettingsNavGroups.value.map((group) => ({
      ...group,
      expanded: true
    }))
    serverSettingsForm.value.title = chatStore.server.title || chatStore.server.name || ''
    serverSettingsForm.value.rulesChannelId = chatStore.server.rulesChannelId || ''
    serverSettingsForm.value.welcomeChannelId = chatStore.server.welcomeChannelId || ''
    serverSettingsForm.value.storage.enabled = chatStore.serverStorageSettings.storageType === 's3'
    serverSettingsForm.value.storage.endpoint = chatStore.serverStorageSettings.s3.endpoint
    serverSettingsForm.value.storage.region = chatStore.serverStorageSettings.s3.region
    serverSettingsForm.value.storage.bucket = chatStore.serverStorageSettings.s3.bucket
    serverSettingsForm.value.storage.accessKey = chatStore.serverStorageSettings.s3.accessKey
    serverSettingsForm.value.storage.secretKey = chatStore.serverStorageSettings.s3.secretKey
    serverSettingsForm.value.storage.prefix = chatStore.serverStorageSettings.s3.prefix
    serverSettingsForm.value.storage.status = chatStore.serverStorageSettings.storageType
    serverSettingsForm.value.storage.lastError = chatStore.serverStorageSettings.storageLastError
  }
})

watch(
  () => chatStore.serverStorageSettings,
  (storageSettings) => {
    if (!showServerSettingsModal.value) {
      return
    }
    serverSettingsForm.value.storage.status = storageSettings.storageType
    serverSettingsForm.value.storage.lastError = storageSettings.storageLastError
    serverSettingsForm.value.storage.enabled = storageSettings.storageType === 's3'
    serverSettingsForm.value.storage.endpoint = storageSettings.s3.endpoint
    serverSettingsForm.value.storage.region = storageSettings.s3.region
    serverSettingsForm.value.storage.bucket = storageSettings.s3.bucket
    serverSettingsForm.value.storage.accessKey = storageSettings.s3.accessKey
    serverSettingsForm.value.storage.secretKey = storageSettings.s3.secretKey
    serverSettingsForm.value.storage.prefix = storageSettings.s3.prefix
  },
  { deep: true }
)

watch(
  () => chatStore.moderationNotice,
  (notice) => {
    if (!notice) return
    router.replace({ name: 'home' })
  }
)

onMounted(() => {
  chatStore.addMessageListener(handleChatStoreMessage)
  chatStore.clearError()
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
      v-model:server-address="newServerAddress"
      :error-message="chatStore.lastError"
      @create="handleCreateServer"
    />

    <CreateChannelModal
      v-model:visible="showCreateChannelModal"
      v-model:channel-name="newChannelName"
      v-model:channel-type="newChannelType"
      v-model:channel-feed-url="newChannelFeedUrl"
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

    <div v-if="chatStore.moderationNotice" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/80">
      <div class="bg-[#313338] p-6 rounded-lg shadow-xl w-96 max-w-[95vw]">
        <h2 class="text-xl font-bold text-white mb-2">{{ chatStore.moderationNotice.title }}</h2>
        <p class="text-sm text-gray-300 mb-6">{{ chatStore.moderationNotice.message }}</p>
        <div class="flex justify-end">
          <button
            @click="chatStore.clearModerationNotice()"
            class="bg-indigo-500 hover:bg-indigo-600 text-white px-5 py-2 rounded text-sm font-medium"
          >
            OK
          </button>
        </div>
      </div>
    </div>

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

      <MemberListSidebar v-if="shouldShowMemberList" />
    </main>
  </div>
</template>
