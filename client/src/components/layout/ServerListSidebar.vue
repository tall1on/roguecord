<script setup lang="ts">
import { Plus } from 'lucide-vue-next'
import { useChatStore } from '../../stores/chat'
import RougeCordMark from '../branding/RougeCordMark.vue'

const emit = defineEmits<{
  (e: 'open-create-server'): void
}>()

const chatStore = useChatStore()
</script>

<template>
  <nav class="w-[72px] bg-zinc-950 border-r border-white/5 flex flex-col items-center py-4 gap-3 shrink-0 overflow-y-auto no-scrollbar relative z-10 shadow-xl">
    <div
      class="w-12 h-12 rounded-[24px] hover:rounded-[16px] flex items-center justify-center transition-all duration-300 cursor-pointer group bg-zinc-900 hover:bg-indigo-600/20 shadow-sm border border-white/5 hover:border-indigo-500/30"
      title="RougeCord"
    >
      <RougeCordMark :size="48" class="text-white group-hover:text-indigo-400 transition-colors" />
    </div>

    <div class="w-8 h-[2px] bg-white/10 rounded-full my-1"></div>

    <div
      v-for="connection in chatStore.savedConnections"
      :key="connection.id"
      class="relative flex items-center justify-center w-full group cursor-pointer py-1"
      @click="chatStore.connect(connection.address)"
    >
      <div
        class="absolute left-0 w-1 bg-white rounded-r-full transition-all duration-300 ease-out"
        :class="chatStore.activeConnectionId === connection.id ? 'h-10 opacity-100' : 'h-3 opacity-0 group-hover:opacity-100 group-hover:h-6'"
      ></div>

      <div
        class="w-12 h-12 flex items-center justify-center transition-all duration-300 font-bold text-lg overflow-hidden border"
        :class="chatStore.activeConnectionId === connection.id ? 'rounded-[16px] bg-indigo-600 text-white border-indigo-500/50 shadow-lg shadow-indigo-600/20' : 'rounded-[24px] hover:rounded-[16px] bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border-white/5 hover:border-white/10 shadow-sm'"
      >
        <img v-if="connection.iconUrl" :src="connection.iconUrl" alt="Server Icon" class="w-full h-full object-cover" />
        <span v-else>{{ connection.name.charAt(0).toUpperCase() }}</span>
      </div>
    </div>

    <div
      class="w-12 h-12 rounded-[24px] hover:rounded-[16px] bg-zinc-900 hover:bg-green-500/20 text-green-500 hover:text-green-400 flex items-center justify-center transition-all duration-300 cursor-pointer mt-2 border border-white/5 hover:border-green-500/30 shadow-sm group"
      @click="emit('open-create-server')"
    >
      <Plus class="w-6 h-6 transform group-hover:rotate-90 transition-transform duration-300" />
    </div>
  </nav>
</template>
