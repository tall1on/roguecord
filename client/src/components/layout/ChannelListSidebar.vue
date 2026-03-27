<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Hash, Volume2, Settings, Link, Trash2, Plus, MicOff, Headphones, PhoneOff, Mic, Rss, MonitorUp, Folder } from 'lucide-vue-next'
import { useChatStore, type Channel } from '../../stores/chat'
import { useWebRtcStore } from '../../stores/webrtc'

const props = defineProps<{
  isAdmin: boolean
}>()

type ChannelCreateType = 'text' | 'voice' | 'rss' | 'folder'

const emit = defineEmits<{
  (e: 'open-server-settings'): void
  (e: 'open-invite'): void
  (e: 'remove-server'): void
  (e: 'open-admin'): void
  (e: 'open-create-channel', payload: { categoryId: string | null; type?: ChannelCreateType; createCategory?: boolean }): void
}>()

const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()

const showVoiceStats = ref(false)
const voiceStatsContainerRef = ref<HTMLElement | null>(null)

const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuChannel = ref<Channel | null>(null)
const contextMenuCategoryId = ref<string | null>(null)
const contextMenuUncategorized = ref(false)
const draggedCategoryId = ref<string | null>(null)
const dragOverCategoryTargetId = ref<string | null>(null)
const draggedChannelId = ref<string | null>(null)
const dragOverChannelId = ref<string | null>(null)
const dragOverCategoryId = ref<string | null>(null)
const dragOverUncategorized = ref(false)

const sortChannels = (channelList: Channel[]) => {
  return [...channelList].sort((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position
    }
    return a.name.localeCompare(b.name)
  })
}

const channelsByCategory = computed(() => {
  const groups = new Map<string | null, Channel[]>()

  for (const channel of chatStore.activeServerChannels) {
    const key = channel.category_id ?? null
    const existing = groups.get(key) || []
    existing.push(channel)
    groups.set(key, existing)
  }

  for (const [key, channelList] of groups.entries()) {
    groups.set(key, sortChannels(channelList))
  }

  return groups
})

const uncategorizedChannels = computed(() => channelsByCategory.value.get(null) || [])

const getCategoryChannels = (categoryId: string) => channelsByCategory.value.get(categoryId) || []

const resetDragState = () => {
  draggedChannelId.value = null
  dragOverChannelId.value = null
  dragOverCategoryId.value = null
  dragOverUncategorized.value = false
  draggedCategoryId.value = null
  dragOverCategoryTargetId.value = null
}

const sortCategories = () => {
  return [...chatStore.activeServerCategories].sort((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position
    }
    return a.name.localeCompare(b.name)
  })
}

const handleDragStart = (channel: Channel) => {
  if (!props.isAdmin) return
  draggedChannelId.value = channel.id
  dragOverChannelId.value = channel.id
  dragOverCategoryId.value = channel.category_id ?? null
  dragOverUncategorized.value = channel.category_id == null
}

const handleDragOver = (event: DragEvent, channel: Channel) => {
  if (!props.isAdmin || !draggedChannelId.value || draggedChannelId.value === channel.id) return
  event.preventDefault()
  event.stopPropagation()
  dragOverCategoryId.value = null
  dragOverUncategorized.value = false
  dragOverChannelId.value = channel.id
}

const buildReorderPayload = (sourceChannel: Channel, targetCategoryId: string | null, targetIndex?: number) => {
  const sourceCategoryId = sourceChannel.category_id ?? null
  const sourceGroup = sortChannels(chatStore.activeServerChannels.filter((channel) => (channel.category_id ?? null) === sourceCategoryId))
  const targetGroupBase = sourceCategoryId === targetCategoryId
    ? sourceGroup
    : sortChannels(chatStore.activeServerChannels.filter((channel) => (channel.category_id ?? null) === targetCategoryId))

  const nextSourceGroup = sourceGroup.filter((channel) => channel.id !== sourceChannel.id)
  const nextTargetGroup = targetGroupBase.filter((channel) => channel.id !== sourceChannel.id)
  const insertAt = typeof targetIndex === 'number'
    ? Math.max(0, Math.min(targetIndex, nextTargetGroup.length))
    : nextTargetGroup.length

  nextTargetGroup.splice(insertAt, 0, { ...sourceChannel, category_id: targetCategoryId })

  const updates: Array<{ id: string; category_id: string | null; position: number }> = []

  nextSourceGroup.forEach((channel, index) => {
    updates.push({ id: channel.id, category_id: sourceCategoryId, position: index })
  })

  nextTargetGroup.forEach((channel, index) => {
    updates.push({ id: channel.id, category_id: targetCategoryId, position: index })
  })

  return Array.from(new Map(updates.map((update) => [update.id, update])).values())
}

const handleDrop = (targetChannel: Channel) => {
  if (!props.isAdmin || !draggedChannelId.value || draggedChannelId.value === targetChannel.id) {
    resetDragState()
    return
  }

  const sourceChannel = chatStore.activeServerChannels.find((channel) => channel.id === draggedChannelId.value)
  if (!sourceChannel) {
    resetDragState()
    return
  }

  const targetGroup = sortChannels(chatStore.activeServerChannels.filter((channel) => channel.category_id === targetChannel.category_id))
  const targetIndex = targetGroup.findIndex((channel) => channel.id === targetChannel.id)

  if (targetIndex === -1) {
    resetDragState()
    return
  }

  const updates = buildReorderPayload(sourceChannel, targetChannel.category_id ?? null, targetIndex)
  chatStore.reorderChannels(updates)
  resetDragState()
}

const handleCategoryDragOver = (event: DragEvent, categoryId: string | null) => {
  if (!props.isAdmin || !draggedChannelId.value) return
  event.preventDefault()
  event.stopPropagation()
  dragOverChannelId.value = null
  dragOverCategoryId.value = categoryId
  dragOverUncategorized.value = categoryId === null
}

const handleCategoryHeaderDrop = (event: DragEvent, categoryId: string) => {
  if (draggedChannelId.value) {
    event.preventDefault()
    event.stopPropagation()
    handleCategoryDrop(categoryId)
    return
  }

  if (!props.isAdmin || !draggedCategoryId.value || draggedCategoryId.value === categoryId) {
    resetDragState()
    return
  }

  const sortedCategories = sortCategories()
  const sourceIndex = sortedCategories.findIndex((category) => category.id === draggedCategoryId.value)
  const targetIndex = sortedCategories.findIndex((category) => category.id === categoryId)

  if (sourceIndex === -1 || targetIndex === -1) {
    resetDragState()
    return
  }

  const [movedCategory] = sortedCategories.splice(sourceIndex, 1)
  sortedCategories.splice(targetIndex, 0, movedCategory)

  chatStore.reorderCategories(sortedCategories.map((category, index) => ({
    id: category.id,
    position: index
  })))

  resetDragState()
}

const handleCategoryDrop = (categoryId: string | null) => {
  if (!props.isAdmin || !draggedChannelId.value) {
    resetDragState()
    return
  }

  const sourceChannel = chatStore.activeServerChannels.find((channel) => channel.id === draggedChannelId.value)
  if (!sourceChannel) {
    resetDragState()
    return
  }

  chatStore.reorderChannels(buildReorderPayload(sourceChannel, categoryId))
  resetDragState()
}

const handleDragEnd = () => {
  resetDragState()
}

const handleCategoryHeaderDragStart = (categoryId: string) => {
  if (!props.isAdmin) return
  draggedCategoryId.value = categoryId
  dragOverCategoryTargetId.value = categoryId
}

const handleCategoryHeaderDragOver = (event: DragEvent, categoryId: string) => {
  if (!props.isAdmin || !draggedCategoryId.value || draggedCategoryId.value === categoryId) return
  event.preventDefault()
  event.stopPropagation()
  dragOverCategoryTargetId.value = categoryId
}

const isDragTarget = (channelId: string) => dragOverChannelId.value === channelId

const channelRowClass = (channel: Channel) => {
  const baseClass = isChannelActive(channel)
    ? 'bg-zinc-800/80 text-white shadow-sm'
    : isChannelUnread(channel)
      ? 'text-white hover:bg-zinc-900/80'
      : 'hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-300'

  return [
    baseClass,
    props.isAdmin ? 'admin-draggable-channel' : '',
    draggedChannelId.value === channel.id ? 'opacity-60' : '',
    isDragTarget(channel.id) ? 'ring-1 ring-indigo-400/70 bg-zinc-900/90' : ''
  ]
}

watch(() => chatStore.activeConnectionId, () => {
  resetDragState()
})

const formattedBandwidth = computed(() => {
  const bandwidthKbps = webrtcStore.bandwidth
  if (bandwidthKbps > 1000) {
    return `${(bandwidthKbps / 1000).toFixed(2)} Mbps`
  }
  return `${bandwidthKbps} kbps`
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
  return { name: 'RougeCord Server' }
})

const userPanelName = computed(() => chatStore.currentUser?.username || chatStore.localUsername || 'Not connected')
const hasCurrentUser = computed(() => !!chatStore.currentUser)

const handleClickOutside = (event: MouseEvent) => {
  if (showVoiceStats.value && voiceStatsContainerRef.value && !voiceStatsContainerRef.value.contains(event.target as Node)) {
    showVoiceStats.value = false
  }

  if (contextMenuVisible.value) {
    const target = event.target as HTMLElement | null
    if (!target?.closest('.channel-context-menu')) {
      contextMenuVisible.value = false
      contextMenuChannel.value = null
      contextMenuCategoryId.value = null
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
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

const isChannelActive = (channel: Channel) => {
  if (channel.type === 'text' || channel.type === 'rss') {
    return chatStore.activeMainPanel.type === 'text' && chatStore.activeMainPanel.channelId === channel.id
  }

  if (channel.type === 'folder') {
    return chatStore.activeMainPanel.type === 'folder' && chatStore.activeMainPanel.channelId === channel.id
  }

  if (channel.type === 'voice') {
    return chatStore.activeMainPanel.type === 'voice' && chatStore.activeMainPanel.channelId === channel.id
  }

  return false
}

const isChannelUnread = (channel: Channel) => {
  if (channel.type !== 'text' && channel.type !== 'rss') {
    return false
  }

  return chatStore.unreadChannelIds.has(channel.id)
}

const handleChannelClick = (channel: Channel) => {
  if (channel.type === 'text' || channel.type === 'rss' || channel.type === 'folder') {
    chatStore.setActiveChannel(channel.id)
  } else if (channel.type === 'voice') {
    chatStore.setActiveVoicePanel(channel.id)
    webrtcStore.joinVoiceChannel(channel.id)
  }
}

const openChannelListContextMenu = (event: MouseEvent) => {
  if (!props.isAdmin) return

  event.preventDefault()
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuChannel.value = null
  contextMenuCategoryId.value = null
  contextMenuVisible.value = true
}

const openChannelContextMenu = (event: MouseEvent, channel: Channel) => {
  if (!props.isAdmin) return

  event.preventDefault()
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuChannel.value = channel
  contextMenuCategoryId.value = null
  contextMenuVisible.value = true
}

const openCategoryContextMenu = (event: MouseEvent, categoryId: string) => {
  if (!props.isAdmin) return

  event.preventDefault()
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuChannel.value = null
  contextMenuUncategorized.value = false
  contextMenuCategoryId.value = categoryId
  contextMenuVisible.value = true
}

const openUncategorizedContextMenu = (event: MouseEvent) => {
  if (!props.isAdmin) return

  event.preventDefault()
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuChannel.value = null
  contextMenuCategoryId.value = null
  contextMenuUncategorized.value = true
  contextMenuVisible.value = true
}

const canDeleteCategoryFromContextMenu = computed(() => {
  if (contextMenuChannel.value) {
    return false
  }

  if (contextMenuCategoryId.value) {
    return getCategoryChannels(contextMenuCategoryId.value).length === 0
  }

  if (contextMenuUncategorized.value) {
    return uncategorizedChannels.value.length === 0
  }

  return false
})

const shouldShowContextMenuDivider = computed(() => !!contextMenuChannel.value || canDeleteCategoryFromContextMenu.value)

const deleteChannelFromContextMenu = () => {
  if (!props.isAdmin || !contextMenuChannel.value) return

  const channelToDelete = contextMenuChannel.value
  if (!confirm(`Delete #${channelToDelete.name}? This cannot be undone.`)) {
    return
  }

  contextMenuVisible.value = false
  contextMenuChannel.value = null
  contextMenuCategoryId.value = null
  contextMenuUncategorized.value = false
  chatStore.deleteChannel(channelToDelete.id)
}

const deleteCategoryFromContextMenu = () => {
  if (!props.isAdmin) return

  const categoryId = contextMenuCategoryId.value
  const isUncategorized = contextMenuUncategorized.value
  const categoryName = isUncategorized
    ? 'Channels'
    : chatStore.activeServerCategories.find((entry) => entry.id === categoryId)?.name

  if (!isUncategorized && (!categoryId || !categoryName)) return

  const categoryChannelCount = isUncategorized
    ? uncategorizedChannels.value.length
    : getCategoryChannels(categoryId as string).length

  if (categoryChannelCount > 0) {
    contextMenuVisible.value = false
    contextMenuCategoryId.value = null
    contextMenuUncategorized.value = false
    return
  }

  if (!confirm(`Delete category ${categoryName}? This cannot be undone.`)) {
    return
  }

  contextMenuVisible.value = false
  contextMenuChannel.value = null
  contextMenuCategoryId.value = null
  contextMenuUncategorized.value = false

  if (isUncategorized) {
    chatStore.deleteUncategorizedCategory()
    return
  }

  chatStore.deleteCategory(categoryId as string)
}

const openCreateChannelFromContextMenu = (type: 'text' | 'voice' | 'rss' | 'folder') => {
  if (!props.isAdmin) return

  contextMenuVisible.value = false
  contextMenuChannel.value = null
  contextMenuCategoryId.value = null
  contextMenuUncategorized.value = false
  emit('open-create-channel', { categoryId: null, type })
}

const openCreateCategoryFromContextMenu = () => {
  if (!props.isAdmin) return

  contextMenuVisible.value = false
  contextMenuChannel.value = null
  contextMenuCategoryId.value = null
  contextMenuUncategorized.value = false
  emit('open-create-channel', { categoryId: null, createCategory: true })
}

const isVoiceUserSpeaking = (userId: string) => webrtcStore.isUserSpeaking(userId)
const isUserScreenSharing = (userId: string) => webrtcStore.userScreenStreams.has(userId)
</script>

<template>
  <aside class="w-60 bg-zinc-950 flex flex-col shrink-0">
    <template v-if="chatStore.activeConnectionId">
      <header class="h-14 px-4 flex items-center justify-between border-b border-white/5 hover:bg-zinc-900/80 cursor-pointer transition-colors shrink-0">
        <h1 class="font-bold text-white truncate drop-shadow-sm">{{ activeServer.name }}</h1>
        <div class="flex items-center gap-2">
          <button v-if="isAdmin" class="text-zinc-400 hover:text-white transition-colors" title="Server Settings" @click.stop="emit('open-server-settings')">
            <Settings class="w-4 h-4" />
          </button>
          <button class="text-zinc-400 hover:text-white transition-colors" title="Invite People" @click.stop="emit('open-invite')">
            <Link class="w-4 h-4" />
          </button>
          <button class="text-zinc-500 hover:text-red-400 transition-colors" title="Remove Server" @click.stop="emit('remove-server')">
            <Trash2 class="w-4 h-4" />
          </button>
        </div>
      </header>

      <div class="flex-1 overflow-y-auto p-3 space-y-1 custom-scrollbar" @contextmenu.prevent="openChannelListContextMenu">
        <div
          v-for="category in chatStore.activeServerCategories"
          :key="category.id"
          class="mb-4 rounded-lg transition-colors"
          :class="[(dragOverCategoryId === category.id ? 'bg-zinc-900/50 ring-1 ring-indigo-400/60' : ''), (dragOverCategoryTargetId === category.id ? 'ring-1 ring-amber-400/70' : '')]"
          @dragover="handleCategoryDragOver($event, category.id)"
          @dragenter.prevent="handleCategoryDragOver($event, category.id)"
          @drop.prevent="handleCategoryDrop(category.id)"
        >
          <div class="pt-2 pb-1.5 px-2 flex items-center justify-between group cursor-pointer"
            :draggable="isAdmin"
            @dragstart="handleCategoryHeaderDragStart(category.id)"
            @dragover="draggedChannelId ? handleCategoryDragOver($event, category.id) : handleCategoryHeaderDragOver($event, category.id)"
            @dragenter.prevent="draggedChannelId ? handleCategoryDragOver($event, category.id) : handleCategoryHeaderDragOver($event, category.id)"
            @drop="handleCategoryHeaderDrop($event, category.id)"
            @dragend="handleDragEnd"
            @contextmenu.stop.prevent="openCategoryContextMenu($event, category.id)">
            <div class="flex items-center text-xs font-bold text-zinc-500 group-hover:text-zinc-300 uppercase tracking-widest transition-colors">
              <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
              {{ category.name }}
            </div>
            <button v-if="isAdmin" class="text-zinc-500 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-all font-bold" @click.stop="emit('open-create-channel', { categoryId: category.id })">
              <Plus class="w-3.5 h-3.5" />
            </button>
          </div>

          <div v-for="channel in getCategoryChannels(category.id)" :key="channel.id">
            <div
              class="relative flex items-center px-2 py-1.5 rounded-lg cursor-pointer group mb-[2px] transition-colors"
              :class="channelRowClass(channel)"
              :draggable="isAdmin"
              @click="handleChannelClick(channel)"
              @dragstart="handleDragStart(channel)"
              @dragover="handleDragOver($event, channel)"
              @drop.prevent="handleDrop(channel)"
              @dragend="handleDragEnd"
              @contextmenu.stop.prevent="openChannelContextMenu($event, channel)"
            >
              <div v-if="isChannelUnread(channel)" class="absolute -left-1.5 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-white"></div>
              <Hash v-if="channel.type === 'text'" class="w-5 h-5 mr-1.5" :class="isChannelActive(channel) || isChannelUnread(channel) ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-300'" />
              <Rss v-else-if="channel.type === 'rss'" class="w-5 h-5 mr-1.5" :class="isChannelActive(channel) || isChannelUnread(channel) ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-300'" />
              <Folder v-else-if="channel.type === 'folder'" class="w-5 h-5 mr-1.5" :class="isChannelActive(channel) ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-300'" />
              <Volume2 v-else class="w-5 h-5 mr-1.5 text-zinc-400 group-hover:text-zinc-300" />
              <span class="truncate font-medium">{{ channel.name }}</span>
            </div>

            <div v-if="channel.type === 'voice' && webrtcStore.channelParticipants.get(channel.id)?.length" class="pl-8 pr-2 pb-2 pt-1 space-y-1">
              <div v-for="user in webrtcStore.channelParticipants.get(channel.id)" :key="user.id" class="flex items-center text-zinc-300 text-[13px] hover:text-white cursor-pointer transition-colors px-1 py-0.5 rounded-md hover:bg-zinc-900/50">
                <div class="relative w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 mr-2 flex items-center justify-center text-[10px] font-bold overflow-hidden" :class="isVoiceUserSpeaking(user.id) ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-zinc-950' : ''">
                  <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover" />
                  <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
                </div>
                <span class="truncate flex-1 font-medium">{{ user.username }}</span>
                <div class="flex items-center gap-1 ml-2">
                  <MicOff v-if="user.isMuted || user.isDeafened" class="w-3 h-3 text-red-400" />
                  <MonitorUp v-if="isUserScreenSharing(user.id)" class="w-3.5 h-3.5 text-green-400" title="Screen sharing" />
                  <div v-if="user.isDeafened" class="relative flex items-center justify-center">
                    <Headphones class="w-3 h-3 text-red-400" />
                    <div class="absolute w-3.5 h-[1.5px] bg-red-400 rotate-45 rounded-full"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          v-if="!chatStore.uncategorizedCategoryDeleted || uncategorizedChannels.length > 0"
          class="mb-4 rounded-lg transition-colors"
          :class="dragOverUncategorized ? 'bg-zinc-900/50 ring-1 ring-indigo-400/60' : ''"
          @dragover="handleCategoryDragOver($event, null)"
          @dragenter.prevent="handleCategoryDragOver($event, null)"
          @drop.prevent="handleCategoryDrop(null)"
        >
          <div class="pt-2 pb-1.5 px-2 flex items-center justify-between group cursor-pointer" @contextmenu.stop.prevent="openUncategorizedContextMenu">
            <div class="text-xs font-bold text-zinc-500 group-hover:text-zinc-300 uppercase tracking-widest transition-colors">Channels</div>
            <button v-if="isAdmin" class="text-zinc-500 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-all font-bold" @click.stop="emit('open-create-channel', { categoryId: null })">
              <Plus class="w-3.5 h-3.5" />
            </button>
          </div>

          <div v-for="channel in uncategorizedChannels" :key="channel.id">
            <div
              class="relative flex items-center px-2 py-1.5 rounded-lg cursor-pointer group mb-[2px] transition-colors"
              :class="channelRowClass(channel)"
              :draggable="isAdmin"
              @click="handleChannelClick(channel)"
              @dragstart="handleDragStart(channel)"
              @dragover="handleDragOver($event, channel)"
              @drop.prevent="handleDrop(channel)"
              @dragend="handleDragEnd"
              @contextmenu.stop.prevent="openChannelContextMenu($event, channel)"
            >
              <div v-if="isChannelUnread(channel)" class="absolute -left-1.5 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-white"></div>
              <Hash v-if="channel.type === 'text'" class="w-5 h-5 mr-1.5" :class="isChannelActive(channel) || isChannelUnread(channel) ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-300'" />
              <Rss v-else-if="channel.type === 'rss'" class="w-5 h-5 mr-1.5" :class="isChannelActive(channel) || isChannelUnread(channel) ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-300'" />
              <Folder v-else-if="channel.type === 'folder'" class="w-5 h-5 mr-1.5" :class="isChannelActive(channel) ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-300'" />
              <Volume2 v-else class="w-5 h-5 mr-1.5 text-zinc-400 group-hover:text-zinc-300" />
              <span class="truncate font-medium">{{ channel.name }}</span>
            </div>

            <div v-if="channel.type === 'voice' && webrtcStore.channelParticipants.get(channel.id)?.length" class="pl-8 pr-2 pb-2 pt-1 space-y-1">
              <div v-for="user in webrtcStore.channelParticipants.get(channel.id)" :key="user.id" class="flex items-center text-zinc-300 text-[13px] hover:text-white cursor-pointer transition-colors px-1 py-0.5 rounded-md hover:bg-zinc-900/50">
                <div class="relative w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 mr-2 flex items-center justify-center text-[10px] font-bold overflow-hidden" :class="isVoiceUserSpeaking(user.id) ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-zinc-950' : ''">
                  <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover" />
                  <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
                </div>
                <span class="truncate flex-1 font-medium">{{ user.username }}</span>
                <div class="flex items-center gap-1 ml-2">
                  <MicOff v-if="user.isMuted || user.isDeafened" class="w-3 h-3 text-red-400" />
                  <MonitorUp v-if="isUserScreenSharing(user.id)" class="w-3.5 h-3.5 text-green-400" title="Screen sharing" />
                  <div v-if="user.isDeafened" class="relative flex items-center justify-center">
                    <Headphones class="w-3 h-3 text-red-400" />
                    <div class="absolute w-3.5 h-[1.5px] bg-red-400 rotate-45 rounded-full"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="contextMenuVisible && isAdmin" class="channel-context-menu fixed z-50 w-56 rounded-xl border border-white/10 bg-zinc-950 shadow-2xl py-1 backdrop-blur-md" :style="{ left: `${contextMenuX}px`, top: `${contextMenuY}px` }">
        <button v-if="contextMenuChannel" class="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors" @click="deleteChannelFromContextMenu">
          <Trash2 class="w-4 h-4" />
          Delete channel
        </button>
        <button v-if="canDeleteCategoryFromContextMenu" class="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors" @click="deleteCategoryFromContextMenu">
          <Trash2 class="w-4 h-4" />
          Delete category
        </button>
        <div v-if="shouldShowContextMenuDivider" class="my-1 border-t border-white/5"></div>
        <button class="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors" @click="openCreateChannelFromContextMenu('text')">
          <Hash class="w-4 h-4" />
          Create text channel
        </button>
        <button class="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors" @click="openCreateChannelFromContextMenu('voice')">
          <Volume2 class="w-4 h-4" />
          Create voice channel
        </button>
        <button class="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors" @click="openCreateChannelFromContextMenu('rss')">
          <Rss class="w-4 h-4" />
          Create RSS channel
        </button>
        <button class="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors" @click="openCreateChannelFromContextMenu('folder')">
          <Folder class="w-4 h-4" />
          Create folder channel
        </button>
        <button class="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors" @click="openCreateCategoryFromContextMenu">
          <Plus class="w-4 h-4" />
          Create category
        </button>
      </div>
    </template>
    <template v-else>
      <div class="flex-1 flex items-center justify-center text-zinc-600 text-sm p-4 text-center font-medium">Select a connection to view channels</div>
    </template>

    <div v-if="webrtcStore.activeVoiceChannelId" ref="voiceStatsContainerRef" class="relative">
      <div class="h-[52px] bg-zinc-900/50 px-3 flex items-center shrink-0 border-t border-white/5 cursor-pointer hover:bg-zinc-900 transition-colors" @click="showVoiceStats = !showVoiceStats">
        <div class="flex items-center flex-1 min-w-0">
          <div class="mr-2" :class="{ 'text-green-400': webrtcStore.connectionQuality === 'good', 'text-yellow-400': webrtcStore.connectionQuality === 'warning', 'text-red-400': webrtcStore.connectionQuality === 'bad' }">
            <Volume2 class="w-5 h-5" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-bold uppercase tracking-wider truncate" :class="{ 'text-green-400': webrtcStore.connectionQuality === 'good', 'text-yellow-400': webrtcStore.connectionQuality === 'warning', 'text-red-400': webrtcStore.connectionQuality === 'bad' }">Voice Connected</div>
            <div class="text-[11px] text-zinc-400 font-medium truncate mt-[1px]">{{ chatStore.activeServerChannels.find(c => c.id === webrtcStore.activeVoiceChannelId)?.name || 'Voice Channel' }}</div>
          </div>
        </div>
        <button class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors" :class="webrtcStore.screenProducer ? 'text-green-400 hover:text-green-300' : 'text-zinc-400 hover:text-zinc-300'" :title="webrtcStore.screenProducer ? 'Stop sharing screen' : 'Share screen'" @click.stop="webrtcStore.screenProducer ? webrtcStore.stopScreenShare() : webrtcStore.startScreenShare()">
          <MonitorUp class="w-5 h-5" />
        </button>
        <button class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10 text-zinc-400 hover:text-red-400 transition-colors" title="Disconnect" @click.stop="webrtcStore.leaveVoiceChannel()">
          <PhoneOff class="w-4 h-4" />
        </button>
      </div>

      <div v-if="webrtcStore.screenShareError" class="px-3 py-1 text-[11px] leading-4 text-amber-300 bg-amber-950/30 border-b border-amber-700/40" role="alert">{{ webrtcStore.screenShareError }}</div>

      <div v-if="showVoiceStats" class="absolute bottom-[56px] left-2 w-64 bg-zinc-950 rounded-xl shadow-2xl border border-white/10 p-4 z-50">
        <div class="flex justify-between items-center mb-3">
          <h3 class="text-xs font-bold text-zinc-300 uppercase tracking-widest">Voice Connection</h3>
          <div class="text-[10px] font-bold px-2 py-0.5 rounded-full" :class="{ 'bg-green-500/10 text-green-400 border border-green-500/20': webrtcStore.connectionQuality === 'good', 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20': webrtcStore.connectionQuality === 'warning', 'bg-red-500/10 text-red-400 border border-red-500/20': webrtcStore.connectionQuality === 'bad' }">{{ webrtcStore.ping }} ms</div>
        </div>

        <div class="space-y-4">
          <div>
            <div class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5 flex justify-between"><span>Ping History</span></div>
            <div class="h-10 flex items-end gap-[2px] bg-zinc-900 border border-white/5 p-1 rounded-lg">
              <div v-for="(p, i) in webrtcStore.pingHistory" :key="i" class="flex-1 rounded-sm min-w-[2px]" :style="{ height: `${Math.min(100, Math.max(5, (p / 300) * 100))}%` }" :class="{ 'bg-green-500': p < 100, 'bg-yellow-500': p >= 100 && p < 250, 'bg-red-500': p >= 250 }"></div>
            </div>
          </div>

          <div>
            <div class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1 flex justify-between">
              <span>Bandwidth</span>
              <span class="text-zinc-300">{{ formattedBandwidth }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="h-[52px] bg-zinc-900 border-t border-white/5 px-2 flex items-center shrink-0">
      <div class="flex items-center hover:bg-zinc-800/80 p-1.5 rounded-lg cursor-pointer flex-1 min-w-0 transition-colors">
        <div class="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-400 relative shrink-0 flex items-center justify-center font-bold text-sm" :class="chatStore.currentUser && isVoiceUserSpeaking(chatStore.currentUser.id) ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-zinc-900' : ''">
          {{ userPanelName.charAt(0).toUpperCase() }}
          <div class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-zinc-900" :class="hasCurrentUser ? 'bg-green-500' : 'bg-zinc-600'"></div>
        </div>
        <div class="ml-2.5 flex-1 min-w-0">
          <div class="text-[13px] font-bold text-white truncate drop-shadow-sm">{{ userPanelName }}</div>
          <div class="text-[11px] font-medium text-zinc-400 flex items-center gap-1.5 truncate mt-0.5">
            <span class="w-1.5 h-1.5 rounded-full" :class="hasCurrentUser ? 'bg-green-500' : 'bg-zinc-600'"></span>
            {{ hasCurrentUser ? 'Online' : 'Offline' }}
          </div>
        </div>
      </div>
      <div class="flex items-center gap-0.5 ml-1">
        <button class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors" title="Settings" @click="emit('open-admin')">
          <Settings class="w-4 h-4" />
        </button>
        <button class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!webrtcStore.activeVoiceChannelId" :class="webrtcStore.isMuted || webrtcStore.isDeafened ? 'text-red-400' : 'text-zinc-400 hover:text-white'" :title="webrtcStore.isMuted || webrtcStore.isDeafened ? 'Unmute' : 'Mute'" @click="webrtcStore.toggleMute()">
          <MicOff v-if="webrtcStore.isMuted || webrtcStore.isDeafened" class="w-4 h-4" />
          <Mic v-else class="w-4 h-4" />
        </button>
        <button class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors relative disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!webrtcStore.activeVoiceChannelId" :class="webrtcStore.isDeafened ? 'text-red-400' : 'text-zinc-400 hover:text-white'" :title="webrtcStore.isDeafened ? 'Undeafen' : 'Deafen'" @click="webrtcStore.toggleDeafen()">
          <Headphones class="w-4 h-4" />
          <div v-if="webrtcStore.isDeafened" class="absolute w-5 h-[1.5px] bg-red-400 rotate-45 rounded-full"></div>
        </button>
      </div>
    </div>
  </aside>
</template>
