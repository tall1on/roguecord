<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useChatStore } from '../stores/chat'

const chatStore = useChatStore()
const messageInput = ref('')
const messagesContainer = ref<HTMLElement | null>(null)

const activeChannel = computed(() => {
  if (!chatStore.activeServerId || !chatStore.activeChannelId) return null
  const channels = chatStore.channels[chatStore.activeServerId] || []
  return channels.find(c => c.id === chatStore.activeChannelId)
})

const sendMessage = () => {
  if (messageInput.value.trim() && chatStore.activeChannelId) {
    chatStore.sendMessage(chatStore.activeChannelId, messageInput.value.trim())
    messageInput.value = ''
  }
}

const formatTime = (dateString: string) => {
  const date = new Date(dateString)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Auto-scroll to bottom when messages change
watch(() => chatStore.activeChannelMessages, async () => {
  await nextTick()
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}, { deep: true })
</script>

<template>
  <div class="flex-1 flex flex-col h-full bg-[#313338]">
    <template v-if="activeChannel">
      <!-- Chat Header -->
      <header class="h-12 border-b border-[#1e1f22] flex items-center px-4 shadow-sm shrink-0">
        <h2 class="font-semibold text-white flex items-center">
          <span class="text-gray-400 text-xl mr-2">#</span>
          {{ activeChannel.name }}
        </h2>
      </header>

      <!-- Chat Messages Area -->
      <main ref="messagesContainer" class="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        <div v-if="chatStore.activeChannelMessages.length === 0" class="flex flex-col justify-end h-full pb-4">
          <div class="w-16 h-16 rounded-full bg-[#4e5058] flex items-center justify-center mb-4">
            <span class="text-3xl text-white">#</span>
          </div>
          <h1 class="text-3xl font-bold text-white mb-2">Welcome to #{{ activeChannel.name }}!</h1>
          <p class="text-gray-400">This is the start of the #{{ activeChannel.name }} channel.</p>
        </div>

        <div 
          v-for="message in chatStore.activeChannelMessages" 
          :key="message.id"
          class="flex items-start gap-4 hover:bg-[#2e3035] p-1 -mx-1 rounded transition-colors"
        >
          <div class="w-10 h-10 rounded-full bg-indigo-500 shrink-0 flex items-center justify-center text-white font-bold mt-0.5">
            {{ message.user?.username.charAt(0).toUpperCase() || '?' }}
          </div>
          <div>
            <div class="flex items-baseline gap-2">
              <span class="font-medium text-white hover:underline cursor-pointer">{{ message.user?.username || 'Unknown User' }}</span>
              <span class="text-xs text-gray-400">{{ formatTime(message.created_at) }}</span>
            </div>
            <p class="text-gray-300 whitespace-pre-wrap break-words">{{ message.content }}</p>
          </div>
        </div>
      </main>

      <!-- Chat Input Area -->
      <div class="p-4 shrink-0">
        <div class="bg-[#383a40] rounded-lg p-3 flex items-center gap-3">
          <button class="w-6 h-6 rounded-full bg-[#4e5058] flex items-center justify-center text-gray-300 hover:text-white shrink-0 transition-colors">
            +
          </button>
          <input 
            v-model="messageInput"
            @keyup.enter="sendMessage"
            type="text" 
            :placeholder="`Message #${activeChannel.name}`" 
            class="bg-transparent border-none outline-none flex-1 text-gray-200 placeholder-gray-500"
          />
        </div>
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
