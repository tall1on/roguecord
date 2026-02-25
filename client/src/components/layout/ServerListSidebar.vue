<script setup lang="ts">
import { Plus } from 'lucide-vue-next'
import { useChatStore } from '../../stores/chat'

const emit = defineEmits<{
  (e: 'open-create-server'): void
}>()

const chatStore = useChatStore()
</script>

<template>
  <nav class="w-[72px] bg-[#1e1f22] flex flex-col items-center py-3 gap-2 shrink-0 overflow-y-auto no-scrollbar">
    <div class="w-12 h-12 rounded-[24px] hover:rounded-[16px] bg-[#313338] hover:bg-indigo-500 text-white flex items-center justify-center transition-all duration-200 cursor-pointer group">
      <svg class="w-7 h-7 text-gray-300 group-hover:text-white" fill="currentColor" viewBox="0 0 24 24">
        <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.21.4-.4.8-.58 1.21-1.69-.25-3.4-.25-5.1 0-.18-.41-.37-.82-.59-1.2-1.6.27-3.14.75-4.6 1.43A19.04 19.04 0 0 0 1.96 19.58c2.09 1.52 4.1 2.44 6.09 3.04.5-.66.95-1.36 1.35-2.09-1.08-.4-2.1-.89-3.06-1.46.26-.19.51-.39.75-.6 3.9 1.79 8.18 1.79 12.06 0 .24.21.49.41.75.6-.96.57-1.98 1.06-3.06 1.46.4.73.85 1.43 1.35 2.09 2-.6 4.01-1.52 6.1-3.04a19.02 19.02 0 0 0-2.32-14.71zM8.52 16.28c-1.21 0-2.21-1.08-2.21-2.4 0-1.33.98-2.4 2.21-2.4 1.23 0 2.23 1.07 2.21 2.4 0 1.32-.98 2.4-2.21 2.4zm6.96 0c-1.21 0-2.21-1.08-2.21-2.4 0-1.33.98-2.4 2.21-2.4 1.23 0 2.23 1.07 2.21 2.4 0 1.32-.98 2.4-2.21 2.4z"/>
      </svg>
    </div>

    <div class="w-8 h-[2px] bg-[#35363c] rounded-full my-1"></div>

    <div
      v-for="connection in chatStore.savedConnections"
      :key="connection.id"
      class="relative flex items-center justify-center w-full group cursor-pointer"
      @click="chatStore.connect(connection.address)"
    >
      <div
        class="absolute left-0 w-1 bg-white rounded-r-full transition-all duration-200"
        :class="chatStore.activeConnectionId === connection.id ? 'h-10' : 'h-2 opacity-0 group-hover:opacity-100 group-hover:h-5'"
      ></div>

      <div
        class="w-12 h-12 flex items-center justify-center transition-all duration-200 font-bold text-lg overflow-hidden"
        :class="chatStore.activeConnectionId === connection.id ? 'rounded-[16px] bg-indigo-500 text-white' : 'rounded-[24px] hover:rounded-[16px] bg-[#313338] hover:bg-indigo-500 text-gray-100'"
      >
        <img v-if="connection.iconUrl" :src="connection.iconUrl" alt="Server Icon" class="w-full h-full object-cover" />
        <span v-else>{{ connection.name.charAt(0).toUpperCase() }}</span>
      </div>
    </div>

    <div
      class="w-12 h-12 rounded-[24px] hover:rounded-[16px] bg-[#313338] hover:bg-green-500 text-green-500 hover:text-white flex items-center justify-center transition-all duration-200 cursor-pointer mt-2"
      @click="emit('open-create-server')"
    >
      <Plus class="w-6 h-6" />
    </div>
  </nav>
</template>
