<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { RouterView } from 'vue-router'
import { useRouter } from 'vue-router'
import { Minus, Square, X, AlertCircle } from 'lucide-vue-next'
import { useChatStore, type ServerPermission } from '../stores/chat'
import { useWebRtcStore } from '../stores/webrtc'
import LoginModal from '../components/layout/modals/LoginModal.vue'
import CreateServerModal from '../components/layout/modals/CreateServerModal.vue'
import CreateChannelModal from '../components/layout/modals/CreateChannelModal.vue'
import UserSettingsModal from '../components/layout/modals/UserSettingsModal.vue'
import InviteModal from '../components/layout/modals/InviteModal.vue'
import ServerListSidebar from '../components/layout/ServerListSidebar.vue'
import ChannelListSidebar from '../components/layout/ChannelListSidebar.vue'
import MemberListSidebar from '../components/layout/MemberListSidebar.vue'
import { isTauri } from '../utils/isTauri'
import { isCachyOS } from '../utils/isCachyOS'

const ServerSettingsModal = defineAsyncComponent(() => import('../components/layout/modals/ServerSettingsModal.vue'))

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
const isTauriApp = isTauri()
const cachyOSBuild = isCachyOS()
const tauriWindow = shallowRef<Awaited<ReturnType<typeof import('@tauri-apps/api/window')['getCurrentWindow']>> | null>(null)
let unlistenWindowResized: null | (() => void) = null

const usernameInput = ref('')
const showCreateServerModal = ref(false)
const newServerAddress = ref('')
const isMaximized = ref(false)

const showCreateChannelModal = ref(false)
const newChannelName = ref('')
const newChannelType = ref<'text' | 'voice' | 'rss' | 'folder'>('text')
const newChannelFeedUrl = ref('')
const selectedCategoryId = ref<string | null>(null)
const createChannelError = ref<string | null>(null)
const creatingCategory = ref(false)

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
const serverSettingsStorageSavePending = ref(false)
const serverSettingsStorageMigrationLock = ref(false)
const serverIconDataUrl = ref<string | null>(null)
const removeServerIcon = ref(false)
const serverIconPreviewUrl = ref<string | null>(null)
const serverIconError = ref<string | null>(null)

const serverSettingsForm = ref({
  title: '',
  rulesChannelId: '',
  welcomeChannelId: '',
  roles: [] as Array<{
    id: string
    key: string
    name: string
    color: string
    permissions: ServerPermission[]
    isDefault: boolean
    isDeletable: boolean
    position: number
  }>,
  storage: {
    storageType: 'data_dir' as 'data_dir' | 's3',
    provider: 'generic_s3' as 'generic_s3' | 'cloudflare_r2',
    providerUrl: '',
    endpoint: '',
    region: '',
    bucket: '',
    accessKey: '',
    secretKey: '',
    prefix: '',
    hasAccessKey: false,
    hasSecretKey: false,
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
      { id: 'role-settings', label: 'Roles' },
      { id: 'storage-settings', label: 'Storage / S3' }
    ]
  }
])

const isServerSettingsSectionAllowed = (sectionId: string) => {
  if (sectionId === 'general-settings') return canManageServerSettings.value
  if (sectionId === 'role-settings') return canManageRoles.value
  if (sectionId === 'storage-settings') return canManageStorageSettings.value
  return false
}

const visibleServerSettingsNavGroups = computed(() => serverSettingsNavGroups.value
  .map((group) => ({
    ...group,
    items: group.items.filter((item) => isServerSettingsSectionAllowed(item.id))
  }))
  .filter((group) => group.items.length > 0)
)

const getDefaultServerSettingsSection = () => {
  if (canManageServerSettings.value) return 'general-settings'
  if (canManageRoles.value) return 'role-settings'
  if (canManageStorageSettings.value) return 'storage-settings'
  return 'general-settings'
}

const isAdmin = computed(() => chatStore.currentUserIsAdmin)
const canManageServerSettings = computed(() => chatStore.currentUserHasPermission('manage_server_settings'))
const canManageStorageSettings = computed(() => chatStore.currentUserHasPermission('manage_storage_settings'))
const canManageChannels = computed(() => chatStore.currentUserHasPermission('manage_channels'))
const canManageRoles = computed(() => chatStore.currentUserHasPermission('manage_roles'))
const canOpenServerSettings = computed(() => canManageServerSettings.value || canManageStorageSettings.value || canManageRoles.value)
const shouldShowMemberList = computed(() => chatStore.activeMainPanel.type !== 'voice')
const createChannelModalTitle = computed(() => creatingCategory.value ? 'Create Category' : 'Create Channel')
const createChannelNameLabel = computed(() => creatingCategory.value ? 'Category Name' : 'Channel Name')
const createChannelNamePlaceholder = computed(() => creatingCategory.value ? 'new-category' : 'new-channel')
const createChannelSubmitLabel = computed(() => creatingCategory.value ? 'Create Category' : 'Create Channel')

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
  return { name: 'RougeCord' }
})

const populateServerSettingsStorageForm = () => {
  const storageSettings = chatStore.serverStorageSettings
  serverSettingsForm.value.storage.storageType = storageSettings.storageType
  serverSettingsForm.value.storage.provider = storageSettings.s3.provider
  serverSettingsForm.value.storage.providerUrl = storageSettings.s3.providerUrl
  serverSettingsForm.value.storage.endpoint = storageSettings.s3.endpoint
  serverSettingsForm.value.storage.region = storageSettings.s3.region
  serverSettingsForm.value.storage.bucket = storageSettings.s3.bucket
  serverSettingsForm.value.storage.prefix = storageSettings.s3.prefix
  serverSettingsForm.value.storage.hasAccessKey = storageSettings.s3.hasAccessKey
  serverSettingsForm.value.storage.hasSecretKey = storageSettings.s3.hasSecretKey
  serverSettingsForm.value.storage.accessKey = ''
  serverSettingsForm.value.storage.secretKey = ''
  serverSettingsForm.value.storage.status = storageSettings.storageType
  serverSettingsForm.value.storage.lastError = storageSettings.storageLastError
}

const populateServerRoleSettingsForm = () => {
  serverSettingsForm.value.roles = chatStore.serverRoles.map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
    color: role.color || '#9ca3af',
    permissions: [...role.permissions],
    isDefault: role.isDefault,
    isDeletable: role.isDeletable,
    position: role.position
  }))
}

const getCurrentStorageFingerprint = () => {
  const storage = serverSettingsForm.value.storage
  return JSON.stringify({
    storageType: storage.storageType,
    provider: storage.provider,
    providerUrl: storage.providerUrl.trim(),
    endpoint: storage.endpoint.trim(),
    region: storage.region.trim(),
    bucket: storage.bucket.trim(),
    accessKeyChanged: storage.accessKey.trim().length > 0,
    secretKeyChanged: storage.secretKey.trim().length > 0,
    prefix: storage.prefix.trim()
  })
}

const hasStorageSettingsChanges = computed(() => {
  const currentStorage = chatStore.serverStorageSettings
  const formStorage = serverSettingsForm.value.storage

  const currentFingerprint = JSON.stringify({
    storageType: currentStorage.storageType,
    provider: currentStorage.s3.provider,
    providerUrl: (currentStorage.s3.providerUrl || '').trim(),
    endpoint: (currentStorage.s3.endpoint || '').trim(),
    region: (currentStorage.s3.region || '').trim(),
    bucket: (currentStorage.s3.bucket || '').trim(),
    hasAccessKey: currentStorage.s3.hasAccessKey,
    hasSecretKey: currentStorage.s3.hasSecretKey,
    prefix: (currentStorage.s3.prefix || '').trim()
  })

  const nextFingerprint = JSON.stringify({
    storageType: formStorage.storageType,
    provider: formStorage.provider,
    providerUrl: formStorage.providerUrl.trim(),
    endpoint: formStorage.endpoint.trim(),
    region: formStorage.region.trim(),
    bucket: formStorage.bucket.trim(),
    hasAccessKey: formStorage.accessKey.trim().length > 0 ? true : currentStorage.s3.hasAccessKey,
    hasSecretKey: formStorage.secretKey.trim().length > 0 ? true : currentStorage.s3.hasSecretKey,
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

const hasRoleSettingsChanges = computed(() => {
  const currentRoles = chatStore.serverRoles
  const nextRoles = serverSettingsForm.value.roles

  if (currentRoles.length !== nextRoles.length) {
    return true
  }

  return currentRoles.some((role, index) => {
    const nextRole = nextRoles[index]
    if (!nextRole || nextRole.id !== role.id) {
      return true
    }

    const nextName = nextRole.name.trim()
    const nextColor = (nextRole.color || '').trim().toLowerCase()
    const currentColor = (role.color || '').trim().toLowerCase()
    const currentPermissions = role.permissions.join('\u0000')
    const nextPermissions = nextRole.permissions.join('\u0000')

    return nextName !== role.name || nextColor !== currentColor || nextPermissions !== currentPermissions || nextRole.position !== role.position
  })
})

const hasServerSettingsChanges = computed(() =>
  hasGeneralSettingsChanges.value ||
  hasRoleSettingsChanges.value ||
  hasStorageSettingsChanges.value ||
  Boolean(serverIconDataUrl.value) ||
  removeServerIcon.value
)

const isStorageModeSwitchPending = computed(() => {
  const currentStorageType = chatStore.serverStorageSettings.storageType
  const nextStorageType = serverSettingsForm.value.storage.storageType
  return hasStorageSettingsChanges.value && currentStorageType !== nextStorageType
})

const isServerSettingsStorageLocked = computed(() =>
  serverSettingsStorageSavePending.value ||
  serverSettingsStorageMigrationLock.value ||
  chatStore.serverStorageSettings.migration.status === 'running'
)

const serverSettingsSaveDisabled = computed(() => !canSaveServerSettings.value || isServerSettingsStorageLocked.value)

const serverSettingsSaveButtonLabel = computed(() => {
  if (serverSettingsStorageSavePending.value) {
    return 'Saving storage changes...'
  }

  if (chatStore.serverStorageSettings.migration.status === 'running') {
    return 'Storage migration running...'
  }

  if (serverSettingsStorageMigrationLock.value) {
    return 'Waiting for migration status...'
  }

  return 'Save Changes'
})

const canSaveServerSettings = computed(() => {
  if (!hasStorageSettingsChanges.value) {
    return true
  }

  if (serverSettingsForm.value.storage.storageType !== 's3') {
    return true
  }

  return s3ConnectionTestState.value === 'success' && s3LastSuccessfulFingerprint.value === getCurrentStorageFingerprint()
})

watch(
  () => serverSettingsForm.value.storage.provider,
  (provider) => {
    if (provider === 'cloudflare_r2') {
      serverSettingsForm.value.storage.endpoint = ''
      serverSettingsForm.value.storage.region = ''
      serverSettingsForm.value.storage.bucket = ''
      return
    }

    serverSettingsForm.value.storage.providerUrl = ''
  }
)

const resetServerSettingsStorageLock = () => {
  serverSettingsStorageSavePending.value = false
  serverSettingsStorageMigrationLock.value = false
}

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

const openCreateChannelModal = (payload: { categoryId: string | null; type?: 'text' | 'voice' | 'rss' | 'folder'; createCategory?: boolean }) => {
  if (!canManageChannels.value) return

  createChannelError.value = null
  chatStore.clearError()
  creatingCategory.value = Boolean(payload.createCategory)
  selectedCategoryId.value = payload.categoryId
  newChannelName.value = ''
  newChannelFeedUrl.value = ''
  if (payload.type) {
    newChannelType.value = payload.type
  } else if (!creatingCategory.value) {
    newChannelType.value = 'text'
  }
  showCreateChannelModal.value = true
}

const handleCreateChannel = () => {
  if (!canManageChannels.value) return

  const trimmedName = newChannelName.value.trim()
  const trimmedFeedUrl = newChannelFeedUrl.value.trim()
  if (!trimmedName) {
    createChannelError.value = creatingCategory.value ? 'Category name is required' : 'Channel name is required'
    return
  }

  if (creatingCategory.value) {
    createChannelError.value = null
    chatStore.clearError()
    chatStore.createCategory(trimmedName)
    showCreateChannelModal.value = false
    return
  }

  if (newChannelType.value === 'rss' && !trimmedFeedUrl) {
    createChannelError.value = 'RSS feed URL is required'
    return
  }

  createChannelError.value = null
  chatStore.clearError()
  chatStore.createChannel(selectedCategoryId.value, trimmedName, newChannelType.value, trimmedFeedUrl)
  showCreateChannelModal.value = false
}

const handleTestStorageConnection = async () => {
  if (!canManageStorageSettings.value) return

  serverSettingsSaveError.value = null
  serverSettingsSaveMessage.value = null
  s3ConnectionTestState.value = 'testing'
  s3ConnectionTestMessage.value = 'Testing storage connection...'

  const result = await chatStore.testServerStorageSettings({
    storageType: serverSettingsForm.value.storage.storageType,
    s3: serverSettingsForm.value.storage.storageType === 's3'
      ? {
          provider: serverSettingsForm.value.storage.provider,
          providerUrl: serverSettingsForm.value.storage.providerUrl,
          endpoint: serverSettingsForm.value.storage.endpoint,
          region: serverSettingsForm.value.storage.region,
          bucket: serverSettingsForm.value.storage.bucket,
          accessKey: serverSettingsForm.value.storage.accessKey,
          secretKey: serverSettingsForm.value.storage.secretKey,
          prefix: serverSettingsForm.value.storage.prefix
        }
      : undefined
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

const getRoleReorderUpdates = () => {
  return serverSettingsForm.value.roles
    .filter((role) => !role.isDefault && role.key !== 'admin' && role.key !== 'all_users')
    .filter((role) => {
      const currentRole = chatStore.serverRoles.find((entry) => entry.id === role.id)
      return currentRole && currentRole.position !== role.position
    })
    .map((role) => ({
      id: role.id,
      position: role.position
    }))
}

const handleCreateServerRole = (payload: { name: string; color: string | null; permissions: ServerPermission[] }) => {
  if (!chatStore.server?.id || !canManageRoles.value) return

  serverSettingsSaveError.value = null
  serverSettingsSaveMessage.value = 'Creating role...'
  chatStore.createServerRole(chatStore.server.id, payload.name, payload.color, payload.permissions)
}

const handleDeleteServerRole = (roleId: string) => {
  if (!chatStore.server?.id || !canManageRoles.value) return

  serverSettingsSaveError.value = null
  serverSettingsSaveMessage.value = 'Deleting role...'
  chatStore.deleteServerRole(chatStore.server.id, roleId)
}

const handleMoveServerRole = (payload: { roleId: string; direction: 'up' | 'down' }) => {
  if (!canManageRoles.value) return

  const rolesByPosition = [...serverSettingsForm.value.roles]
    .filter((role) => !role.isDefault && role.key !== 'admin' && role.key !== 'all_users')
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name))
  const currentIndex = rolesByPosition.findIndex((role) => role.id === payload.roleId)
  const targetIndex = payload.direction === 'up' ? currentIndex + 1 : currentIndex - 1
  const movingRole = rolesByPosition[currentIndex]
  const targetRole = rolesByPosition[targetIndex]

  if (!movingRole || !targetRole) return

  const movingServerRole = chatStore.serverRoles.find((role) => role.id === movingRole.id)
  const targetServerRole = chatStore.serverRoles.find((role) => role.id === targetRole.id)
  if (!chatStore.canManageServerRole(movingServerRole) || !chatStore.canManageServerRole(targetServerRole)) {
    return
  }

  const movingPosition = movingRole.position
  movingRole.position = targetRole.position
  targetRole.position = movingPosition
  serverSettingsForm.value.roles = [...serverSettingsForm.value.roles].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name))
}

const saveServerSettings = async () => {
  if (!chatStore.server) {
    return
  }

  if (isServerSettingsStorageLocked.value) {
    return
  }

  serverSettingsSaveError.value = null
  serverSettingsSaveMessage.value = null

  const wantsGeneralSave = hasGeneralSettingsChanges.value || Boolean(serverIconDataUrl.value) || removeServerIcon.value
  const wantsStorageSave = hasStorageSettingsChanges.value
  const wantsRoleSave = hasRoleSettingsChanges.value

  if (wantsGeneralSave && !canManageServerSettings.value) {
    serverSettingsSaveError.value = 'You do not have permission to change general server settings.'
    return
  }

  if (wantsStorageSave && !canManageStorageSettings.value) {
    serverSettingsSaveError.value = 'You do not have permission to change storage settings.'
    return
  }

  if (wantsRoleSave && !canManageRoles.value) {
    serverSettingsSaveError.value = 'You do not have permission to manage roles.'
    return
  }

  const nextStoragePayload = wantsStorageSave
      ? {
        storageType: serverSettingsForm.value.storage.storageType,
        s3: serverSettingsForm.value.storage.storageType === 's3'
          ? {
              provider: serverSettingsForm.value.storage.provider,
              providerUrl: serverSettingsForm.value.storage.providerUrl,
              endpoint: serverSettingsForm.value.storage.endpoint,
              region: serverSettingsForm.value.storage.region,
              bucket: serverSettingsForm.value.storage.bucket,
              accessKey: serverSettingsForm.value.storage.accessKey,
              secretKey: serverSettingsForm.value.storage.secretKey,
              prefix: serverSettingsForm.value.storage.prefix
            }
          : undefined
      }
    : undefined

  if (nextStoragePayload && !canSaveServerSettings.value) {
    serverSettingsSaveError.value = 'Run a successful storage connection test before saving.'
    return
  }

  if (isStorageModeSwitchPending.value) {
    serverSettingsStorageSavePending.value = true
    serverSettingsStorageMigrationLock.value = true
  }

  try {
    const roleReorderUpdates = canManageRoles.value ? getRoleReorderUpdates() : []
    if (roleReorderUpdates.length > 0) {
      chatStore.reorderServerRoles(chatStore.server.id, roleReorderUpdates)
    }

    const updatedRoleCount = canManageRoles.value
      ? await chatStore.updateServerRoles(
          serverSettingsForm.value.roles.map((role) => ({
            id: role.id,
            name: role.name,
            color: role.color || null,
            permissions: role.permissions
          }))
        )
      : 0

    if (wantsGeneralSave || wantsStorageSave) {
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
    }

    serverSettingsForm.value.storage.accessKey = ''
    serverSettingsForm.value.storage.secretKey = ''

    if (updatedRoleCount > 0 || roleReorderUpdates.length > 0) {
      serverSettingsSaveMessage.value = wantsGeneralSave || wantsStorageSave ? 'Saving settings and roles...' : 'Saving roles...'
    } else if (wantsGeneralSave || wantsStorageSave) {
      serverSettingsSaveMessage.value = 'Saving settings...'
    } else {
      serverSettingsSaveMessage.value = 'No changes to save.'
    }
  } catch (error) {
    serverSettingsSaveError.value = error instanceof Error ? error.message : 'Failed to prepare role changes'
    serverSettingsSaveMessage.value = null
    resetServerSettingsStorageLock()
  }
}

const handleServerIconSelected = (file: File) => {
  if (!canManageServerSettings.value) return

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
  if (!canManageServerSettings.value) return

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

  if (message.type === 'server_role_created' || message.type === 'server_role_updated' || message.type === 'server_role_deleted' || message.type === 'server_roles_reordered') {
    serverSettingsSaveError.value = null
    if (!serverSettingsSaveMessage.value || serverSettingsSaveMessage.value === 'Creating role...' || serverSettingsSaveMessage.value === 'Deleting role...') {
      serverSettingsSaveMessage.value = 'Roles saved.'
    }
    return
  }

  if (message.type === 'server_settings_updated' || message.type === 'SERVER_UPDATED') {
    serverSettingsSaveMessage.value = 'Settings saved.'
    serverSettingsSaveError.value = null

    if (serverSettingsStorageSavePending.value) {
      serverSettingsStorageSavePending.value = false
    }

    return
  }

  if (message.type === 'error') {
    serverSettingsSaveError.value = message.payload?.message || 'Failed to save settings'
    serverSettingsSaveMessage.value = null

    if (serverSettingsStorageSavePending.value) {
      resetServerSettingsStorageLock()
    }
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
  if (!isServerSettingsSectionAllowed(sectionId)) return
  activeServerSettingsSection.value = sectionId
}

const openSettings = (section: SettingsSection = 'general') => {
  activeSettingsSection.value = section
  showSettingsPage.value = true
  void webrtcStore.refreshAudioDevices()
}

const syncWindowState = async () => {
  if (!tauriWindow.value) {
    return
  }

  isMaximized.value = await tauriWindow.value.isMaximized()
}

const minimizeWindow = async () => {
  if (!tauriWindow.value) {
    return
  }

  await tauriWindow.value.minimize()
}

const toggleMaximizeWindow = async () => {
  if (!tauriWindow.value) {
    return
  }

  await tauriWindow.value.toggleMaximize()
  await syncWindowState()
}

const closeWindow = async () => {
  if (!tauriWindow.value) {
    return
  }

  await tauriWindow.value.close()
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
    activeServerSettingsSection.value = getDefaultServerSettingsSection()
    if (canManageStorageSettings.value) {
      chatStore.requestServerStorageSettings()
    }
    chatStore.requestServerRoles()
    serverSettingsNavGroups.value = serverSettingsNavGroups.value.map((group) => ({
      ...group,
      expanded: true
    }))
    serverSettingsForm.value.title = chatStore.server.title || chatStore.server.name || ''
    serverSettingsForm.value.rulesChannelId = chatStore.server.rulesChannelId || ''
    serverSettingsForm.value.welcomeChannelId = chatStore.server.welcomeChannelId || ''
    populateServerRoleSettingsForm()
    populateServerSettingsStorageForm()
    serverIconDataUrl.value = null
    removeServerIcon.value = false
    serverIconError.value = null
    serverIconPreviewUrl.value = chatStore.resolveServerIconUrl(chatStore.server.iconPath || null)
    s3ConnectionTestState.value = 'idle'
    s3ConnectionTestMessage.value = null
    s3LastSuccessfulFingerprint.value = null
    serverSettingsSaveMessage.value = null
    serverSettingsSaveError.value = null
    resetServerSettingsStorageLock()
  }
})

watch(
  () => chatStore.serverRoles,
  (nextRoles, previousRoles) => {
    if (!showServerSettingsModal.value) {
      return
    }

    const previousSignature = JSON.stringify(
      (previousRoles || []).map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color,
        permissions: role.permissions,
        position: role.position,
        updatedAt: role.updatedAt
      }))
    )
    const nextSignature = JSON.stringify(
      (nextRoles || []).map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color,
        permissions: role.permissions,
        position: role.position,
        updatedAt: role.updatedAt
      }))
    )

    if (previousSignature === nextSignature) {
      return
    }

    populateServerRoleSettingsForm()
  },
  { deep: false }
)

watch(
  () => chatStore.serverStorageSettings,
  (storageSettings) => {
    if (!showServerSettingsModal.value) {
      return
    }
    populateServerSettingsStorageForm()

    if (storageSettings.migration.status === 'running') {
      serverSettingsStorageSavePending.value = false
      serverSettingsStorageMigrationLock.value = true
      return
    }

    if (serverSettingsStorageMigrationLock.value) {
      serverSettingsStorageMigrationLock.value = false
    }
  },
  { deep: true }
)

watch(
  () => [
    showServerSettingsModal.value,
    serverSettingsForm.value.storage.storageType,
    serverSettingsForm.value.storage.provider,
    serverSettingsForm.value.storage.providerUrl,
    serverSettingsForm.value.storage.endpoint,
    serverSettingsForm.value.storage.region,
    serverSettingsForm.value.storage.bucket,
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
      s3ConnectionTestMessage.value = 'Storage inputs changed. Test connection again before saving.'
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

  if (!isTauriApp) {
    return
  }

  void (async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    tauriWindow.value = getCurrentWindow()

    await syncWindowState()

    unlistenWindowResized = await tauriWindow.value.onResized(async () => {
      await syncWindowState()
    })
  })()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeyDown)
  chatStore.removeMessageListener(handleChatStoreMessage)
  unlistenWindowResized?.()
  unlistenWindowResized = null
})
</script>

<template>
  <div class="flex h-screen w-full flex-col overflow-hidden bg-zinc-950 text-zinc-300 font-sans">
    <div
      v-if="isTauriApp && !cachyOSBuild"
      class="tauri-titlebar flex h-10 shrink-0 items-center border-b border-zinc-800 bg-zinc-900/95"
    >
      <div class="tauri-titlebar-drag-region flex min-w-0 flex-1 items-center px-4" data-tauri-drag-region>
        <div class="truncate text-sm font-medium text-zinc-400">
          {{ activeServer.name }}
        </div>
      </div>

      <div class="tauri-titlebar-controls flex h-full items-stretch">
        <button
          type="button"
          class="tauri-titlebar-button"
          aria-label="Minimize window"
          @click="minimizeWindow"
        >
          <Minus class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="tauri-titlebar-button"
          :aria-label="isMaximized ? 'Restore window' : 'Maximize window'"
          @click="toggleMaximizeWindow"
        >
          <Square class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          class="tauri-titlebar-button tauri-titlebar-button-close"
          aria-label="Close window"
          @click="closeWindow"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>

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
      :title="createChannelModalTitle"
      :name-label="createChannelNameLabel"
      :name-placeholder="createChannelNamePlaceholder"
      :create-label="createChannelSubmitLabel"
      :show-type-selector="!creatingCategory"
      :error-message="createChannelError || chatStore.lastError"
      @create="handleCreateChannel"
    />

    <ServerSettingsModal
      v-model:visible="showServerSettingsModal"
      v-model:form="serverSettingsForm"
      :active-section="activeServerSettingsSection"
      :nav-groups="visibleServerSettingsNavGroups"
      :save-disabled="serverSettingsSaveDisabled"
      :save-label="serverSettingsSaveButtonLabel"
      :has-unsaved-changes="hasServerSettingsChanges"
      :can-manage-general-settings="canManageServerSettings"
      :can-manage-storage-settings="canManageStorageSettings"
      :can-manage-roles="canManageRoles"
      :s3-test-state="s3ConnectionTestState"
      :s3-test-message="s3ConnectionTestMessage"
      :save-message="serverSettingsSaveMessage"
      :save-error="serverSettingsSaveError"
      :storage-settings="chatStore.serverStorageSettings"
      :storage-locked="isServerSettingsStorageLocked"
      :icon-preview-url="serverIconPreviewUrl"
      :icon-error="serverIconError"
      :can-remove-icon="Boolean(serverIconPreviewUrl || chatStore.server?.iconPath)"
      @toggle-group="toggleServerSettingsGroup"
      @select-section="selectServerSettingsSection"
      @test-storage="handleTestStorageConnection"
      @select-icon="handleServerIconSelected"
      @remove-icon="handleRemoveServerIcon"
      @create-role="handleCreateServerRole"
      @delete-role="handleDeleteServerRole"
      @move-role="handleMoveServerRole"
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

    <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden relative">
      <ServerListSidebar @open-create-server="showCreateServerModal = true" />

      <div v-if="chatStore.isConnecting || chatStore.isAuthPending || chatStore.isInitialSyncPending" class="absolute inset-y-0 right-0 left-[72px] z-50 flex flex-col items-center justify-center bg-zinc-900/80 backdrop-blur-sm">
        <div class="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-4"></div>
        <p class="text-zinc-300 font-medium animate-pulse">Connecting to server...</p>
      </div>

      <div v-if="chatStore.activeConnectionId && !chatStore.isConnected && !chatStore.isConnecting && !chatStore.isAuthPending && !chatStore.isInitialSyncPending" class="absolute top-0 left-[72px] right-0 z-50 flex items-center justify-center bg-red-500/90 text-white px-4 py-2 shadow-md">
        <AlertCircle class="w-4 h-4 mr-2" />
        <p class="text-sm font-medium">
          {{ chatStore.connectionError || 'Disconnected from server. Trying to reconnect...' }}
        </p>
      </div>

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
        :can-open-server-settings="canOpenServerSettings"
        :can-manage-channels="canManageChannels"
        @open-server-settings="canOpenServerSettings ? showServerSettingsModal = true : undefined"
        @open-invite="showInviteModal = true"
        @remove-server="handleRemoveServer"
        @open-admin="openSettings(canOpenServerSettings ? 'server' : 'general')"
        @open-create-channel="openCreateChannelModal"
      />

      <main class="flex min-w-0 flex-1 bg-zinc-900 border-l border-white/5">
        <div class="flex flex-1 flex-col min-w-0">
          <RouterView />
        </div>

        <MemberListSidebar v-if="shouldShowMemberList" />
      </main>
    </div>
  </div>
</template>
