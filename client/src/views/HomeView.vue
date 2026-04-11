<script setup lang="ts">
import { defineAsyncComponent, ref, computed, watch, nextTick, onMounted, onBeforeUnmount, type Component, type ComponentPublicInstance } from 'vue'
import { Archive, Code2, File, FileText, Film, Folder, Image, Music2, Reply, Trash2, X } from 'lucide-vue-next'
import { EmojiPicker } from 'vue3-twemoji-picker-final'
import AppAvatar from '../components/common/AppAvatar.vue'
import { useChatStore, type Message, type MessageEmbed, type FolderChannelFile, type MessageAttachment, type MessageReaction, type MessageReplyReference } from '../stores/chat'
import { useWebRtcStore } from '../stores/webrtc'
import RougeCordMark from '../components/branding/RougeCordMark.vue'
import { openExternalUrl } from '../utils/openExternalUrl'

const MessageAttachmentVideoPlayer = defineAsyncComponent(() => import('../components/chat/MessageAttachmentVideoPlayer.vue'))

type TwemojiPickerSelection = {
  i?: string
}

const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()
const messageInput = ref('')
const messagesContainer = ref<HTMLElement | null>(null)
const preserveScrollOnNextRender = ref(false)
const previousScrollHeight = ref(0)
const isFetchingOlderMessages = ref(false)
const folderFileInput = ref<HTMLInputElement | null>(null)
const messageAttachmentInput = ref<HTMLInputElement | null>(null)
const messageInputElement = ref<HTMLInputElement | null>(null)
const isUploadingFolderFile = ref(false)
const folderUploadError = ref<string | null>(null)
const folderViewMode = ref<'list' | 'tiles'>('list')
const pendingMessageAttachments = ref<File[]>([])
const isSendingMessage = ref(false)
const replyDraftMessage = ref<Message | null>(null)
const messageEmojiPickerOpen = ref(false)
const messageEmojiPickerRef = ref<HTMLElement | null>(null)
const MESSAGE_REACTION_OPTIONS = ['👍', '❤️', '😂', '😮', '🎉'] as const
const sharedEmojiPickerOptions = {
  locals: 'en',
  native: true,
  hasGroupIcons: true,
  hasSearch: false,
  hasGroupNames: false,
  stickyGroupNames: false,
  hasSkinTones: true,
  recentRecords: true
} as const

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
  return chatStore.userHasRole(chatStore.currentUser, ['admin', 'owner'])
})

const canUploadToFolder = computed(() => canManageFolderFiles.value)

const activeVoiceParticipants = computed(() => {
  if (!activeVoiceChannel.value) return []
  return webrtcStore.channelParticipants.get(activeVoiceChannel.value.id) || []
})

const HIDE_VOICE_MEMBERS_WITHOUT_SCREENSHARE_STORAGE_KEY = 'roguecord.voice.hide-members-without-screenshare'

const getInitialHideVoiceMembersWithoutScreenshare = () => {
  if (typeof window === 'undefined') {
    return false
  }

  const storedValue = window.localStorage.getItem(HIDE_VOICE_MEMBERS_WITHOUT_SCREENSHARE_STORAGE_KEY)
  return storedValue === 'true'
}

const hideVoiceMembersWithoutScreenshare = ref(getInitialHideVoiceMembersWithoutScreenshare())

const activeVoiceParticipantsWithMediaState = computed(() => {
  return activeVoiceParticipants.value.map((user) => ({
    ...user,
    isScreenSharing: Boolean(getUserScreenStream(user.id))
  }))
})

const visibleVoiceParticipants = computed(() => {
  if (!hideVoiceMembersWithoutScreenshare.value) {
    return activeVoiceParticipantsWithMediaState.value
  }

  return activeVoiceParticipantsWithMediaState.value.filter((user) => user.isScreenSharing)
})

const voiceParticipantCount = computed(() => visibleVoiceParticipants.value.length)

const voiceGridClass = computed(() => {
  const count = voiceParticipantCount.value

  if (count <= 1) {
    return 'grid-cols-1'
  }

  if (count === 2) {
    return 'grid-cols-1 xl:grid-cols-2'
  }

  if (count <= 4) {
    return 'grid-cols-1 md:grid-cols-2'
  }

  return 'grid-cols-1 md:grid-cols-2 2xl:grid-cols-3'
})

const voiceTileClass = computed(() => {
  const count = voiceParticipantCount.value

  if (count <= 1) {
    return 'min-h-[26rem]'
  }

  if (count === 2) {
    return 'min-h-[22rem]'
  }

  if (count <= 4) {
    return 'min-h-[18rem]'
  }

  return 'min-h-[15rem]'
})

const toggleHideVoiceMembersWithoutScreenshare = () => {
  hideVoiceMembersWithoutScreenshare.value = !hideVoiceMembersWithoutScreenshare.value
}

watch(hideVoiceMembersWithoutScreenshare, (value) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(HIDE_VOICE_MEMBERS_WITHOUT_SCREENSHARE_STORAGE_KEY, String(value))
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

type MessageContextMenuState = {
  visible: boolean
  x: number
  y: number
  message: Message | null
}

type ScreenStreamFps = 15 | 30 | 60
type ScreenStreamResolution = 'source' | '1440p' | '1080p' | '720p' | '480p' | '4k' | '8k'

const screenContextMenu = ref<ScreenContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  userId: null,
  isOwner: false
})
const screenContextMenuRef = ref<HTMLElement | null>(null)
const messageContextMenu = ref<MessageContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  message: null
})
const messageContextMenuRef = ref<HTMLElement | null>(null)

const screenFpsOptions: Array<{ value: ScreenStreamFps; label: string }> = [
  { value: 15, label: '15 FPS' },
  { value: 30, label: '30 FPS' },
  { value: 60, label: '60 FPS' }
]

const baseScreenResolutionOptions: Array<{ value: ScreenStreamResolution; label: string }> = [
  { value: 'source', label: 'Source' },
  { value: '1440p', label: '1440p' },
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

const closeMessageContextMenu = () => {
  messageContextMenu.value = {
    visible: false,
    x: 0,
    y: 0,
    message: null
  }
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

const canDeleteMessage = (message: Message) => {
  const currentUserId = chatStore.currentUser?.id
  return message.user_id === currentUserId || chatStore.userHasRole(chatStore.currentUser, ['admin', 'owner'])
}

const canReplyToMessage = (message: Message) => {
  return Boolean(activeTextChannel.value) && !isReadOnlyRssChannel.value && message.channel_id === activeTextChannel.value?.id
}

const openMessageContextMenu = (event: MouseEvent, message: Message) => {
  if (!canDeleteMessage(message) && !canReplyToMessage(message) && !canReactToMessage(message)) {
    closeMessageContextMenu()
    return
  }

  event.preventDefault()
  event.stopPropagation()

  const estimatedWidth = 224
  const estimatedHeight = (canReplyToMessage(message) ? 52 : 0) + (canDeleteMessage(message) ? 52 : 0) + (canReactToMessage(message) ? 72 : 0)
  const maxX = Math.max(8, window.innerWidth - estimatedWidth - 8)
  const maxY = Math.max(8, window.innerHeight - estimatedHeight - 8)

  messageContextMenu.value = {
    visible: true,
    x: Math.min(event.clientX, maxX),
    y: Math.min(event.clientY, maxY),
    message
  }
}

const canReactToMessage = (message: Message) => {
  return Boolean(activeTextChannel.value) && !isReadOnlyRssChannel.value && message.channel_id === activeTextChannel.value?.id
}

const toggleMessageReaction = (message: Message, emoji: string) => {
  if (!canReactToMessage(message)) return
  chatStore.toggleMessageReaction(message.channel_id, message.id, emoji)
}

const toggleReactionFromContextMenu = (emoji: string) => {
  const message = messageContextMenu.value.message
  if (!message) return
  toggleMessageReaction(message, emoji)
  closeMessageContextMenu()
}

const getMessageReactions = (message: Message): MessageReaction[] => {
  return Array.isArray(message.reactions) ? message.reactions : []
}

const startReplyFromContextMenu = () => {
  const message = messageContextMenu.value.message
  if (!message || !canReplyToMessage(message)) return
  replyDraftMessage.value = message
  closeMessageContextMenu()
}

const clearReplyDraft = () => {
  replyDraftMessage.value = null
}

const deleteMessageFromContextMenu = () => {
  const message = messageContextMenu.value.message
  const channelId = activeTextChannel.value?.id
  if (!message || !channelId || !canDeleteMessage(message)) return

  closeMessageContextMenu()
  chatStore.deleteMessage(channelId, message.id)
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
  const target = event.target as Node | null
  if (screenContextMenu.value.visible && !screenContextMenuRef.value?.contains(target || null)) {
    closeScreenContextMenu()
  }
  if (messageContextMenu.value.visible && !messageContextMenuRef.value?.contains(target || null)) {
    closeMessageContextMenu()
  }
}

const onGlobalContextMenu = (event: MouseEvent) => {
  const target = event.target as Node | null
  if (screenContextMenu.value.visible && !screenContextMenuRef.value?.contains(target || null)) {
    closeScreenContextMenu()
  }
  if (messageContextMenu.value.visible && !messageContextMenuRef.value?.contains(target || null)) {
    closeMessageContextMenu()
  }
}

const onGlobalKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closeScreenContextMenu()
    closeMessageContextMenu()
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

  const roleKeys = chatStore.getUserRoleKeys(chatStore.currentUser)
  return !roleKeys.some((role) => privilegedRoles.has(role))
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

const normalizeHost = (host: string) => host.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')

const getMessageEmbeds = (message: Message): MessageEmbed[] => {
  return Array.isArray(message.embeds) ? message.embeds : []
}

const SUPPRESSED_LINK_EMBED_TYPES = new Set<MessageEmbed['type']>(['spotify', 'youtube'])

const EMBED_TYPES_WITHOUT_FALLBACK_LINK = new Set<MessageEmbed['type']>(['spotify', 'youtube', 'twitch', 'x'])

const getXPostMeta = (embed: MessageEmbed) => {
  if (embed.type !== 'x') {
    return null
  }

  try {
    const parsed = new URL(embed.url)
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    if (pathParts.length < 3 || pathParts[1]?.toLowerCase() !== 'status') {
      return null
    }

    const username = pathParts[0] || ''
    const postId = pathParts[2] || ''
    if (!username || !postId) {
      return null
    }

    return {
      username: embed.authorUsername || username,
      postId,
      authorName: embed.authorName || null
    }
  } catch {
    return null
  }
}

const getXEmbedMediaSrc = (embed: MessageEmbed) => {
  if (embed.type !== 'x') {
    return null
  }

  if (embed.mediaType === 'image' && embed.mediaUrl) {
    return embed.mediaUrl
  }

  if (embed.mediaThumbnailUrl) {
    return embed.mediaThumbnailUrl
  }

  return embed.thumbnailUrl || null
}

const getSuppressedEmbedUrls = (message: Message): Set<string> => {
  const suppressedUrls = new Set<string>()

  for (const embed of getMessageEmbeds(message)) {
    if (!SUPPRESSED_LINK_EMBED_TYPES.has(embed.type) || !embed.url) {
      continue
    }

    suppressedUrls.add(embed.url)
  }

  return suppressedUrls
}

const shouldHideMessageContent = (message: Message): boolean => {
  const content = typeof message.content === 'string' ? message.content.trim() : ''
  if (!content) {
    return false
  }

  const suppressedUrls = getSuppressedEmbedUrls(message)
  if (suppressedUrls.size === 0) {
    return false
  }

  const contentTokens = content.split(/\s+/)
  if (contentTokens.length !== 1) {
    return false
  }

  return suppressedUrls.has(contentTokens[0])
}

const getTrustedEmbedIframeSrc = (embed: MessageEmbed): string | null => {
  if (!embed.embedUrl || typeof embed.embedUrl !== 'string') {
    return null
  }

  try {
    const parsed = new URL(embed.embedUrl)
    if (parsed.protocol !== 'https:') {
      return null
    }

    const host = normalizeHost(parsed.hostname)
    if (embed.type === 'youtube') {
      if (host !== 'youtube.com' || !parsed.pathname.startsWith('/embed/')) {
        return null
      }
      return parsed.toString()
    }

    if (embed.type === 'twitch') {
      if (host !== 'player.twitch.tv' && host !== 'clips.twitch.tv') {
        return null
      }

      const parentHost = (window.location.hostname || 'localhost').toLowerCase()
      parsed.searchParams.set('parent', parentHost)
      return parsed.toString()
    }

    if (embed.type === 'spotify') {
      if (host !== 'spotify.com' && host !== 'open.spotify.com') {
        return null
      }

      if (!parsed.pathname.startsWith('/embed/')) {
        return null
      }

      return parsed.toString()
    }

    return null
  } catch {
    return null
  }
}

const getEmbedContainerClass = (embed: MessageEmbed) => {
  if (embed.type === 'spotify') {
    return 'max-w-[420px] overflow-hidden rounded-lg border border-[#3f4147] bg-[#2b2d31]'
  }

  if (embed.type === 'x') {
    return 'max-w-[560px] overflow-hidden rounded-xl border border-[#3f4147] bg-[#111214]'
  }

  return 'max-w-[560px] overflow-hidden rounded-lg border border-[#3f4147] bg-[#2b2d31]'
}

const getEmbedIframeClass = (embed: MessageEmbed) => {
  return embed.type === 'spotify'
    ? 'block w-full h-[152px] border-0'
    : 'w-full aspect-video border-b border-[#3f4147]'
}

const shouldShowEmbedFallbackLink = (embed: MessageEmbed): boolean => {
  return !EMBED_TYPES_WITHOUT_FALLBACK_LINK.has(embed.type)
}

const sendMessage = () => {
  if (isReadOnlyRssChannel.value) {
    return
  }

  void submitMessage()
}

const pendingAttachmentUploadSummary = computed(() => {
  const progressEntries = chatStore.pendingMessageUploadProgress
  if (!isSendingMessage.value || !progressEntries?.length) {
    return null
  }

  const totalBytes = progressEntries.reduce((sum, entry) => sum + Math.max(entry.totalBytes, 0), 0)
  const loadedBytes = progressEntries.reduce((sum, entry) => sum + Math.min(Math.max(entry.loadedBytes, 0), Math.max(entry.totalBytes, 0)), 0)
  const percent = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0

  return {
    fileCount: progressEntries.length,
    loadedBytes,
    totalBytes,
    percent
  }
})

const onOpenMessageAttachmentPicker = () => {
  if (isReadOnlyRssChannel.value || isSendingMessage.value) return
  messageAttachmentInput.value?.click()
}

const closeMessageEmojiPicker = () => {
  messageEmojiPickerOpen.value = false
}

const toggleMessageEmojiPicker = () => {
  if (isReadOnlyRssChannel.value || isSendingMessage.value) {
    return
  }

  messageEmojiPickerOpen.value = !messageEmojiPickerOpen.value
}

const insertEmojiIntoMessageDraft = async (emoji: string) => {
  const input = messageInputElement.value
  const currentValue = messageInput.value

  if (!input) {
    messageInput.value = `${currentValue}${emoji}`
    return
  }

  const selectionStart = input.selectionStart ?? currentValue.length
  const selectionEnd = input.selectionEnd ?? currentValue.length
  messageInput.value = `${currentValue.slice(0, selectionStart)}${emoji}${currentValue.slice(selectionEnd)}`

  await nextTick()

  const caretPosition = selectionStart + emoji.length
  input.focus()
  input.setSelectionRange(caretPosition, caretPosition)
}

const handleMessageEmojiSelection = (selection: TwemojiPickerSelection) => {
  const emoji = selection.i
  if (!emoji) {
    return
  }

  void insertEmojiIntoMessageDraft(emoji)
  closeMessageEmojiPicker()
}

const appendPendingMessageAttachments = (files: FileList | File[]) => {
  const nextFiles = Array.from(files)
  if (nextFiles.length === 0) return
  pendingMessageAttachments.value = [...pendingMessageAttachments.value, ...nextFiles]
}

const onMessageAttachmentPicked = (event: Event) => {
  const target = event.target as HTMLInputElement | null
  if (target?.files?.length) {
    appendPendingMessageAttachments(target.files)
  }
  if (target) {
    target.value = ''
  }
}

const removePendingMessageAttachment = (index: number) => {
  pendingMessageAttachments.value = pendingMessageAttachments.value.filter((_, currentIndex) => currentIndex !== index)
}

const onMessageInputPaste = (event: ClipboardEvent) => {
  const files = Array.from(event.clipboardData?.files || [])
  if (files.length === 0 || isReadOnlyRssChannel.value) return
  event.preventDefault()
  appendPendingMessageAttachments(files)
}

const handleDocumentPointerDown = (event: PointerEvent) => {
  if (!messageEmojiPickerOpen.value) {
    return
  }

  const target = event.target
  if (!(target instanceof Node)) {
    return
  }

  if (messageEmojiPickerRef.value?.contains(target)) {
    return
  }

  closeMessageEmojiPicker()
}

watch(activeTextChannel, () => {
  closeMessageEmojiPicker()
})

watch(isSendingMessage, (value) => {
  if (value) {
    closeMessageEmojiPicker()
  }
})

watch(isReadOnlyRssChannel, (value) => {
  if (value) {
    closeMessageEmojiPicker()
  }
})

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
})

const submitMessage = async () => {
  if (isReadOnlyRssChannel.value || !activeTextChannel.value || isSendingMessage.value) {
    return
  }

  const trimmedMessage = messageInput.value.trim()
  if (!trimmedMessage && pendingMessageAttachments.value.length === 0) {
    return
  }

  isSendingMessage.value = true
  try {
    if (pendingMessageAttachments.value.length > 0) {
      await chatStore.sendMessageWithAttachments(activeTextChannel.value.id, trimmedMessage, pendingMessageAttachments.value, replyDraftMessage.value?.id || null)
    } else {
      chatStore.sendMessage(activeTextChannel.value.id, trimmedMessage, replyDraftMessage.value?.id || null)
    }
    messageInput.value = ''
    pendingMessageAttachments.value = []
    clearReplyDraft()
  } finally {
    isSendingMessage.value = false
    chatStore.clearPendingMessageUploadProgress()
  }
}

const getReplyAuthorName = (message: Message | MessageReplyReference | null | undefined) => message?.user?.username || 'Unknown User'

const getReplyPreviewText = (message: Message | MessageReplyReference | null | undefined) => {
  if (!message) return ''
  const content = message.content.trim()
  if (content) return content
  if (message.attachments?.length) {
    return message.attachments.length === 1 ? '1 attachment' : `${message.attachments.length} attachments`
  }
  return 'Message'
}

const getAttachmentDisplayLabel = (attachment: MessageAttachment) => attachment.original_name

const getAttachmentMimeType = (attachment: MessageAttachment) => attachment.mime_type?.split(';', 1)[0]?.trim().toLowerCase() || ''

const getAttachmentExtension = (attachment: MessageAttachment) => {
  const rawFileName = attachment.original_name || attachment.url || ''
  const normalizedFileName = rawFileName.split(/[?#]/, 1)[0]?.trim() || ''
  const dotIndex = normalizedFileName.lastIndexOf('.')

  if (dotIndex <= 0 || dotIndex === normalizedFileName.length - 1) {
    return ''
  }

  return normalizedFileName.slice(dotIndex + 1).trim().toLowerCase()
}

const isInlineImageAttachment = (attachment: MessageAttachment) => {
  const mimeType = getAttachmentMimeType(attachment)
  if (mimeType.startsWith('image/')) {
    return mimeType !== 'image/svg+xml'
  }
  return ['apng', 'avif', 'bmp', 'gif', 'ico', 'cur', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'png', 'webp'].includes(getAttachmentExtension(attachment))
}

const isInlineVideoAttachment = (attachment: MessageAttachment) => {
  const mimeType = getAttachmentMimeType(attachment)
  if (mimeType.startsWith('video/')) {
    return ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'].includes(mimeType)
  }
  return ['mp4', 'webm', 'ogv', 'mov'].includes(getAttachmentExtension(attachment))
}

const isInlineAudioAttachment = (attachment: MessageAttachment) => {
  const mimeType = getAttachmentMimeType(attachment)
  if (mimeType.startsWith('audio/')) {
    return ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac', 'audio/aac'].includes(mimeType)
  }
  return ['mp3', 'm4a', 'ogg', 'oga', 'wav', 'weba', 'flac', 'aac'].includes(getAttachmentExtension(attachment))
}

const getAttachmentInlineKind = (attachment: MessageAttachment): 'image' | 'video' | 'audio' | null => {
  const attachmentUrl = attachment.url?.trim()
  if (!attachmentUrl) return null
  if (isInlineImageAttachment(attachment)) return 'image'
  if (isInlineVideoAttachment(attachment)) return 'video'
  if (isInlineAudioAttachment(attachment)) return 'audio'
  return null
}

const isInlineAttachment = (attachment: MessageAttachment) => getAttachmentInlineKind(attachment) !== null

const openMessageAttachment = async (attachment: MessageAttachment, event: MouseEvent) => {
  const attachmentUrl = attachment.url?.trim()
  if (!attachmentUrl) {
    event.preventDefault()
    return
  }

  event.preventDefault()
  const opened = await openExternalUrl(attachmentUrl)
  if (!opened && !window.open(attachmentUrl, '_blank', 'noopener,noreferrer')) {
    window.location.href = attachmentUrl
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
  generic: 'text-zinc-400'
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

const normalizeDisplayDate = (dateString: string) => {
  const normalizedDateString = /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(dateString)
    ? dateString
    : `${dateString}Z`

  return new Date(normalizedDateString)
}

const formatTime = (dateString: string) => {
  const date = normalizeDisplayDate(dateString)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const formatDateDivider = (dateString: string) => {
  const date = normalizeDisplayDate(dateString)
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
  const date = normalizeDisplayDate(dateString)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

const resolveMessageAvatarUrl = (message: Message) => {
  const user = message.user
  if (!user) {
    return null
  }

  if (user.role === 'system') {
    return chatStore.resolveServerIconUrl(chatStore.server?.iconPath || null, undefined, chatStore.server?.updatedAt || null) || user.avatar_url
  }

  return user.avatar_url
}

const getMessageRoleColor = (message: Message) => {
  const roleKey = message.user?.role || 'all_users'
  return chatStore.getServerRoleColor(roleKey)
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
    closeMessageContextMenu()
    preserveScrollOnNextRender.value = false
    isFetchingOlderMessages.value = false
    messageInput.value = ''
    pendingMessageAttachments.value = []
    clearReplyDraft()
    await nextTick()
    scrollToBottom()
  }
)

watch(
  () => chatStore.activeChannelMessages.some((message) => message.id === messageContextMenu.value.message?.id),
  (isMessageStillVisible) => {
    if (!isMessageStillVisible) {
      closeMessageContextMenu()
    }
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
  <div class="flex-1 flex flex-col h-full bg-zinc-950">
    <template v-if="activeTextChannel">
      <!-- Chat Header -->
      <header class="h-12 border-b border-white/5 flex items-center px-4 shadow-sm shrink-0 bg-zinc-950/80 backdrop-blur-md relative z-10">
        <h2 class="font-bold text-white flex items-center text-[15px]">
          <span class="text-zinc-500 text-lg mr-1.5 font-medium">#</span>
          {{ activeTextChannel.name }}
        </h2>
      </header>

      <!-- Chat Messages Area -->
      <main ref="messagesContainer" class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-1.5 custom-scrollbar bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-900/40 via-zinc-950 to-zinc-950" @scroll.passive="onMessagesScroll">
          <div v-if="isFetchingOlderMessages" class="text-center text-xs text-zinc-400 py-1 font-medium">Loading older messages...</div>
          <div v-if="chatStore.activeChannelMessages.length === 0" class="flex flex-col justify-end h-full pb-6">
            <div class="w-14 h-14 rounded-2xl bg-zinc-900 border border-white/5 flex items-center justify-center mb-4 shadow-sm">
              <span class="text-2xl text-zinc-400 font-medium">#</span>
            </div>
            <h1 class="text-2xl font-bold text-white mb-1.5 tracking-tight">Welcome to #{{ activeTextChannel.name }}!</h1>
            <p class="text-zinc-400 text-sm">This is the start of the #{{ activeTextChannel.name }} channel.</p>
          </div>

        <template v-for="entry in activeChannelEntries" :key="entry.key">
          <div v-if="entry.type === 'divider'" class="flex items-center gap-3 py-2">
            <hr class="flex-1 border-t border-white/10" />
            <span class="text-[11px] uppercase tracking-wide text-zinc-500 font-bold">{{ entry.label }}</span>
            <hr class="flex-1 border-t border-white/10" />
          </div>

          <div
            v-else
            class="flex items-start gap-3 hover:bg-zinc-900/40 py-1 px-2 -mx-2 rounded-lg transition-colors duration-100 group"
            @contextmenu.stop.prevent="openMessageContextMenu($event, entry.message)"
          >
            <AppAvatar
              :src="resolveMessageAvatarUrl(entry.message)"
              :fallback="entry.message.user?.username || 'Unknown User'"
              wrapper-class="w-10 h-10 rounded-full bg-indigo-500/20 text-indigo-200 shrink-0 flex items-center justify-center font-bold mt-0.5 overflow-visible"
              image-class="w-full h-full object-cover rounded-full"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline gap-2 mb-[1px]">
                <span
                  class="font-semibold text-[14px] cursor-pointer transition-colors hover:brightness-110"
                  :style="{ color: getMessageRoleColor(entry.message) || '#e4e4e7' }"
                >{{ entry.message.user?.username || 'Unknown User' }}</span>
                <span class="text-[10px] font-medium text-zinc-500 group-hover:text-zinc-400">{{ formatTime(entry.message.created_at) }}</span>
              </div>
              <div v-if="entry.message.reply_to_message" class="mb-1 flex max-w-[420px] items-center gap-2 rounded-md border border-white/5 bg-zinc-900/50 px-2.5 py-1.5">
                <Reply class="w-3.5 h-3.5 shrink-0 text-zinc-500" />
                <div class="min-w-0">
                  <p class="text-[11px] font-medium text-zinc-400 truncate">{{ getReplyAuthorName(entry.message.reply_to_message) }}</p>
                  <p class="text-[12px] text-zinc-500 truncate">{{ getReplyPreviewText(entry.message.reply_to_message) }}</p>
                </div>
              </div>
              <p
                v-if="entry.message.content && !shouldHideMessageContent(entry.message)"
                class="text-zinc-300 whitespace-pre-wrap break-words leading-[1.35] text-[14px]"
                v-html="formatMessageContentWithLinks(entry.message.content)"
              ></p>
              <div v-if="entry.message.attachments?.length" class="mt-2 space-y-2">
                <div
                  v-for="attachment in entry.message.attachments"
                  :key="attachment.id"
                  class="max-w-[420px] space-y-2"
                >
                  <div
                    v-if="getAttachmentInlineKind(attachment) === 'video' || getAttachmentInlineKind(attachment) === 'audio'"
                    class="media-attachment-embed"
                    :class="{
                      'media-attachment-embed--audio': getAttachmentInlineKind(attachment) === 'audio'
                    }"
                  >
                    <div v-if="getAttachmentInlineKind(attachment) === 'audio'" class="media-attachment-embed__meta">
                      <p class="media-attachment-embed__title">{{ getAttachmentDisplayLabel(attachment) }}</p>
                      <p class="media-attachment-embed__subtitle">{{ formatFileSize(attachment.size_bytes) }}</p>
                    </div>
                    <MessageAttachmentVideoPlayer
                      v-if="getAttachmentInlineKind(attachment) === 'video'"
                      :src="attachment.url || ''"
                      :title="getAttachmentDisplayLabel(attachment)"
                    />
                    <audio
                      v-else
                      :src="attachment.url || ''"
                      class="media-attachment-embed__media media-attachment-embed__media--audio"
                      controls
                      preload="metadata"
                    ></audio>
                  </div>
                  <img
                    v-if="getAttachmentInlineKind(attachment) === 'image'"
                    :src="attachment.url || ''"
                    :alt="attachment.original_name"
                    class="block max-h-[420px] max-w-full rounded-lg border border-white/10 bg-zinc-950/60 object-contain"
                    loading="lazy"
                  />
                  <a
                    v-if="getAttachmentInlineKind(attachment) !== 'audio'"
                    :href="attachment.url || '#'"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center gap-3 rounded-lg border border-white/10 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800/80"
                    @click="openMessageAttachment(attachment, $event)"
                  >
                    <component :is="getFolderFileIcon(attachment.original_name)" class="w-4 h-4 shrink-0" :class="getFolderFileIconClass(attachment.original_name)" />
                    <div class="min-w-0 flex-1">
                      <p class="truncate">{{ getAttachmentDisplayLabel(attachment) }}</p>
                      <p class="text-xs text-zinc-500">{{ formatFileSize(attachment.size_bytes) }}</p>
                    </div>
                    <span v-if="isInlineAttachment(attachment)" class="shrink-0 text-[11px] uppercase tracking-wide text-zinc-500">Open</span>
                  </a>
                </div>
              </div>
              <div v-if="getMessageEmbeds(entry.message).length > 0" class="mt-2 space-y-2">
                <div
                  v-for="(embed, embedIndex) in getMessageEmbeds(entry.message)"
                  :key="`${entry.message.id}-embed-${embedIndex}`"
                  :class="getEmbedContainerClass(embed)"
                >
                  <iframe
                    v-if="getTrustedEmbedIframeSrc(embed)"
                    :src="getTrustedEmbedIframeSrc(embed) || ''"
                    :class="getEmbedIframeClass(embed)"
                    loading="lazy"
                    referrerpolicy="strict-origin-when-cross-origin"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen
                    sandbox="allow-same-origin allow-scripts allow-popups allow-presentation allow-popups-to-escape-sandbox"
                  />

                  <a
                    v-else-if="embed.type === 'x'"
                    :href="embed.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="block p-4 hover:bg-[#17181c] transition-colors"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <p class="text-xs uppercase tracking-wide text-sky-400">{{ embed.provider }}</p>
                        <p class="mt-1 text-sm font-semibold text-white truncate">{{ getXPostMeta(embed)?.authorName || embed.title }}</p>
                        <p v-if="getXPostMeta(embed)" class="mt-1 text-xs text-zinc-400 break-all">
                          @{{ getXPostMeta(embed)?.username }} · Post {{ getXPostMeta(embed)?.postId }}
                        </p>
                        <p v-if="embed.description" class="mt-3 text-sm leading-6 text-zinc-200 whitespace-pre-wrap break-words">{{ embed.description }}</p>
                        <img
                          v-if="getXEmbedMediaSrc(embed) && embed.mediaType === 'image'"
                          :src="getXEmbedMediaSrc(embed) || ''"
                          alt="X post media"
                          class="mt-3 max-h-[420px] w-full rounded-xl object-cover"
                          loading="lazy"
                        />
                        <div
                          v-else-if="getXEmbedMediaSrc(embed) && embed.mediaType === 'video'"
                          class="mt-3 overflow-hidden rounded-xl border border-[#3f4147] bg-black"
                        >
                          <img
                            :src="getXEmbedMediaSrc(embed) || ''"
                            alt="X post video preview"
                            class="max-h-[420px] w-full object-cover"
                            loading="lazy"
                          />
                          <div class="flex items-center justify-between gap-3 border-t border-[#3f4147] px-3 py-2 text-xs text-zinc-300">
                            <span>Video preview</span>
                            <span class="rounded-full border border-[#4a4d55] px-2 py-1 uppercase tracking-wide">Open on X</span>
                          </div>
                        </div>
                        <p class="mt-2 text-xs text-blue-300 truncate">{{ embed.displayUrl }}</p>
                      </div>
                      <div class="shrink-0 rounded-full border border-[#3f4147] px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-300">
                        Open
                      </div>
                    </div>
                  </a>

                  <a
                    v-if="shouldShowEmbedFallbackLink(embed)"
                    :href="embed.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-stretch gap-3 p-3 hover:bg-[#30343b] transition-colors"
                  >
                    <img
                      v-if="embed.thumbnailUrl"
                      :src="embed.thumbnailUrl"
                      :alt="embed.title"
                      class="w-20 h-20 object-cover rounded-md shrink-0"
                      loading="lazy"
                    />
                    <div class="min-w-0 flex-1">
                      <p class="text-xs uppercase tracking-wide text-gray-400">{{ embed.provider }}</p>
                      <p class="text-sm font-medium text-white truncate">{{ embed.title }}</p>
                      <p v-if="embed.description" class="text-xs text-gray-300 line-clamp-2 mt-1">{{ embed.description }}</p>
                      <p class="text-xs text-blue-300 truncate mt-1">{{ embed.displayUrl }}</p>
                    </div>
                  </a>
                </div>
              </div>
              <div v-if="getMessageReactions(entry.message).length > 0" class="mt-2 flex flex-wrap gap-2">
                  <button
                    v-for="reaction in getMessageReactions(entry.message)"
                    :key="`${entry.message.id}-${reaction.emoji}`"
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm transition-all duration-150"
                    :class="reaction.reacted_by_current_user
                      ? 'border-indigo-300/45 bg-indigo-400/20 text-indigo-100 shadow-indigo-950/20 hover:bg-indigo-400/26'
                      : 'border-white/10 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80'"
                    @click="toggleMessageReaction(entry.message, reaction.emoji)"
                  >
                  <span v-twemoji="reaction.emoji" class="inline-flex items-center"></span>
                  <span>{{ reaction.count }}</span>
                </button>
              </div>
            </div>
          </div>
        </template>
      </main>

      <div
        v-if="messageContextMenu.visible"
        ref="messageContextMenuRef"
        class="fixed z-50 w-56 rounded-xl border border-white/10 bg-zinc-950 shadow-2xl py-1 backdrop-blur-md"
        :style="{ left: `${messageContextMenu.x}px`, top: `${messageContextMenu.y}px` }"
        role="menu"
        @click.stop
        @contextmenu.stop
        >
          <div
            v-if="messageContextMenu.message && canReactToMessage(messageContextMenu.message)"
            class="px-3 py-2 border-b border-white/5"
          >
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Add reaction</p>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="emoji in MESSAGE_REACTION_OPTIONS"
                :key="emoji"
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-zinc-900/70 text-base text-zinc-200 transition-colors hover:bg-zinc-800/80"
                role="menuitem"
                @click="toggleReactionFromContextMenu(emoji)"
              >
                <span v-twemoji="emoji" class="inline-flex items-center justify-center"></span>
              </button>
            </div>
          </div>
          <button
            v-if="messageContextMenu.message && canReplyToMessage(messageContextMenu.message)"
            type="button"
          class="w-full px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors"
          role="menuitem"
          @click="startReplyFromContextMenu"
        >
          <Reply class="w-4 h-4" />
          Reply
        </button>
        <button
          v-if="messageContextMenu.message && canDeleteMessage(messageContextMenu.message)"
          type="button"
          class="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-zinc-900/80 flex items-center gap-2 font-medium transition-colors"
          role="menuitem"
          @click="deleteMessageFromContextMenu"
        >
          <Trash2 class="w-4 h-4" />
          Delete message
        </button>
      </div>

      <!-- Chat Input Area -->
      <div class="p-4 pt-1 shrink-0 bg-zinc-950 relative z-10">
        <input
          ref="messageAttachmentInput"
          type="file"
          multiple
          class="hidden"
          @change="onMessageAttachmentPicked"
        />
        <div v-if="replyDraftMessage" class="mb-2 flex items-start justify-between gap-3 rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-2.5">
          <div class="min-w-0">
            <p class="text-xs font-semibold text-indigo-300">Replying to {{ getReplyAuthorName(replyDraftMessage) }}</p>
            <p class="text-xs text-zinc-400 truncate">{{ getReplyPreviewText(replyDraftMessage) }}</p>
          </div>
          <button
            type="button"
            class="rounded-md p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            @click="clearReplyDraft"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
        <div v-if="pendingMessageAttachments.length > 0" class="mb-2 space-y-2 rounded-lg border border-white/5 bg-zinc-900/40 p-2.5">
          <div
            v-for="(attachment, attachmentIndex) in pendingMessageAttachments"
            :key="`${attachment.name}-${attachment.size}-${attachmentIndex}`"
            class="flex items-center gap-3 rounded-md bg-zinc-900/70 px-3 py-2"
          >
            <component :is="getFolderFileIcon(attachment.name)" class="w-4 h-4 shrink-0" :class="getFolderFileIconClass(attachment.name)" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-zinc-200">{{ attachment.name }}</p>
              <p class="text-xs text-zinc-500">{{ formatFileSize(attachment.size) }}</p>
            </div>
            <button
              type="button"
              class="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              @click="removePendingMessageAttachment(attachmentIndex)"
            >
              Remove
            </button>
          </div>
        </div>
        <div v-if="pendingAttachmentUploadSummary" class="mb-2 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2.5">
          <div class="flex items-center justify-between gap-3 text-xs text-indigo-100">
            <span>
              Uploading {{ pendingAttachmentUploadSummary.fileCount }} {{ pendingAttachmentUploadSummary.fileCount === 1 ? 'attachment' : 'attachments' }}
            </span>
            <span>{{ pendingAttachmentUploadSummary.percent }}%</span>
          </div>
          <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div class="h-full rounded-full bg-indigo-400 transition-[width] duration-150" :style="{ width: `${pendingAttachmentUploadSummary.percent}%` }"></div>
          </div>
          <p class="mt-2 text-[11px] text-indigo-200/80">
            {{ formatFileSize(pendingAttachmentUploadSummary.loadedBytes) }} / {{ formatFileSize(pendingAttachmentUploadSummary.totalBytes) }}
          </p>
        </div>
        <div class="bg-zinc-900/60 border border-white/5 rounded-lg py-2.5 px-3 flex items-center gap-2.5 shadow-sm focus-within:ring-1 focus-within:ring-indigo-500/50 focus-within:border-indigo-500/30 transition-all duration-200 focus-within:bg-zinc-900/90" :class="isReadOnlyRssChannel ? 'opacity-80' : ''">
          <button type="button" class="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-700 shrink-0 transition-colors disabled:opacity-50" :disabled="isReadOnlyRssChannel || isSendingMessage" @click="onOpenMessageAttachmentPicker">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
          </button>
          <div class="message-input-shell">
            <input 
              ref="messageInputElement"
              v-model="messageInput"
              @paste="onMessageInputPaste"
              @keyup.enter="sendMessage"
              type="text" 
              :placeholder="messagePlaceholder"
              :disabled="isReadOnlyRssChannel || isSendingMessage"
              class="message-input-native bg-transparent border-none outline-none flex-1 text-[14px]"
            />
          </div>
          <div ref="messageEmojiPickerRef" class="relative shrink-0">
            <button
              type="button"
              class="w-8 h-8 rounded-full bg-zinc-800/80 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors disabled:opacity-50"
              :disabled="isReadOnlyRssChannel || isSendingMessage"
              :aria-expanded="messageEmojiPickerOpen"
              aria-haspopup="dialog"
              aria-label="Open emoji picker"
              @click="toggleMessageEmojiPicker"
            >
              <span v-twemoji="'😊'" class="text-base leading-none inline-flex items-center"></span>
            </button>

            <div v-if="messageEmojiPickerOpen" class="absolute bottom-full right-0 mb-3 w-[22rem] overflow-hidden rounded-xl border border-white/10 bg-zinc-900 shadow-2xl z-20">
              <div class="flex items-center justify-between px-3 pt-3">
                <span class="text-xs font-bold uppercase tracking-widest text-zinc-400">Pick an emoji</span>
                <button
                  type="button"
                  class="text-xs font-medium text-zinc-400 hover:text-white transition-colors"
                  @click="closeMessageEmojiPicker"
                >
                  Close
                </button>
              </div>
              <div class="px-3 pb-3 pt-2">
                <p class="mb-3 text-xs text-zinc-500">Browse the full emoji set by category and insert directly into your current draft.</p>
                <div class="emoji-picker-panel">
                  <EmojiPicker :options="sharedEmojiPickerOptions" @select="handleMessageEmojiSelection" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <p v-if="isReadOnlyRssChannel" class="mt-2 text-xs text-gray-400">
          RSS feed channels are read-only for normal users.
        </p>
      </div>
    </template>

    <template v-else-if="activeFolderChannel">
      <header class="h-14 border-b border-white/5 flex items-center justify-between px-6 shadow-sm shrink-0 bg-zinc-950/80 backdrop-blur-md relative z-10">
        <h2 class="font-bold text-white flex items-center text-[15px]">
          <span v-twemoji="'📁'" class="text-zinc-500 text-lg mr-1.5 font-medium inline-flex items-center"></span>
          {{ activeFolderChannel.name }}
        </h2>
        <div class="flex items-center gap-2">
          <div class="flex items-center rounded-lg border border-white/5 bg-zinc-900/50 p-0.5">
            <button
              type="button"
              class="px-2.5 py-1 text-xs rounded-md text-zinc-400 transition-colors font-medium"
              :class="folderViewMode === 'list' ? 'bg-zinc-800 text-white shadow-sm' : 'hover:bg-zinc-800/50 hover:text-zinc-300'"
              @click="folderViewMode = 'list'"
            >
              List
            </button>
            <button
              type="button"
              class="px-2.5 py-1 text-xs rounded-md text-zinc-400 transition-colors font-medium"
              :class="folderViewMode === 'tiles' ? 'bg-zinc-800 text-white shadow-sm' : 'hover:bg-zinc-800/50 hover:text-zinc-300'"
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

        <div v-if="activeFolderFiles.length === 0" class="h-full flex flex-col items-center justify-center text-zinc-500">
          <Folder class="w-16 h-16 mb-4 opacity-20" />
          <p class="text-sm font-medium">No files in this folder yet.</p>
        </div>

        <div v-else-if="folderViewMode === 'list'" class="space-y-2">
          <div
            v-for="file in activeFolderFiles"
            :key="file.id"
            class="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-zinc-900/60 px-4 py-3 hover:bg-zinc-900/80 transition-colors"
          >
            <div class="min-w-0 flex items-center gap-4">
              <div class="w-10 h-10 rounded-lg bg-zinc-800 border border-white/5 flex items-center justify-center shrink-0 shadow-sm group-hover:bg-zinc-700 transition-colors">
                <component
                  :is="getFolderFileIcon(file.original_name)"
                  class="w-5 h-5"
                  :class="getFolderFileIconClass(file.original_name)"
                />
              </div>
              <div class="min-w-0">
                <p class="truncate text-[13px] text-zinc-200 font-bold group-hover:text-white transition-colors">{{ file.original_name }}</p>
                <div class="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 mt-0.5">
                  <span class="bg-zinc-800 px-1.5 py-0.5 border border-white/5 rounded text-zinc-400">{{ formatFileSize(file.size_bytes) }}</span>
                  <span>•</span>
                  <span>{{ file.uploader_username || 'Unknown uploader' }}</span>
                  <span>•</span>
                  <span>{{ formatTime(file.created_at) }}</span>
                </div>
              </div>
            </div>
            <div class="shrink-0 flex items-center gap-2">
              <button
                type="button"
                class="px-3 py-1.5 text-[13px] font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors"
                @click="requestFolderFileDownload(file.id)"
              >
                Download
              </button>
              <button
                v-if="canManageFolderFiles"
                type="button"
                class="px-3 py-1.5 text-[13px] font-medium rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-colors"
                @click="requestFolderFileDelete(file.id, file.original_name)"
              >
                Delete
              </button>
            </div>
          </div>
        </div>

        <div v-else class="grid gap-4 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] p-2">
          <div
            v-for="file in activeFolderFiles"
            :key="file.id"
            class="group relative rounded-xl border border-white/5 bg-zinc-900/60 p-4 flex flex-col items-center justify-center hover:bg-zinc-800/80 hover:border-white/10 transition-all duration-300 shadow-sm overflow-hidden min-h-[160px]"
          >
            <div class="w-full flex flex-col items-center justify-center text-center gap-3 transition-transform duration-300 group-hover:-translate-y-2">
              <div class="flex justify-center items-center w-16 h-16 rounded-2xl bg-zinc-800 border border-white/5 shadow-sm text-zinc-400 group-hover:scale-110 group-hover:bg-zinc-700 transition-all duration-300">
                <component
                  :is="getFolderFileIcon(file.original_name)"
                  class="w-8 h-8 shrink-0"
                  :class="getFolderFileIconClass(file.original_name)"
                />
              </div>
              <div class="w-full">
                <p class="w-full truncate text-[13px] text-zinc-200 font-bold px-1 group-hover:text-white transition-colors" :title="file.original_name">{{ file.original_name }}</p>
                <p class="w-full text-[11px] font-medium text-zinc-500 mt-1 truncate px-1" :title="`${file.uploader_username || 'Unknown uploader'} • ${formatTime(file.created_at)}`">
                  {{ formatFileSize(file.size_bytes) }}
                </p>
              </div>
            </div>
            
            <div class="absolute inset-x-0 bottom-0 p-3 pt-6 w-full flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-300 bg-gradient-to-t from-zinc-950 via-zinc-900/90 to-transparent translate-y-2 group-hover:translate-y-0" :class="canManageFolderFiles ? 'grid grid-cols-2' : 'flex justify-center'">
              <button
                type="button"
                class="w-full flex justify-center items-center py-1.5 text-xs font-bold rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white transition-colors shadow-sm"
                @click="requestFolderFileDownload(file.id)"
                title="Download"
              >
                Download
              </button>
              <button
                v-if="canManageFolderFiles"
                type="button"
                class="w-full flex justify-center items-center py-1.5 text-xs font-bold rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors shadow-sm"
                @click="requestFolderFileDelete(file.id, file.original_name)"
                title="Delete"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </main>
    </template>

    <template v-else-if="activeVoiceChannel">
      <header class="h-14 border-b border-white/5 flex items-center px-6 shadow-sm shrink-0 bg-zinc-950">
        <h2 class="font-bold text-white flex items-center">
          <span v-twemoji="'🔊'" class="text-zinc-500 text-xl mr-2 inline-flex items-center"></span>
          {{ activeVoiceChannel.name }}
        </h2>
      </header>

        <main class="flex min-h-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-900/40 via-zinc-950 to-zinc-950">
        <section class="flex min-h-0 flex-1 flex-col px-6 pt-6 pb-24 md:px-8 md:pt-8">
          <div v-if="visibleVoiceParticipants.length > 0" :class="voiceGridClass" class="grid auto-rows-fr gap-4 overflow-y-auto custom-scrollbar pr-1 md:gap-5">
          <div
            v-for="user in visibleVoiceParticipants"
            :key="user.id"
            class="group relative flex flex-col overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/80 shadow-lg"
            :class="voiceTileClass"
          >
            <div class="absolute inset-0 bg-indigo-500/5 transition-opacity duration-300" :class="getAvatarBadgeType(user.id, false) === 'speaking' ? 'opacity-100' : 'opacity-0'"></div>
            <div
              v-show="getUserScreenStream(user.id)"
              :ref="(el) => setScreenContainerRef(user.id, el)"
              class="screen-stream-wrapper relative h-full min-h-0 flex-1 bg-black"
              @click="onScreenVideoClick(user.id)"
              @contextmenu.prevent.stop="openScreenContextMenu($event, user.id)"
            >
              <video
                :ref="(el) => setScreenVideoTemplateRef(user.id, el)"
                :muted="webrtcStore.isScreenStreamMuted(user.id)"
                :volume.prop="webrtcStore.getScreenStreamVolume(user.id)"
                autoplay
                playsinline
                class="screen-stream-video h-full w-full cursor-pointer bg-black object-contain"
              />

              <div
                class="screen-stream-overlay absolute bottom-3 left-3 right-3 z-20 flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-950/90 backdrop-blur-md px-3 py-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 shadow-xl"
                @click.stop
                @contextmenu.stop
              >
                <button
                  type="button"
                  class="screen-stream-control w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center justify-center text-zinc-300 hover:text-white transition-colors"
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
            <div v-show="!getUserScreenStream(user.id)" class="flex h-full min-h-0 flex-1 items-center justify-center px-6 py-8">
              <AppAvatar
                :src="user.avatar_url"
                :fallback="user.username"
                wrapper-class="relative flex h-28 w-28 items-center justify-center overflow-visible rounded-full bg-zinc-800 text-4xl font-bold text-zinc-400 transition-all duration-300 md:h-32 md:w-32"
                image-class="h-full w-full object-cover rounded-full"
                :class="getAvatarBadgeType(user.id, false) === 'speaking' ? 'ring-4 ring-green-500 shadow-[0_0_20px_rgba(34,197,94,0.3)] bg-indigo-500/20 text-indigo-400' : 'shadow-sm'"
              />
            </div>
          </div>
        </div>

        <div v-else class="flex h-full min-h-[16rem] items-center justify-center rounded-2xl border border-dashed border-white/10 bg-zinc-900/35 px-6 text-center text-zinc-500 font-medium">
          {{ hideVoiceMembersWithoutScreenshare ? 'No visible members match the current filter.' : 'No participants in this voice channel.' }}
        </div>
        </section>
      </main>

      <div class="absolute bottom-4 left-1/2 z-30 w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 rounded-2xl border border-white/10 bg-zinc-950/92 px-4 py-3 shadow-2xl backdrop-blur-md">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Voice panel</p>
            <p class="mt-1 truncate text-sm font-medium text-white">Hide members without active screen share</p>
          </div>

          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors"
            :class="hideVoiceMembersWithoutScreenshare ? 'border-indigo-400/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20' : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white'"
            :aria-pressed="hideVoiceMembersWithoutScreenshare"
            @click="toggleHideVoiceMembersWithoutScreenshare"
          >
            <span class="relative h-5 w-9 rounded-full transition-colors" :class="hideVoiceMembersWithoutScreenshare ? 'bg-indigo-400/70' : 'bg-zinc-700'">
              <span class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform" :class="hideVoiceMembersWithoutScreenshare ? 'translate-x-4.5' : 'translate-x-0.5'"></span>
            </span>
            {{ hideVoiceMembersWithoutScreenshare ? 'On' : 'Off' }}
          </button>
        </div>
      </div>

      <div
        v-if="screenContextMenu.visible"
        ref="screenContextMenuRef"
        class="fixed z-50 min-w-[200px] rounded-xl border border-white/10 bg-zinc-950 p-1.5 shadow-2xl backdrop-blur-md"
        :style="{ left: `${screenContextMenu.x}px`, top: `${screenContextMenu.y}px` }"
        role="menu"
      >
        <template v-if="screenContextMenu.isOwner && screenContextMenu.userId">
          <div class="px-3 pb-1.5 pt-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">FPS</div>
          <button
            v-for="option in screenFpsOptions"
            :key="option.value"
            type="button"
            class="flex w-full items-center justify-between px-3 py-2 rounded-md text-sm text-left text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors"
            :class="webrtcStore.getScreenStreamFps(screenContextMenu.userId) === option.value ? 'bg-zinc-900/50 text-white font-medium' : ''"
            role="menuitemradio"
            :aria-checked="webrtcStore.getScreenStreamFps(screenContextMenu.userId) === option.value"
            @click="onSelectScreenFps(option.value)"
          >
            <span>{{ option.label }}</span>
            <span v-if="webrtcStore.getScreenStreamFps(screenContextMenu.userId) === option.value" class="text-indigo-400">✓</span>
          </button>

          <div class="my-1.5 border-t border-white/5 mx-2"></div>
          <div class="px-3 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Resolution</div>
          <button
            v-for="option in getScreenResolutionOptions(screenContextMenu.userId)"
            :key="option.value"
            type="button"
            class="flex w-full items-center justify-between px-3 py-2 rounded-md text-sm text-left text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors"
            :class="webrtcStore.getScreenStreamResolution(screenContextMenu.userId) === option.value ? 'bg-zinc-900/50 text-white font-medium' : ''"
            role="menuitemradio"
            :aria-checked="webrtcStore.getScreenStreamResolution(screenContextMenu.userId) === option.value"
            @click="onSelectScreenResolution(option.value)"
          >
            <span>{{ option.label }}</span>
            <span v-if="webrtcStore.getScreenStreamResolution(screenContextMenu.userId) === option.value" class="text-indigo-400">✓</span>
          </button>
        </template>

        <button
          v-else
          type="button"
          class="w-full px-3 py-2 rounded-md text-sm text-left text-zinc-300 hover:bg-zinc-900 hover:text-white font-medium transition-colors"
          role="menuitem"
          @click="onToggleLocalScreenMute"
        >
          {{ screenContextMenu.userId && webrtcStore.isScreenStreamMuted(screenContextMenu.userId) ? 'Unmute stream' : 'Mute stream' }}
        </button>
      </div>
    </template>
    
    <template v-else>
      <div class="flex-1 flex items-center justify-center flex-col text-zinc-500 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-900/30 via-zinc-950 to-zinc-950">
        <div class="w-32 h-32 mb-8 flex items-center justify-center opacity-40 mix-blend-plus-lighter">
          <RougeCordMark :size="128" />
        </div>
        <h2 class="text-2xl font-bold text-white mb-3 tracking-tight">No Channel Selected</h2>
        <p class="text-[15px] max-w-md text-center">Select a channel from the sidebar to start chatting in RougeCord.</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.screen-stream-wrapper:fullscreen,
.screen-stream-wrapper:-webkit-full-screen {
  width: 100vw;
  height: 100vh;
  background: #000;
  border-radius: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
}

.screen-stream-wrapper:fullscreen .screen-stream-video,
.screen-stream-wrapper:-webkit-full-screen .screen-stream-video {
  width: 100%;
  height: 100%;
  max-width: 100vw;
  max-height: 100vh;
  border-radius: 0 !important;
  object-fit: contain;
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
  bottom: 32px;
  left: 50%;
  right: auto;
  transform: translateX(-50%);
  width: max-content;
  max-width: 90vw;
}
</style>

<style scoped>
.screen-stream-wrapper:fullscreen,
.screen-stream-wrapper:-webkit-full-screen {
  width: 100vw;
  height: 100vh;
  background: #000;
  border-radius: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
}

.screen-stream-wrapper:fullscreen .screen-stream-video,
.screen-stream-wrapper:-webkit-full-screen .screen-stream-video {
  width: 100%;
  height: 100%;
  max-width: 100vw;
  max-height: 100vh;
  border-radius: 0 !important;
  object-fit: contain;
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
  bottom: 32px;
  left: 50%;
  right: auto;
  transform: translateX(-50%);
  width: max-content;
  max-width: 90vw;
}
</style>

