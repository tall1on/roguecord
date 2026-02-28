<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  visible: boolean
  serverName: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const inviteLink = computed(() => {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || 'localhost'
  const port = window.location.port ? `:${window.location.port}` : ''
  return `${protocol}//${host}${port}`
})

const copyInviteLink = () => {
  navigator.clipboard.writeText(inviteLink.value)
  emit('update:visible', false)
}
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
    <div class="bg-zinc-950 border border-white/10 p-6 rounded-xl shadow-2xl w-[400px]">
      <h2 class="text-xl font-bold text-white mb-2">Invite friends to {{ serverName }}</h2>
      <p class="text-zinc-400 mb-4 text-sm">Share this link with others to grant them access to this server.</p>

      <div class="mb-6">
        <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Server Invite Link</label>
        <div class="flex bg-zinc-900 border border-white/5 rounded-lg p-1 focus-within:ring-1 focus-within:ring-indigo-500 transition-all">
          <input type="text" readonly :value="inviteLink" class="w-full bg-transparent text-white p-2 focus:outline-none text-sm" />
          <button @click="copyInviteLink" class="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-md text-sm font-medium transition-colors duration-200">
            Copy
          </button>
        </div>
      </div>

      <div class="flex justify-end pt-2 border-t border-white/5">
        <button @click="emit('update:visible', false)" class="text-zinc-400 hover:text-white font-medium text-sm transition-colors duration-200">Close</button>
      </div>
    </div>
  </div>
</template>
