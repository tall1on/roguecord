<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, type Component, type ComponentPublicInstance } from 'vue'
import { Archive, Code2, File, FileText, Film, Image, Music2 } from 'lucide-vue-next'
import { useChatStore, type Message, type FolderChannelFile } from '../stores/chat'
import { useWebRtcStore } from '../stores/webrtc'

const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()
const messageInput = ref('')
const messagesContainer = ref<HTMLElement | null>(null)
const preserveScrollOnNextRender = ref(false)
const previousScrollHeight = ref(0)
const isFetchingOlderMessages = ref(false)
const folderFileInput = ref<HTMLInputElement | null>(null)
const isUploadingFolderFile = ref(false)
const folderUploadError = ref<string | null>(null)
const folderViewMode = ref<'list' | 'tiles'>('list')

const TOP_SCROLL_THRESHOLD_PX = 120
const BOTTOM_SCROLL_THRESHOLD_PX = 120

const activeTextChannel = computed(() => {
  if (chatStore.activeMainPanel.type !== 'text' || !chatStore.activeMainPanel.channelId) return null
  const channels = chatStore.channels || []
  return channels.find(c => c.id === chatStore.activeMainPanel.channelId && (c.type === 'text' || c.type === 'rss'))
})

const activeVoiceChannel = computed(() => {
  if (chatStore.activeMainPanel.type !== 'voice' || !chatStore.activeMainPanel.channelId) return null
  const channels = chatStore.channels || []
  return channels.find(c => c.id === chatStore.activeMainPanel.channelId && c.type === 'voice')
})

const activeFolderChannel = computed(() => {
  if (chatStore.activeMainPanel.type !== 'folder' || !chatStore.activeMainPanel.channelId) return null
  const channels = chatStore.channels || []
  return channels.find(c => c.id === chatStore.activeMainPanel.channelId && c.type === 'folder') || null
})

const activeFolderFiles = computed<FolderChannelFile[]>(() => {
  const channelId = activeFolderChannel.value?.id
  if (!channelId) return []
  return chatStore.folderFiles[channelId] || []
})

const canManageFolderFiles = computed(() => {
  const role = chatStore.currentUserRole || 'user'
  return role === 'admin' || role === 'owner'
})

const canUploadToFolder = computed(() => canManageFolderFiles.value)

const activeVoiceParticipants = computed(() => {
  if (!activeVoiceChannel.value) return []
  return webrtcStore.channelParticipants.get(activeVoiceChannel.value.id) || []
})

const voiceParticipantCount = computed(() => activeVoiceParticipants.value.length)

const isTwoParticipantVoiceLayout = computed(() => activeVoiceParticipants.value.length === 2)

const isThreeParticipantVoiceLayout = computed(() => activeVoiceParticipants.value.length === 3)

const voiceGridClass = computed(() => {
  if (isTwoParticipantVoiceLayout.value) {
    return 'grid-cols-1 grid-rows-2 auto-rows-fr'
  }

  if (isThreeParticipantVoiceLayout.value) {
    return 'grid-cols-1 grid-rows-3 auto-rows-fr'
  }

  return 'grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))] auto-rows-fr'
})

const voiceTileClass = computed(() => {
  if (isTwoParticipantVoiceLayout.value) {
    return 'w-full h-full min-h-0'
  }

  if (voiceParticipantCount.value === 1) {
    return 'w-full h-full min-h-[320px]'
  }

  if (voiceParticipantCount.value <= 4) {
    return 'w-full h-full min-h-[220px]'
  }

  return 'w-full h-full min-h-[180px]'
})

const isVoiceUserSpeaking = (userId: string) => webrtcStore.isUserSpeaking(userId)
const screenVideoElements = new Map<string, HTMLVideoElement>()
const screenContainerElements = new Map<string, HTMLElement>()

type ScreenContextMenuState = {
  visible: boolean
  x: number
  y: number
  userId: string | null
  isOwner: boolean
}

type ScreenStreamFps = 30 | 60
type ScreenStreamResolution = 'source' | '1080p' | '720p' | '480p' | '4k' | '8k'

const screenContextMenu = ref<ScreenContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  userId: null,
  isOwner: false
})
const screenContextMenuRef = ref<HTMLElement | null>(null)

const screenFpsOptions: Array<{ value: ScreenStreamFps; label: string }> = [
  { value: 30, label: '30 FPS' },
  { value: 60, label: '60 FPS' }
]

const baseScreenResolutionOptions: Array<{ value: ScreenStreamResolution; label: string }> = [
  { value: 'source', label: 'Source' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' }
]

const getScreenResolutionOptions = (userId: string): Array<{ value: ScreenStreamResolution; label: string }> => {
  const stream = getUserScreenStream(userId)
  const track = stream?.getVideoTracks()[0] || null
  const settings = track?.getSettings()

  const sourceWidth = settings?.width || 0
  const sourceHeight = settings?.height || 0
  const screenWidth = Math.floor(window.screen.width * (window.devicePixelRatio || 1))
  const screenHeight = Math.floor(window.screen.height * (window.devicePixelRatio || 1))

  const isCapabilityUnknown = sourceWidth === 0 || sourceHeight === 0
  const allow4k =
    isCapabilityUnknown ||
    sourceWidth >= 3840 ||
    sourceHeight >= 2160 ||
    screenWidth >= 3840 ||
    screenHeight >= 2160
  const allow8k =
    isCapabilityUnknown ||
    sourceWidth >= 7680 ||
    sourceHeight >= 4320 ||
    screenWidth >= 7680 ||
    screenHeight >= 4320

  const options = [...baseScreenResolutionOptions]

  if (allow4k) {
    options.push({ value: '4k', label: '4K' })
  }

  if (allow8k) {
    options.push({ value: '8k', label: '8K' })
  }

  return options
}

const isCurrentUserStreamOwner = (userId: string) => chatStore.currentUser?.id === userId

const closeScreenContextMenu = () => {
  screenContextMenu.value.visible = false
}

const syncScreenVideoAudioState = (userId: string) => {
  const video = screenVideoElements.get(userId)
  if (!video) return
  video.muted = webrtcStore.isScreenStreamMuted(userId)
  video.volume = webrtcStore.getScreenStreamVolume(userId)
}

const openScreenContextMenu = (event: MouseEvent, userId: string) => {
  event.preventDefault()
  event.stopPropagation()
  const isOwner = isCurrentUserStreamOwner(userId)
  const estimatedHeight = isOwner ? 336 : 52
  const estimatedWidth = 188
  const maxX = Math.max(8, window.innerWidth - estimatedWidth - 8)
  const maxY = Math.max(8, window.innerHeight - estimatedHeight - 8)

  screenContextMenu.value = {
    visible: true,
    x: Math.min(event.clientX, maxX),
    y: Math.min(event.clientY, maxY),
    userId,
    isOwner
  }
}

const onSelectScreenFps = (fps: ScreenStreamFps) => {
  const userId = screenContextMenu.value.userId
  if (!userId) return
  void webrtcStore.setScreenStreamFps(userId, fps)
  closeScreenContextMenu()
}

const onSelectScreenResolution = (resolution: ScreenStreamResolution) => {
  const userId = screenContextMenu.value.userId
  if (!userId) return
  void webrtcStore.setScreenStreamResolution(userId, resolution)
  closeScreenContextMenu()
}

const onToggleLocalScreenMute = () => {
  const userId = screenContextMenu.value.userId
  if (!userId) return
  webrtcStore.setScreenStreamMuted(userId, !webrtcStore.isScreenStreamMuted(userId))
  syncScreenVideoAudioState(userId)
  closeScreenContextMenu()
}

const getScreenVolumePercent = (userId: string) => Math.round(webrtcStore.getScreenStreamVolume(userId) * 100)

const onScreenVolumeInput = (userId: string, event: Event) => {
  event.stopPropagation()
  const input = event.target as HTMLInputElement | null
  if (!input) return

  const nextValue = Number(input.value)
  if (!Number.isFinite(nextValue)) return
  webrtcStore.setScreenStreamVolume(userId, nextValue / 100)
  syncScreenVideoAudioState(userId)
}

const onToggleScreenVolumeMute = (userId: string, event: MouseEvent) => {
  event.stopPropagation()
  webrtcStore.setScreenStreamMuted(userId, !webrtcStore.isScreenStreamMuted(userId))
  syncScreenVideoAudioState(userId)
}

const getScreenVolumeIcon = (userId: string) => {
  if (webrtcStore.isScreenStreamMuted(userId)) return '🔇'

  const volume = webrtcStore.getScreenStreamVolume(userId)
  if (volume <= 0) return '🔇'
  if (volume < 0.5) return '🔉'
  return '🔊'
}

const onGlobalPointerDown = (event: MouseEvent) => {
  if (!screenContextMenu.value.visible) return
  const target = event.target as Node | null
  if (screenContextMenuRef.value?.contains(target || null)) return
  closeScreenContextMenu()
}

const onGlobalContextMenu = (event: MouseEvent) => {
  if (!screenContextMenu.value.visible) return
  const target = event.target as Node | null
  if (screenContextMenuRef.value?.contains(target || null)) return
  closeScreenContextMenu()
}

const onGlobalKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closeScreenContextMenu()
  }
}

const getUserScreenStream = (userId: string) => webrtcStore.userScreenStreams.get(userId) || null

const setScreenVideoRef = (userId: string, video: HTMLVideoElement | null) => {
  if (!video) {
    screenVideoElements.delete(userId)
    return
  }

  screenVideoElements.set(userId, video)
  video.controls = false
  syncScreenVideoAudioState(userId)
  const nextStream = getUserScreenStream(userId)
  if (video.srcObject !== nextStream) {
    video.srcObject = nextStream
    if (nextStream) {
      const videoTrack = nextStream.getVideoTracks()[0] || null
      console.info('[WebRTC][screen][view] Attaching stream to video element', {
        userId,
        streamId: nextStream.id,
        trackId: videoTrack?.id || null,
        trackEnabled: videoTrack?.enabled ?? null,
        trackMuted: videoTrack?.muted ?? null,
        trackReadyState: videoTrack?.readyState || null,
        mutedAttr: video.muted,
        autoplay: video.autoplay,
        paused: video.paused
      })
      void video.play().catch((error) => {
        console.warn('[WebRTC][screen] Remote screen video play() blocked/failed on attach', {
          userId,
          error
        })
      })
    }
  }
}

const setScreenVideoTemplateRef = (
  userId: string,
  el: Element | ComponentPublicInstance | null
) => {
  if (el === null) {
    setScreenVideoRef(userId, null)
    return
  }

  if (el instanceof HTMLVideoElement) {
    setScreenVideoRef(userId, el)
  }
}

const setScreenContainerRef = (
  userId: string,
  el: Element | ComponentPublicInstance | null
) => {
  if (el === null) {
    screenContainerElements.delete(userId)
    return
  }

  if (el instanceof HTMLElement) {
    screenContainerElements.set(userId, el)
  }
}

const enterScreenFullscreen = async (userId: string) => {
  const container = screenContainerElements.get(userId)
  if (!container) return

  const requestFullscreen =
    container.requestFullscreen
      ? () => container.requestFullscreen()
      : (container as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen
        ? () => (container as HTMLElement & { webkitRequestFullscreen: () => Promise<void> }).webkitRequestFullscreen()
        : null

  if (!requestFullscreen) return

  try {
    await requestFullscreen()
  } catch (_e) {
    // no-op
  }
}

const exitScreenFullscreen = async () => {
  const exitFullscreen =
    document.exitFullscreen
      ? () => document.exitFullscreen()
      : (document as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen
        ? () => (document as Document & { webkitExitFullscreen: () => Promise<void> }).webkitExitFullscreen()
        : null

  if (!exitFullscreen) return

  try {
    await exitFullscreen()
  } catch (_e) {
    // no-op
  }
}

const getFullscreenElement = () => {
  return document.fullscreenElement ||
    (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ||
    null
}

const onScreenVideoClick = async (userId: string) => {
  const container = screenContainerElements.get(userId)
  if (!container) return

  const fullscreenElement = getFullscreenElement()
  if (fullscreenElement === container) {
    await exitScreenFullscreen()
    return
  }

  await enterScreenFullscreen(userId)
}

watch(
  () => webrtcStore.userScreenStreams,
  (streams) => {
    for (const [userId, el] of screenVideoElements.entries()) {
      const nextStream = streams.get(userId) || null
      if (el.srcObject !== nextStream) {
        el.srcObject = nextStream
        if (nextStream) {
          const videoTrack = nextStream.getVideoTracks()[0] || null
          console.info('[WebRTC][screen][view] Updating stream on existing video element', {
            userId,
            streamId: nextStream.id,
            trackId: videoTrack?.id || null,
            trackEnabled: videoTrack?.enabled ?? null,
            trackMuted: videoTrack?.muted ?? null,
            trackReadyState: videoTrack?.readyState || null,
            mutedAttr: el.muted,
            autoplay: el.autoplay,
            paused: el.paused
          })
          void el.play().catch((error) => {
            console.warn('[WebRTC][screen] Remote screen video play() blocked/failed on stream update', {
              userId,
              error
            })
          })
        }
      }
    }

    const fsEl = getFullscreenElement()
    if (fsEl) {
      let fullscreenUserId: string | null = null
      for (const [userId, container] of screenContainerElements.entries()) {
        if (container === fsEl) {
          fullscreenUserId = userId
          break
        }
      }

      if (fullscreenUserId && !streams.has(fullscreenUserId)) {
        void exitScreenFullscreen()
      }
    }
  },
  { deep: false }
)

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onGlobalPointerDown)
  window.removeEventListener('contextmenu', onGlobalContextMenu)
  window.removeEventListener('keydown', onGlobalKeyDown)
  if (getFullscreenElement()) {
    void exitScreenFullscreen()
  }
})

onMounted(() => {
  window.addEventListener('mousedown', onGlobalPointerDown)
  window.addEventListener('contextmenu', onGlobalContextMenu)
  window.addEventListener('keydown', onGlobalKeyDown)
})

const privilegedRoles = new Set(['admin', 'owner', 'mod', 'moderator', 'bot', 'system'])

const isReadOnlyRssChannel = computed(() => {
  if (!activeTextChannel.value || activeTextChannel.value.type !== 'rss') {
    return false
  }

  const role = chatStore.currentUserRole || 'user'
  return !privilegedRoles.has(role)
})

const messagePlaceholder = computed(() => {
  if (!activeTextChannel.value) return ''
  if (isReadOnlyRssChannel.value) {
    return 'This RSS channel is read-only for your role'
  }
  return `Message #${activeTextChannel.value.name}`
})

type AvatarBadgeType = 'speaking' | 'presence' | null

const getAvatarBadgeType = (userId: string, showPresence: boolean): AvatarBadgeType => {
  if (isVoiceUserSpeaking(userId)) return 'speaking'
  return showPresence ? 'presence' : null
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;')

const TRAILING_PUNCTUATION_REGEX = /[),.;:!?\]]+$/
const URL_REGEX = /(https?:\/\/[^\s<]+)/gi

const formatMessageContentWithLinks = (content: string) => {
  const escaped = escapeHtml(content)

  return escaped.replace(URL_REGEX, (rawUrl) => {
    const trailing = rawUrl.match(TRAILING_PUNCTUATION_REGEX)?.[0] || ''
    const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl

    if (!url) {
      return rawUrl
    }

    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300 underline break-all">${url}</a>${trailing}`
  })
}

const sendMessage = () => {
  if (isReadOnlyRssChannel.value) {
    return
  }

  if (messageInput.value.trim() && activeTextChannel.value) {
    chatStore.sendMessage(activeTextChannel.value.id, messageInput.value.trim())
    messageInput.value = ''
  }
}

const openFolderUploadPicker = () => {
  folderUploadError.value = null
  folderFileInput.value?.click()
}

const onFolderFilePicked = async (event: Event) => {
  const target = event.target as HTMLInputElement | null
  const file = target?.files?.[0] || null
  const channelId = activeFolderChannel.value?.id
  if (!file || !channelId || !canUploadToFolder.value) {
    if (target) target.value = ''
    return
  }

  isUploadingFolderFile.value = true
  folderUploadError.value = null
  try {
    await chatStore.uploadFolderFile(channelId, file)
  } catch (error) {
    folderUploadError.value = error instanceof Error ? error.message : 'Failed to upload file'
  } finally {
    isUploadingFolderFile.value = false
    if (target) target.value = ''
  }
}

const requestFolderFileDownload = (fileId: string) => {
  const channelId = activeFolderChannel.value?.id
  if (!channelId) return
  chatStore.downloadFolderFile(channelId, fileId)
}

const requestFolderFileDelete = (fileId: string, fileName: string) => {
  const channelId = activeFolderChannel.value?.id
  if (!channelId || !canManageFolderFiles.value) return

  const confirmed = window.confirm(`Delete file \"${fileName}\"? This cannot be undone.`)
  if (!confirmed) return

  chatStore.deleteFolderFile(channelId, fileId)
}

type FolderFileCategory = 'image' | 'video' | 'audio' | 'archive' | 'code' | 'text' | 'pdf' | 'generic'

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const videoExtensions = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'm4v'])
const audioExtensions = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'])
const archiveExtensions = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'])
const codeExtensions = new Set(['js', 'ts', 'vue', 'jsx', 'tsx', 'json', 'html', 'css', 'scss', 'md', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'sql'])
const textExtensions = new Set(['txt', 'log', 'csv'])

const folderFileCategoryIcons: Record<FolderFileCategory, Component> = {
  image: Image,
  video: Film,
  audio: Music2,
  archive: Archive,
  code: Code2,
  text: FileText,
  pdf: FileText,
  generic: File
}

const folderFileCategoryIconClasses: Record<FolderFileCategory, string> = {
  image: 'text-emerald-400',
  video: 'text-purple-400',
  audio: 'text-pink-400',
  archive: 'text-amber-400',
  code: 'text-sky-400',
  text: 'text-cyan-400',
  pdf: 'text-red-400',
  generic: 'text-gray-400'
}

const getFileExtension = (fileName: string) => {
  const trimmedName = fileName.trim()
  const dotIndex = trimmedName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === trimmedName.length - 1) return ''
  return trimmedName.slice(dotIndex + 1).toLowerCase()
}

const getFolderFileCategory = (fileName: string): FolderFileCategory => {
  const extension = getFileExtension(fileName)
  if (!extension) return 'generic'
  if (imageExtensions.has(extension)) return 'image'
  if (videoExtensions.has(extension)) return 'video'
  if (audioExtensions.has(extension)) return 'audio'
  if (archiveExtensions.has(extension)) return 'archive'
  if (extension === 'pdf') return 'pdf'
  if (codeExtensions.has(extension)) return 'code'
  if (textExtensions.has(extension)) return 'text'
  return 'generic'
}

const getFolderFileIcon = (fileName: string) => folderFileCategoryIcons[getFolderFileCategory(fileName)]
const getFolderFileIconClass = (fileName: string) => folderFileCategoryIconClasses[getFolderFileCategory(fileName)]

const formatFileSize = (sizeBytes: number) => {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return '0 B'
  if (sizeBytes < 1024) return `${sizeBytes} B`
  const kb = sizeBytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(1)} GB`
}

const formatTime = (dateString: string) => {
  const date = new Date(dateString)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const formatDateDivider = (dateString: string) => {
  const date = new Date(dateString)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  if (target.getTime() === today.getTime()) {
    return 'Today'
  }

  if (target.getTime() === yesterday.getTime()) {
    return 'Yesterday'
  }

  return date.toLocaleDateString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

const getMessageDayKey = (dateString: string) => {
  const date = new Date(dateString)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

type RenderEntry =
  | { type: 'divider'; key: string; label: string }
  | { type: 'message'; key: string; message: Message }

const activeChannelEntries = computed<RenderEntry[]>(() => {
  const entries: RenderEntry[] = []
  let previousDayKey: string | null = null

  for (const message of chatStore.activeChannelMessages) {
    const dayKey = getMessageDayKey(message.created_at)
    if (dayKey !== previousDayKey) {
      entries.push({
        type: 'divider',
        key: `divider-${dayKey}`,
        label: formatDateDivider(message.created_at)
      })
      previousDayKey = dayKey
    }

    entries.push({
      type: 'message',
      key: message.id,
      message
    })
  }

  return entries
})

const isNearBottom = (container: HTMLElement, threshold = BOTTOM_SCROLL_THRESHOLD_PX) => {
  const distance = container.scrollHeight - (container.scrollTop + container.clientHeight)
  return distance <= threshold
}

const scrollToBottom = () => {
  if (!messagesContainer.value) return
  messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
}

const onMessagesScroll = async () => {
  const container = messagesContainer.value
  const channelId = activeTextChannel.value?.id
  if (!container || !channelId) return

  if (container.scrollTop > TOP_SCROLL_THRESHOLD_PX) {
    return
  }

  if (isFetchingOlderMessages.value || chatStore.isLoadingMessagesForChannel(channelId)) {
    return
  }

  if (!chatStore.hasOlderMessagesForChannel(channelId)) {
    return
  }

  previousScrollHeight.value = container.scrollHeight
  preserveScrollOnNextRender.value = true
  isFetchingOlderMessages.value = true
  const started = chatStore.loadOlderMessages(channelId)
  if (!started) {
    preserveScrollOnNextRender.value = false
    isFetchingOlderMessages.value = false
  }
}

watch(
  () => activeTextChannel.value?.id,
  async () => {
    preserveScrollOnNextRender.value = false
    isFetchingOlderMessages.value = false
    await nextTick()
    scrollToBottom()
  }
)

watch(
  () => chatStore.activeChannelMessages.length,
  async (newLength, oldLength) => {
    if (!activeTextChannel.value) return
    await nextTick()
    const container = messagesContainer.value
    if (!container) return

    if (preserveScrollOnNextRender.value) {
      const heightDelta = container.scrollHeight - previousScrollHeight.value
      container.scrollTop += heightDelta
      preserveScrollOnNextRender.value = false
      isFetchingOlderMessages.value = false
      return
    }

    if (newLength <= oldLength) {
      return
    }

    if (oldLength === 0 || isNearBottom(container)) {
      scrollToBottom()
    }
  }
)

watch(
  () => (activeTextChannel.value ? chatStore.isLoadingMessagesForChannel(activeTextChannel.value.id) : false),
  (isLoading) => {
    if (!isLoading && isFetchingOlderMessages.value) {
      isFetchingOlderMessages.value = false
      preserveScrollOnNextRender.value = false
    }
  }
)

watch(
  () => activeFolderChannel.value?.id,
  (channelId) => {
    folderUploadError.value = null
    if (channelId) {
      chatStore.requestFolderFiles(channelId)
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="flex-1 flex flex-col h-full bg-[#313338]">
    <template v-if="activeTextChannel">
      <!-- Chat Header -->
      <header class="h-12 border-b border-[#1e1f22] flex items-center px-4 shadow-sm shrink-0">
        <h2 class="font-semibold text-white flex items-center">
          <span class="text-gray-400 text-xl mr-2">#</span>
          {{ activeTextChannel.name }}
        </h2>
      </header>

      <!-- Chat Messages Area -->
      <main ref="messagesContainer" class="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar" @scroll.passive="onMessagesScroll">
          <div v-if="isFetchingOlderMessages" class="text-center text-xs text-gray-400 py-1">Loading older messages...</div>
          <div v-if="chatStore.activeChannelMessages.length === 0" class="flex flex-col justify-end h-full pb-4">
            <div class="w-16 h-16 rounded-full bg-[#4e5058] flex items-center justify-center mb-4">
              <span class="text-3xl text-white">#</span>
            </div>
            <h1 class="text-3xl font-bold text-white mb-2">Welcome to #{{ activeTextChannel.name }}!</h1>
            <p class="text-gray-400">This is the start of the #{{ activeTextChannel.name }} channel.</p>
          </div>

        <template v-for="entry in activeChannelEntries" :key="entry.key">
          <div v-if="entry.type === 'divider'" class="flex items-center gap-3 py-2">
            <hr class="flex-1 border-t border-[#3f4147]" />
            <span class="text-[11px] uppercase tracking-wide text-gray-400">{{ entry.label }}</span>
            <hr class="flex-1 border-t border-[#3f4147]" />
          </div>

          <div
            v-else
            class="flex items-start gap-4 hover:bg-[#2e3035] p-1 -mx-1 rounded transition-colors"
          >
            <div class="w-10 h-10 rounded-full bg-indigo-500 shrink-0 flex items-center justify-center text-white font-bold mt-0.5">
              {{ entry.message.user?.username.charAt(0).toUpperCase() || '?' }}
            </div>
            <div>
              <div class="flex items-baseline gap-2">
                <span class="font-medium hover:underline cursor-pointer" :class="entry.message.user?.role === 'admin' ? 'text-red-500' : 'text-white'">{{ entry.message.user?.username || 'Unknown User' }}</span>
                <span class="text-xs text-gray-400">{{ formatTime(entry.message.created_at) }}</span>
              </div>
              <p class="text-gray-300 whitespace-pre-wrap break-words" v-html="formatMessageContentWithLinks(entry.message.content)"></p>
            </div>
          </div>
        </template>
      </main>

      <!-- Chat Input Area -->
      <div class="p-4 shrink-0">
        <div class="bg-[#383a40] rounded-lg p-3 flex items-center gap-3" :class="isReadOnlyRssChannel ? 'opacity-80' : ''">
          <button class="w-6 h-6 rounded-full bg-[#4e5058] flex items-center justify-center text-gray-300 hover:text-white shrink-0 transition-colors">
            +
          </button>
          <input 
            v-model="messageInput"
            @keyup.enter="sendMessage"
            type="text" 
            :placeholder="messagePlaceholder"
            :disabled="isReadOnlyRssChannel"
            class="bg-transparent border-none outline-none flex-1 text-gray-200 placeholder-gray-500"
          />
        </div>
        <p v-if="isReadOnlyRssChannel" class="mt-2 text-xs text-gray-400">
          RSS feed channels are read-only for normal users.
        </p>
      </div>
    </template>

    <template v-else-if="activeFolderChannel">
      <header class="h-12 border-b border-[#1e1f22] flex items-center justify-between px-4 shadow-sm shrink-0">
        <h2 class="font-semibold text-white flex items-center">
          <span class="text-gray-400 text-xl mr-2">📁</span>
          {{ activeFolderChannel.name }}
        </h2>
        <div class="flex items-center gap-2">
          <div class="flex items-center rounded-md border border-[#3f4147] bg-[#2b2d31] p-0.5">
            <button
              type="button"
              class="px-2.5 py-1 text-xs rounded text-gray-300 transition-colors"
              :class="folderViewMode === 'list' ? 'bg-[#404249] text-white' : 'hover:bg-[#36393f]'"
              @click="folderViewMode = 'list'"
            >
              List
            </button>
            <button
              type="button"
              class="px-2.5 py-1 text-xs rounded text-gray-300 transition-colors"
              :class="folderViewMode === 'tiles' ? 'bg-[#404249] text-white' : 'hover:bg-[#36393f]'"
              @click="folderViewMode = 'tiles'"
            >
              Tiles
            </button>
          </div>

          <template v-if="canUploadToFolder">
            <input
              ref="folderFileInput"
              type="file"
              class="hidden"
              @change="onFolderFilePicked"
            />
            <button
              type="button"
              class="px-3 py-1.5 text-sm rounded bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-60"
              :disabled="isUploadingFolderFile"
              @click="openFolderUploadPicker"
            >
              {{ isUploadingFolderFile ? 'Uploading...' : 'Upload File' }}
            </button>
          </template>
        </div>
      </header>

      <main class="flex-1 overflow-y-auto p-4 custom-scrollbar">
        <p v-if="folderUploadError" class="mb-3 text-sm text-red-400">{{ folderUploadError }}</p>
        <p v-if="chatStore.lastError && chatStore.activeMainPanel.type === 'folder'" class="mb-3 text-sm text-red-400">{{ chatStore.lastError }}</p>

        <div v-if="activeFolderFiles.length === 0" class="h-full flex items-center justify-center text-gray-400">
          No files in this folder yet.
        </div>

        <div v-else-if="folderViewMode === 'list'" class="space-y-2">
          <div
            v-for="file in activeFolderFiles"
            :key="file.id"
            class="flex items-center justify-between gap-4 rounded-md border border-[#3f4147] bg-[#2b2d31] px-3 py-2"
          >
            <div class="min-w-0 flex items-center gap-2.5">
              <component
                :is="getFolderFileIcon(file.original_name)"
                class="w-4 h-4 shrink-0"
                :class="getFolderFileIconClass(file.original_name)"
              />
              <div class="min-w-0">
                <p class="truncate text-sm text-white font-medium">{{ file.original_name }}</p>
                <p class="text-xs text-gray-400 truncate">
                  {{ formatFileSize(file.size_bytes) }} · {{ file.uploader_username || 'Unknown uploader' }} · {{ formatTime(file.created_at) }}
                </p>
              </div>
            </div>
            <div class="shrink-0 flex items-center gap-2">
              <button
                type="button"
                class="px-3 py-1.5 text-sm rounded bg-[#404249] hover:bg-[#4e5058] text-white"
                @click="requestFolderFileDownload(file.id)"
              >
                Download
              </button>
              <button
                v-if="canManageFolderFiles"
                type="button"
                class="px-3 py-1.5 text-sm rounded bg-[#5b2d31] hover:bg-[#6a3136] text-white"
                @click="requestFolderFileDelete(file.id, file.original_name)"
              >
                Delete
              </button>
            </div>
          </div>
        </div>

        <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <div
            v-for="file in activeFolderFiles"
            :key="file.id"
            class="rounded-md border border-[#3f4147] bg-[#2b2d31] p-4 flex flex-col aspect-square"
          >
            <div class="min-w-0 flex flex-col items-center text-center gap-2">
              <div class="flex justify-center w-full">
                <component
                  :is="getFolderFileIcon(file.original_name)"
                  class="w-12 h-12 shrink-0"
                  :class="getFolderFileIconClass(file.original_name)"
                />
              </div>
              <p class="w-full truncate text-sm text-white font-medium">{{ file.original_name }}</p>
              <p class="w-full text-xs text-gray-400 mt-1 min-w-0 flex items-center justify-center gap-1.5 whitespace-nowrap overflow-hidden">
                <span class="shrink-0">{{ formatFileSize(file.size_bytes) }}</span>
                <span class="text-gray-500 shrink-0">·</span>
                <span class="truncate min-w-0">{{ file.uploader_username || 'Unknown uploader' }}</span>
                <span class="text-gray-500 shrink-0">·</span>
                <span class="shrink-0">{{ formatTime(file.created_at) }}</span>
              </p>
            </div>
            <div class="mt-auto grid gap-2" :class="canManageFolderFiles ? 'grid-cols-2' : 'grid-cols-1'">
              <button
                type="button"
                class="w-full px-3 py-1.5 text-sm rounded bg-[#404249] hover:bg-[#4e5058] text-white"
                @click="requestFolderFileDownload(file.id)"
              >
                Download
              </button>
              <button
                v-if="canManageFolderFiles"
                type="button"
                class="w-full px-3 py-1.5 text-sm rounded bg-[#5b2d31] hover:bg-[#6a3136] text-white"
                @click="requestFolderFileDelete(file.id, file.original_name)"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </main>
    </template>

    <template v-else-if="activeVoiceChannel">
      <header class="h-12 border-b border-[#1e1f22] flex items-center px-4 shadow-sm shrink-0">
        <h2 class="font-semibold text-white flex items-center">
          <span class="text-gray-400 text-xl mr-2">🔊</span>
          {{ activeVoiceChannel.name }}
        </h2>
      </header>

      <main class="flex-1 overflow-y-auto p-6 custom-scrollbar">
        <div
          v-if="activeVoiceParticipants.length > 0"
          class="grid gap-4 h-full"
          :class="voiceGridClass"
        >
          <div
            v-for="user in activeVoiceParticipants"
            :key="user.id"
            class="rounded-xl bg-[#2b2d31] border border-[#3f4147] flex items-center justify-center overflow-hidden"
            :class="voiceTileClass"
          >
            <div
              v-show="getUserScreenStream(user.id)"
              :ref="(el) => setScreenContainerRef(user.id, el)"
              class="screen-stream-wrapper group relative w-full h-full bg-black rounded-xl"
              @click="onScreenVideoClick(user.id)"
              @contextmenu.prevent.stop="openScreenContextMenu($event, user.id)"
            >
              <video
                :ref="(el) => setScreenVideoTemplateRef(user.id, el)"
                :muted="webrtcStore.isScreenStreamMuted(user.id)"
                :volume.prop="webrtcStore.getScreenStreamVolume(user.id)"
                autoplay
                playsinline
                class="screen-stream-video w-full h-full object-contain rounded-xl bg-black cursor-pointer"
              />

              <div
                class="screen-stream-overlay absolute bottom-2 left-2 right-2 z-20 flex items-center gap-2 rounded-md border border-[#1f2124] bg-[#1f2124]/90 px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                @click.stop
                @contextmenu.stop
              >
                <button
                  type="button"
                  class="screen-stream-control w-7 h-7 rounded bg-[#2b2d31] hover:bg-[#3a3d44] text-sm flex items-center justify-center text-gray-200"
                  :aria-label="webrtcStore.isScreenStreamMuted(user.id) ? 'Unmute stream volume' : 'Mute stream volume'"
                  @click="onToggleScreenVolumeMute(user.id, $event)"
                >
                  {{ getScreenVolumeIcon(user.id) }}
                </button>

                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  :value="getScreenVolumePercent(user.id)"
                  class="screen-stream-control flex-1 h-1 accent-indigo-400 cursor-pointer"
                  aria-label="Stream volume"
                  @input="onScreenVolumeInput(user.id, $event)"
                  @click.stop
                />

                <span class="w-9 text-right text-[11px] text-gray-300 tabular-nums">
                  {{ getScreenVolumePercent(user.id) }}%
                </span>
              </div>
            </div>
            <div v-show="!getUserScreenStream(user.id)" class="relative w-20 h-20 rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white font-bold text-3xl" :class="getAvatarBadgeType(user.id, false) === 'speaking' ? 'ring-4 ring-green-400 ring-offset-2 ring-offset-[#2b2d31]' : ''">
              <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover" />
              <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
            </div>
          </div>
        </div>

        <div v-else class="h-full flex items-center justify-center text-gray-400">
          No participants in this voice channel.
        </div>
      </main>

      <div
        v-if="screenContextMenu.visible"
        ref="screenContextMenuRef"
        class="fixed z-50 min-w-[188px] rounded-md border border-[#1e1f22] bg-[#1f2124] py-1 shadow-xl"
        :style="{ left: `${screenContextMenu.x}px`, top: `${screenContextMenu.y}px` }"
        role="menu"
      >
        <template v-if="screenContextMenu.isOwner && screenContextMenu.userId">
          <div class="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">FPS</div>
          <button
            v-for="option in screenFpsOptions"
            :key="option.value"
            type="button"
            class="flex w-full items-center justify-between px-3 py-2 text-sm text-left text-gray-200 hover:bg-[#2b2d31]"
            :class="webrtcStore.getScreenStreamFps(screenContextMenu.userId) === option.value ? 'text-white' : 'text-gray-300'"
            role="menuitemradio"
            :aria-checked="webrtcStore.getScreenStreamFps(screenContextMenu.userId) === option.value"
            @click="onSelectScreenFps(option.value)"
          >
            <span>{{ option.label }}</span>
            <span v-if="webrtcStore.getScreenStreamFps(screenContextMenu.userId) === option.value">✓</span>
          </button>

          <div class="my-1 border-t border-[#2b2d31]"></div>
          <div class="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Resolution</div>
          <button
            v-for="option in getScreenResolutionOptions(screenContextMenu.userId)"
            :key="option.value"
            type="button"
            class="flex w-full items-center justify-between px-3 py-2 text-sm text-left text-gray-200 hover:bg-[#2b2d31]"
            :class="webrtcStore.getScreenStreamResolution(screenContextMenu.userId) === option.value ? 'text-white' : 'text-gray-300'"
            role="menuitemradio"
            :aria-checked="webrtcStore.getScreenStreamResolution(screenContextMenu.userId) === option.value"
            @click="onSelectScreenResolution(option.value)"
          >
            <span>{{ option.label }}</span>
            <span v-if="webrtcStore.getScreenStreamResolution(screenContextMenu.userId) === option.value">✓</span>
          </button>
        </template>

        <button
          v-else
          type="button"
          class="w-full px-3 py-2 text-sm text-left text-gray-200 hover:bg-[#2b2d31]"
          role="menuitem"
          @click="onToggleLocalScreenMute"
        >
          {{ screenContextMenu.userId && webrtcStore.isScreenStreamMuted(screenContextMenu.userId) ? 'Unmute stream' : 'Mute stream' }}
        </button>
      </div>
    </template>
    
    <template v-else>
      <div class="flex-1 flex items-center justify-center flex-col text-gray-400">
        <div class="w-24 h-24 mb-6 opacity-50">
          <svg fill="currentColor" viewBox="0 0 24 24">
            <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.21.4-.4.8-.58 1.21-1.69-.25-3.4-.25-5.1 0-.18-.41-.37-.82-.59-1.2-1.6.27-3.14.75-4.6 1.43A19.04 19.04 0 0 0 1.96 19.58c2.09 1.52 4.1 2.44 6.09 3.04.5-.66.95-1.36 1.35-2.09-1.08-.4-2.1-.89-3.06-1.46.26-.19.51-.39.75-.6 3.9 1.79 8.18 1.79 12.06 0 .24.21.49.41.75.6-.96.57-1.98 1.06-3.06 1.46.4.73.85 1.43 1.35 2.09 2-.6 4.01-1.52 6.1-3.04a19.02 19.02 0 0 0-2.32-14.71zM8.52 16.28c-1.21 0-2.21-1.08-2.21-2.4 0-1.33.98-2.4 2.21-2.4 1.23 0 2.23 1.07 2.21 2.4 0 1.32-.98 2.4-2.21 2.4zm6.96 0c-1.21 0-2.21-1.08-2.21-2.4 0-1.33.98-2.4 2.21-2.4 1.23 0 2.23 1.07 2.21 2.4 0 1.32-.98 2.4-2.21 2.4z"/>
          </svg>
        </div>
        <h2 class="text-xl font-semibold mb-2">No Channel Selected</h2>
        <p>Select a channel from the sidebar to start chatting.</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.screen-stream-wrapper:fullscreen,
.screen-stream-wrapper:-webkit-full-screen {
  width: 100%;
  height: 100%;
  background: #000;
}

.screen-stream-wrapper:fullscreen .screen-stream-video,
.screen-stream-wrapper:-webkit-full-screen .screen-stream-video {
  width: 100%;
  height: 100%;
}

.screen-stream-overlay {
  pointer-events: none;
}

.screen-stream-control,
.screen-stream-overlay span {
  pointer-events: auto;
}

.screen-stream-wrapper:fullscreen .screen-stream-overlay,
.screen-stream-wrapper:-webkit-full-screen .screen-stream-overlay {
  opacity: 1;
}
</style>
