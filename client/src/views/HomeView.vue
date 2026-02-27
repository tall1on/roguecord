<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useChatStore, type Message } from '../stores/chat'
import { useWebRtcStore } from '../stores/webrtc'

const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()
const messageInput = ref('')
const messagesContainer = ref<HTMLElement | null>(null)
const preserveScrollOnNextRender = ref(false)
const previousScrollHeight = ref(0)
const isFetchingOlderMessages = ref(false)

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

const getUserScreenStream = (userId: string) => webrtcStore.userScreenStreams.get(userId) || null

const setScreenVideoRef = (userId: string, el: Element | null) => {
  const video = el as HTMLVideoElement | null
  if (!video) {
    screenVideoElements.delete(userId)
    return
  }

  screenVideoElements.set(userId, video)
  video.srcObject = getUserScreenStream(userId)
}

const enterScreenFullscreen = async (userId: string) => {
  const video = screenVideoElements.get(userId)
  if (!video) return

  try {
    await video.requestFullscreen()
  } catch (_e) {
    // no-op
  }
}

watch(
  () => webrtcStore.userScreenStreams,
  (streams) => {
    for (const [userId, el] of screenVideoElements.entries()) {
      const nextStream = streams.get(userId) || null
      if (el.srcObject !== nextStream) {
        el.srcObject = nextStream
      }
    }

    const fsEl = document.fullscreenElement as HTMLVideoElement | null
    if (fsEl) {
      let isActiveShare = false
      for (const stream of streams.values()) {
        if (fsEl.srcObject === stream) {
          isActiveShare = true
          break
        }
      }

      if (!isActiveShare) {
        void document.exitFullscreen().catch(() => {})
      }
    }
  },
  { deep: false }
)

onBeforeUnmount(() => {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
  }
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

const sendMessage = () => {
  if (isReadOnlyRssChannel.value) {
    return
  }

  if (messageInput.value.trim() && activeTextChannel.value) {
    chatStore.sendMessage(activeTextChannel.value.id, messageInput.value.trim())
    messageInput.value = ''
  }
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
              <p class="text-gray-300 whitespace-pre-wrap break-words">{{ entry.message.content }}</p>
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
            class="rounded-xl bg-[#2b2d31] border border-[#3f4147] flex items-center justify-center"
            :class="voiceTileClass"
          >
            <video
              v-if="getUserScreenStream(user.id)"
              :ref="(el) => setScreenVideoRef(user.id, el)"
              autoplay
              playsinline
              class="w-full h-full object-contain rounded-xl bg-black cursor-pointer"
              @click="enterScreenFullscreen(user.id)"
            />
            <div v-else class="relative w-20 h-20 rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white font-bold text-3xl" :class="getAvatarBadgeType(user.id, false) === 'speaking' ? 'ring-4 ring-green-400 ring-offset-2 ring-offset-[#2b2d31]' : ''">
              <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover" />
              <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
            </div>
          </div>
        </div>

        <div v-else class="h-full flex items-center justify-center text-gray-400">
          No participants in this voice channel.
        </div>
      </main>
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
