<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Hash, Volume2, Settings, Link, Trash2, Plus, MicOff, Headphones, PhoneOff, Mic } from 'lucide-vue-next'
import { useChatStore, type Channel, type User } from '../../stores/chat'
import { useWebRtcStore } from '../../stores/webrtc'

type VoiceParticipant = User & {
  isMuted?: boolean
  isDeafened?: boolean
}

const props = defineProps<{
  isAdmin: boolean
}>()

const emit = defineEmits<{
  (e: 'open-server-settings'): void
  (e: 'open-invite'): void
  (e: 'remove-server'): void
  (e: 'open-admin'): void
  (e: 'open-create-channel', payload: { categoryId: string | null; type?: 'text' | 'voice' }): void
}>()

const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()

const showVoiceStats = ref(false)
const voiceStatsContainerRef = ref<HTMLElement | null>(null)

const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuChannel = ref<Channel | null>(null)

const activeServer = computed(() => {
  if (chatStore.activeConnectionId) {
    const connection = chatStore.savedConnections.find((c) => c.id === chatStore.activeConnectionId)
    if (connection) {
      return { name: connection.name }
    }
  }
  return { name: 'RogueCord Server' }
})

const handleClickOutside = (event: MouseEvent) => {
  if (showVoiceStats.value && voiceStatsContainerRef.value && !voiceStatsContainerRef.value.contains(event.target as Node)) {
    showVoiceStats.value = false
  }

  if (contextMenuVisible.value) {
    const target = event.target as HTMLElement | null
    if (!target?.closest('.channel-context-menu')) {
      contextMenuVisible.value = false
      contextMenuChannel.value = null
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
  if (channel.type === 'text') {
    return chatStore.activeMainPanel.type === 'text' && chatStore.activeMainPanel.channelId === channel.id
  }

  if (channel.type === 'voice') {
    return chatStore.activeMainPanel.type === 'voice' && chatStore.activeMainPanel.channelId === channel.id
  }

  return false
}

const handleChannelClick = (channel: Channel) => {
  if (channel.type === 'text') {
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
  contextMenuVisible.value = true
}

const openChannelContextMenu = (event: MouseEvent, channel: Channel) => {
  if (!props.isAdmin) return

  event.preventDefault()
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuChannel.value = channel
  contextMenuVisible.value = true
}

const deleteChannelFromContextMenu = () => {
  if (!props.isAdmin || !contextMenuChannel.value) return

  const channelToDelete = contextMenuChannel.value
  if (!confirm(`Delete #${channelToDelete.name}? This cannot be undone.`)) {
    return
  }

  contextMenuVisible.value = false
  contextMenuChannel.value = null
  chatStore.deleteChannel(channelToDelete.id)
}

const openCreateChannelFromContextMenu = (type: 'text' | 'voice') => {
  if (!props.isAdmin) return

  contextMenuVisible.value = false
  contextMenuChannel.value = null
  emit('open-create-channel', { categoryId: null, type })
}

const isVoiceUserSpeaking = (userId: string) => webrtcStore.isUserSpeaking(userId)
</script>

<template>
  <aside class="w-60 bg-[#2b2d31] flex flex-col shrink-0">
    <template v-if="chatStore.activeConnectionId">
      <header
        v-if="activeServer"
        class="h-12 px-4 flex items-center justify-between shadow-sm border-b border-[#1e1f22] hover:bg-[#35373c] cursor-pointer transition-colors shrink-0"
      >
        <h1 class="font-bold text-white truncate">{{ activeServer.name }}</h1>
        <div class="flex items-center gap-3">
          <button v-if="isAdmin" class="text-gray-400 hover:text-white" title="Server Settings" @click.stop="emit('open-server-settings')">
            <Settings class="w-4 h-4" />
          </button>
          <button class="text-gray-400 hover:text-white" title="Invite People" @click.stop="emit('open-invite')">
            <Link class="w-4 h-4" />
          </button>
          <button class="text-gray-400 hover:text-red-500" title="Remove Server" @click.stop="emit('remove-server')">
            <Trash2 class="w-4 h-4" />
          </button>
        </div>
      </header>
      <header v-else class="h-12 px-4 flex items-center shadow-sm border-b border-[#1e1f22] shrink-0">
        <h1 class="font-bold text-white truncate">No Server Selected</h1>
      </header>

      <div class="flex-1 overflow-y-auto p-2 space-y-[2px] custom-scrollbar" @contextmenu.prevent="openChannelListContextMenu">
        <template v-if="true">
          <div v-for="category in chatStore.activeServerCategories" :key="category.id">
            <div class="pt-4 pb-1 px-2 flex items-center justify-between group cursor-pointer">
              <div class="flex items-center text-xs font-semibold text-gray-400 group-hover:text-gray-300 uppercase tracking-wider">
                <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                {{ category.name }}
              </div>
              <button v-if="isAdmin" class="text-gray-400 hover:text-gray-200 opacity-0 group-hover:opacity-100" @click.stop="emit('open-create-channel', { categoryId: category.id })">
                <Plus class="w-4 h-4" />
              </button>
            </div>

            <div
              v-for="channel in chatStore.activeServerChannels.filter(c => c.category_id === category.id)"
              :key="channel.id"
            >
              <div
                class="flex items-center px-2 py-1.5 rounded cursor-pointer group mb-[2px]"
                :class="isChannelActive(channel) ? 'bg-[#404249] text-white' : 'hover:bg-[#35373c] text-gray-400 hover:text-gray-300'"
                @click="handleChannelClick(channel)"
                @contextmenu.stop.prevent="openChannelContextMenu($event, channel)"
              >
                <Hash v-if="channel.type === 'text'" class="w-5 h-5 mr-1.5 text-gray-400 group-hover:text-gray-300" />
                <Volume2 v-else class="w-5 h-5 mr-1.5 text-gray-400 group-hover:text-gray-300" />
                <span class="truncate font-medium">{{ channel.name }}</span>
              </div>

              <div v-if="channel.type === 'voice' && webrtcStore.channelParticipants.get(channel.id)?.length" class="pl-8 pr-2 pb-2 space-y-1">
                <div v-for="user in (webrtcStore.channelParticipants.get(channel.id) as VoiceParticipant[])" :key="user.id" class="flex items-center text-gray-300 text-sm">
                  <div class="relative w-6 h-6 rounded-full bg-indigo-500 mr-2 flex items-center justify-center text-xs font-bold text-white overflow-hidden" :class="isVoiceUserSpeaking(user.id) ? 'ring-2 ring-green-400 ring-offset-1 ring-offset-[#2b2d31]' : ''">
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

          <div v-if="chatStore.activeServerChannels.filter(c => !c.category_id).length > 0">
            <div class="pt-4 pb-1 px-2 flex items-center justify-between group cursor-pointer">
              <div class="text-xs font-semibold text-gray-400 group-hover:text-gray-300 uppercase tracking-wider">
                Channels
              </div>
              <button v-if="isAdmin" class="text-gray-400 hover:text-gray-200 opacity-0 group-hover:opacity-100" @click.stop="emit('open-create-channel', { categoryId: null })">
                <Plus class="w-4 h-4" />
              </button>
            </div>
            <div
              v-for="channel in chatStore.activeServerChannels.filter(c => !c.category_id)"
              :key="channel.id"
            >
              <div
                class="flex items-center px-2 py-1.5 rounded cursor-pointer group mb-[2px]"
                :class="isChannelActive(channel) ? 'bg-[#404249] text-white' : 'hover:bg-[#35373c] text-gray-400 hover:text-gray-300'"
                @click="handleChannelClick(channel)"
                @contextmenu.stop.prevent="openChannelContextMenu($event, channel)"
              >
                <Hash v-if="channel.type === 'text'" class="w-5 h-5 mr-1.5 text-gray-400 group-hover:text-gray-300" />
                <Volume2 v-else class="w-5 h-5 mr-1.5 text-gray-400 group-hover:text-gray-300" />
                <span class="truncate font-medium">{{ channel.name }}</span>
              </div>

              <div v-if="channel.type === 'voice' && webrtcStore.channelParticipants.get(channel.id)?.length" class="pl-8 pr-2 pb-2 space-y-1">
                <div v-for="user in (webrtcStore.channelParticipants.get(channel.id) as VoiceParticipant[])" :key="user.id" class="flex items-center text-gray-300 text-sm">
                  <div class="relative w-6 h-6 rounded-full bg-indigo-500 mr-2 flex items-center justify-center text-xs font-bold text-white overflow-hidden" :class="isVoiceUserSpeaking(user.id) ? 'ring-2 ring-green-400 ring-offset-1 ring-offset-[#2b2d31]' : ''">
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
        class="channel-context-menu fixed z-50 w-56 rounded-md border border-[#1e1f22] bg-[#111214] shadow-xl py-1"
        :style="{ left: `${contextMenuX}px`, top: `${contextMenuY}px` }"
      >
        <button
          v-if="contextMenuChannel"
          class="w-full px-3 py-2 text-left text-sm text-red-300 hover:bg-[#2b2d31] flex items-center gap-2"
          @click="deleteChannelFromContextMenu"
        >
          <Trash2 class="w-4 h-4" />
          Delete channel
        </button>
        <div v-if="contextMenuChannel" class="my-1 border-t border-[#2b2d31]"></div>
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

    <div v-if="webrtcStore.activeVoiceChannelId" ref="voiceStatsContainerRef" class="relative">
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
        <button class="w-8 h-8 flex items-center justify-center rounded hover:bg-[#3f4147] text-gray-400 hover:text-red-400 transition-colors" title="Disconnect" @click.stop="webrtcStore.leaveVoiceChannel()">
          <PhoneOff class="w-5 h-5" />
        </button>
      </div>

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
              <div
                v-for="(p, i) in webrtcStore.pingHistory"
                :key="i"
                class="flex-1 rounded-t-sm min-w-[2px]"
                :style="{ height: `${Math.min(100, Math.max(5, (p / 300) * 100))}%` }"
                :class="{
                  'bg-green-500': p < 100,
                  'bg-orange-500': p >= 100 && p < 250,
                  'bg-red-500': p >= 250
                }"
              >
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

    <div v-if="chatStore.currentUser" class="h-[52px] bg-[#232428] px-2 flex items-center shrink-0">
      <div class="flex items-center hover:bg-[#3f4147] p-1 rounded cursor-pointer flex-1 min-w-0">
        <div class="w-8 h-8 rounded-full bg-indigo-500 relative shrink-0 flex items-center justify-center text-white font-bold" :class="isVoiceUserSpeaking(chatStore.currentUser.id) ? 'ring-2 ring-green-400 ring-offset-1 ring-offset-[#232428]' : ''">
          {{ chatStore.currentUser.username.charAt(0).toUpperCase() }}
          <div class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-[#232428]" :class="isVoiceUserSpeaking(chatStore.currentUser.id) ? 'bg-green-400' : 'bg-green-500'"></div>
        </div>
        <div class="ml-2 flex-1 min-w-0">
          <div class="text-sm font-semibold text-white truncate">{{ chatStore.currentUser.username }}</div>
          <div class="text-xs text-gray-400 truncate">Online</div>
        </div>
      </div>
      <div class="flex items-center gap-1 ml-1">
        <button class="w-8 h-8 flex items-center justify-center rounded hover:bg-[#3f4147] text-gray-400 hover:text-gray-300" title="Admin Access" @click="emit('open-admin')">
          <Settings class="w-5 h-5" />
        </button>
        <button class="w-8 h-8 flex items-center justify-center rounded hover:bg-[#3f4147] transition-colors" :class="webrtcStore.isMuted || webrtcStore.isDeafened ? 'text-red-500 hover:text-red-400' : 'text-gray-400 hover:text-gray-300'" :title="webrtcStore.isMuted || webrtcStore.isDeafened ? 'Unmute' : 'Mute'" @click="webrtcStore.toggleMute()">
          <MicOff v-if="webrtcStore.isMuted || webrtcStore.isDeafened" class="w-5 h-5" />
          <Mic v-else class="w-5 h-5" />
        </button>
        <button class="w-8 h-8 flex items-center justify-center rounded hover:bg-[#3f4147] transition-colors relative" :class="webrtcStore.isDeafened ? 'text-red-500 hover:text-red-400' : 'text-gray-400 hover:text-gray-300'" :title="webrtcStore.isDeafened ? 'Undeafen' : 'Deafen'" @click="webrtcStore.toggleDeafen()">
          <Headphones class="w-5 h-5" />
          <div v-if="webrtcStore.isDeafened" class="absolute w-6 h-[2px] bg-red-500 rotate-45 rounded-full"></div>
        </button>
      </div>
    </div>
  </aside>
</template>
