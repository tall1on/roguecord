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

const s3ConnectionTestState = ref<'idle' | 'testing' | 'success' | 'error'>('idle')
const s3ConnectionTestMessage = ref<string | null>(null)
const s3LastSuccessfulFingerprint = ref<string | null>(null)
const serverSettingsSaveMessage = ref<string | null>(null)
const serverSettingsSaveError = ref<string | null>(null)
const serverIconDataUrl = ref<string | null>(null)
const removeServerIcon = ref(false)
const serverIconPreviewUrl = ref<string | null>(null)
const serverIconError = ref<string | null>(null)

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

const getCurrentStorageFingerprint = () => {
  const storage = serverSettingsForm.value.storage
  return JSON.stringify({
    enabled: storage.enabled,
    endpoint: storage.endpoint.trim(),
    accessKey: storage.accessKey.trim(),
    secretKey: storage.secretKey.trim(),
    prefix: storage.prefix.trim()
  })
}

const hasStorageSettingsChanges = computed(() => {
  const currentStorage = chatStore.serverStorageSettings
  const formStorage = serverSettingsForm.value.storage

  const currentFingerprint = JSON.stringify({
    enabled: currentStorage.storageType === 's3',
    endpoint: (currentStorage.s3.endpoint || '').trim(),
    accessKey: (currentStorage.s3.accessKey || '').trim(),
    secretKey: (currentStorage.s3.secretKey || '').trim(),
    prefix: (currentStorage.s3.prefix || '').trim()
  })

  const nextFingerprint = JSON.stringify({
    enabled: formStorage.enabled,
    endpoint: formStorage.endpoint.trim(),
    accessKey: formStorage.accessKey.trim(),
    secretKey: formStorage.secretKey.trim(),
    prefix: formStorage.prefix.trim()
  })

  return currentFingerprint !== nextFingerprint
})

const hasGeneralSettingsChanges = computed(() => {
  const server = chatStore.server
  if (!server) {
    return false
  }

  const currentTitle = (server.title || server.name || '').trim()
  const nextTitle = serverSettingsForm.value.title.trim()
  const currentRulesChannelId = server.rulesChannelId || ''
  const nextRulesChannelId = serverSettingsForm.value.rulesChannelId || ''
  const currentWelcomeChannelId = server.welcomeChannelId || ''
  const nextWelcomeChannelId = serverSettingsForm.value.welcomeChannelId || ''

  return (
    currentTitle !== nextTitle ||
    currentRulesChannelId !== nextRulesChannelId ||
    currentWelcomeChannelId !== nextWelcomeChannelId
  )
})

const hasServerSettingsChanges = computed(() =>
  hasGeneralSettingsChanges.value ||
  hasStorageSettingsChanges.value ||
  Boolean(serverIconDataUrl.value) ||
  removeServerIcon.value
)

const canSaveServerSettings = computed(() => {
  if (!hasStorageSettingsChanges.value) {
    return true
  }

  if (!serverSettingsForm.value.storage.enabled) {
    return true
  }

  return s3ConnectionTestState.value === 'success' && s3LastSuccessfulFingerprint.value === getCurrentStorageFingerprint()
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

const handleTestStorageConnection = async () => {
  serverSettingsSaveError.value = null
  serverSettingsSaveMessage.value = null
  s3ConnectionTestState.value = 'testing'
  s3ConnectionTestMessage.value = 'Testing S3 connection...'

  const result = await chatStore.testServerStorageSettings({
    endpoint: serverSettingsForm.value.storage.endpoint,
    accessKey: serverSettingsForm.value.storage.accessKey,
    secretKey: serverSettingsForm.value.storage.secretKey,
    prefix: serverSettingsForm.value.storage.prefix
  })

  if (result.ok) {
    s3ConnectionTestState.value = 'success'
    s3ConnectionTestMessage.value = result.message
    s3LastSuccessfulFingerprint.value = getCurrentStorageFingerprint()
    return
  }

  s3ConnectionTestState.value = 'error'
  s3ConnectionTestMessage.value = result.message
  s3LastSuccessfulFingerprint.value = null
}

const saveServerSettings = () => {
  if (!chatStore.server) {
    return
  }

  serverSettingsSaveError.value = null
  serverSettingsSaveMessage.value = null

  const nextStoragePayload = hasStorageSettingsChanges.value
    ? {
        enabled: serverSettingsForm.value.storage.enabled,
        endpoint: serverSettingsForm.value.storage.endpoint,
        region: serverSettingsForm.value.storage.region,
        bucket: serverSettingsForm.value.storage.bucket,
        accessKey: serverSettingsForm.value.storage.accessKey,
        secretKey: serverSettingsForm.value.storage.secretKey,
        prefix: serverSettingsForm.value.storage.prefix
      }
    : undefined

  if (nextStoragePayload && !canSaveServerSettings.value) {
    serverSettingsSaveError.value = 'Run a successful S3 connection test before saving.'
    return
  }

  chatStore.updateServerSettings(
    chatStore.server.id,
    serverSettingsForm.value.title,
    serverSettingsForm.value.rulesChannelId || null,
    serverSettingsForm.value.welcomeChannelId || null,
    nextStoragePayload,
    {
      iconDataUrl: serverIconDataUrl.value,
      removeIcon: removeServerIcon.value
    }
  )
  serverSettingsSaveMessage.value = 'Saving settings...'
}

const handleServerIconSelected = (file: File) => {
  serverIconError.value = null

  if (!file.type.startsWith('image/')) {
    serverIconError.value = 'Please select an image file (PNG, JPG, WEBP, etc.).'
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : ''
    if (!result.startsWith('data:image/')) {
      serverIconError.value = 'Failed to read image. Please try another file.'
      return
    }

    serverIconDataUrl.value = result
    serverIconPreviewUrl.value = result
    removeServerIcon.value = false
  }
  reader.onerror = () => {
    serverIconError.value = 'Failed to read image. Please try again.'
  }
  reader.readAsDataURL(file)
}

const handleRemoveServerIcon = () => {
  serverIconError.value = null
  serverIconDataUrl.value = null
  serverIconPreviewUrl.value = null
  removeServerIcon.value = true
}

const handleChatStoreMessage = (message: any) => {
  if (showCreateChannelModal.value) {
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

  if (!showServerSettingsModal.value) {
    return
  }

  if (message.type === 'server_settings_updated' || message.type === 'SERVER_UPDATED') {
    serverSettingsSaveMessage.value = 'Settings saved.'
    serverSettingsSaveError.value = null
    return
  }

  if (message.type === 'error') {
    serverSettingsSaveError.value = message.payload?.message || 'Failed to save settings'
    serverSettingsSaveMessage.value = null
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
    serverIconDataUrl.value = null
    removeServerIcon.value = false
    serverIconError.value = null
    serverIconPreviewUrl.value = chatStore.resolveServerIconUrl(chatStore.server.iconPath || null)
    s3ConnectionTestState.value = 'idle'
    s3ConnectionTestMessage.value = null
    s3LastSuccessfulFingerprint.value = null
    serverSettingsSaveMessage.value = null
    serverSettingsSaveError.value = null
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
  () => [
    showServerSettingsModal.value,
    serverSettingsForm.value.storage.enabled,
    serverSettingsForm.value.storage.endpoint,
    serverSettingsForm.value.storage.accessKey,
    serverSettingsForm.value.storage.secretKey,
    serverSettingsForm.value.storage.prefix
  ],
  () => {
    if (!showServerSettingsModal.value || s3ConnectionTestState.value !== 'success') {
      return
    }

    if (s3LastSuccessfulFingerprint.value !== getCurrentStorageFingerprint()) {
      s3ConnectionTestState.value = 'idle'
      s3ConnectionTestMessage.value = 'S3 inputs changed. Test connection again before saving.'
    }
  }
)

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
      :save-disabled="!canSaveServerSettings"
      :has-unsaved-changes="hasServerSettingsChanges"
      :s3-test-state="s3ConnectionTestState"
      :s3-test-message="s3ConnectionTestMessage"
      :save-message="serverSettingsSaveMessage"
      :save-error="serverSettingsSaveError"
      :icon-preview-url="serverIconPreviewUrl"
      :icon-error="serverIconError"
      :can-remove-icon="Boolean(serverIconPreviewUrl || chatStore.server?.iconPath)"
      @toggle-group="toggleServerSettingsGroup"
      @select-section="selectServerSettingsSection"
      @test-storage="handleTestStorageConnection"
      @select-icon="handleServerIconSelected"
      @remove-icon="handleRemoveServerIcon"
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
