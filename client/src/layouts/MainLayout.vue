<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterView } from 'vue-router'
import { useRouter } from 'vue-router'
import { useChatStore } from '../stores/chat'
import { useWebRtcStore } from '../stores/webrtc'
import LoginModal from '../components/layout/modals/LoginModal.vue'
import CreateServerModal from '../components/layout/modals/CreateServerModal.vue'
import CreateChannelModal from '../components/layout/modals/CreateChannelModal.vue'
import ServerSettingsModal from '../components/layout/modals/ServerSettingsModal.vue'
import UserSettingsModal from '../components/layout/modals/UserSettingsModal.vue'
import InviteModal from '../components/layout/modals/InviteModal.vue'
import ServerListSidebar from '../components/layout/ServerListSidebar.vue'
import ChannelListSidebar from '../components/layout/ChannelListSidebar.vue'
import MemberListSidebar from '../components/layout/MemberListSidebar.vue'

type ServerSettingsNavGroup = {
  id: string
  label: string
  expanded: boolean
  items: Array<{ id: string; label: string }>
}

type SettingsSection = 'general' | 'audio' | 'connections' | 'server'

const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()
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
const showSettingsPage = ref(false)
const activeSettingsSection = ref<SettingsSection>('general')
const autoConnectLastServer = ref<boolean>(JSON.parse(localStorage.getItem('settings:autoConnectLastServer') ?? 'true'))

const serverSettingsForm = ref({
  title: '',
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

const shouldShowMemberList = computed(() => chatStore.activeMainPanel.type !== 'voice')

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
  return { name: 'RougeCord Server' }
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

const toggleServerSettingsGroup = (groupId: string) => {
  serverSettingsNavGroups.value = serverSettingsNavGroups.value.map((group) =>
    group.id === groupId ? { ...group, expanded: !group.expanded } : group
  )
}

const selectServerSettingsSection = (sectionId: string) => {
  activeServerSettingsSection.value = sectionId
}

const saveServerSettings = () => {
  if (!chatStore.server) return

  chatStore.updateServerSettings(
    chatStore.server.id,
    serverSettingsForm.value.title,
    serverSettingsForm.value.rulesChannelId || null,
    serverSettingsForm.value.welcomeChannelId || null
  )
  showServerSettingsModal.value = false
}

const openSettings = (section: SettingsSection = 'general') => {
  activeSettingsSection.value = section
  showSettingsPage.value = true
  void webrtcStore.refreshAudioDevices()
}

const handleGlobalKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && showSettingsPage.value) {
    showSettingsPage.value = false
  }
}

watch(autoConnectLastServer, (value) => {
  localStorage.setItem('settings:autoConnectLastServer', JSON.stringify(value))
})

watch(showServerSettingsModal, (newVal) => {
  if (!newVal || !chatStore.server) return

  activeServerSettingsSection.value = 'general-settings'
  serverSettingsNavGroups.value = serverSettingsNavGroups.value.map((group) => ({ ...group, expanded: true }))
  serverSettingsForm.value.title = chatStore.server.title || chatStore.server.name || ''
  serverSettingsForm.value.rulesChannelId = chatStore.server.rulesChannelId || ''
  serverSettingsForm.value.welcomeChannelId = chatStore.server.welcomeChannelId || ''
})

watch(
  () => chatStore.moderationNotice,
  (notice) => {
    if (!notice) return
    router.replace({ name: 'home' })
  }
)

onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeyDown)
  chatStore.addMessageListener(handleChatStoreMessage)
  chatStore.clearError()
  void webrtcStore.initAudioSystem()

  const lastUsedServer = localStorage.getItem('lastUsedServer')
  if (lastUsedServer && autoConnectLastServer.value) {
    chatStore.connect(lastUsedServer, true)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeyDown)
  chatStore.removeMessageListener(handleChatStoreMessage)
})
</script>

<template>
  <div class="flex h-screen w-full overflow-hidden bg-zinc-950 text-zinc-300 font-sans">
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

    <InviteModal
      v-model:visible="showInviteModal"
      :server-name="activeServer.name"
    />

    <UserSettingsModal
      v-model:visible="showSettingsPage"
      v-model:activeSection="activeSettingsSection"
      v-model:autoConnectLastServer="autoConnectLastServer"
    />

    <ServerListSidebar @open-create-server="showCreateServerModal = true" />

    <div v-if="chatStore.moderationNotice" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div class="bg-zinc-950 border border-white/10 p-6 rounded-xl shadow-2xl w-[400px] max-w-[95vw]">
        <h2 class="text-xl font-bold text-white mb-2">{{ chatStore.moderationNotice.title }}</h2>
        <p class="text-sm text-zinc-400 mb-6">{{ chatStore.moderationNotice.message }}</p>
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
      @open-admin="openSettings(isAdmin ? 'server' : 'general')"
      @open-create-channel="openCreateChannelModal"
    />

    <main class="flex-1 flex min-w-0 bg-zinc-900 border-l border-white/5">
      <div class="flex-1 flex flex-col min-w-0">
        <RouterView />
      </div>

      <MemberListSidebar v-if="shouldShowMemberList" />
    </main>
  </div>
</template>
