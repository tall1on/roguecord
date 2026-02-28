<script setup lang="ts">
const visible = defineModel<boolean>('visible', { required: true })
const serverAddress = defineModel<string>('serverAddress', { required: true })

defineProps<{
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  (e: 'create'): void
}>()
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
    <div class="bg-zinc-950 border border-white/10 p-6 rounded-xl shadow-2xl w-[400px]">
      <h2 class="text-xl font-bold text-white mb-2 text-center">Add a Connection</h2>
      <p class="text-zinc-400 mb-6 text-center text-sm">Connect to a new server.</p>

      <div class="mb-6">
        <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">WebSocket Address</label>
        <div class="flex bg-zinc-900 border border-white/5 rounded-lg p-1 focus-within:ring-1 focus-within:ring-indigo-500 transition-all">
          <input
            v-model="serverAddress"
            type="text"
            class="w-full bg-transparent text-white p-2 focus:outline-none text-sm placeholder:text-zinc-600 font-mono"
            placeholder="wss://localhost:3000"
            @keyup.enter="emit('create')"
          />
        </div>
        <p v-if="errorMessage" class="mt-2 text-xs font-medium text-red-400">{{ errorMessage }}</p>
      </div>

      <div class="flex justify-between items-center pt-2 border-t border-white/5 mt-4">
        <button class="text-zinc-400 hover:text-white text-sm font-medium transition-colors duration-200" @click="visible = false">Cancel</button>
        <button class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors duration-200 shadow-sm" @click="emit('create')">Connect</button>
      </div>
    </div>
  </div>
</template>
