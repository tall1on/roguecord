<script setup lang="ts">
const visible = defineModel<boolean>('visible', { required: true })
const serverName = defineModel<string>('serverName', { required: true })
const serverAddress = defineModel<string>('serverAddress', { required: true })

const emit = defineEmits<{
  (e: 'create'): void
}>()
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
    <div class="bg-[#313338] p-6 rounded-lg shadow-xl w-96">
      <h2 class="text-2xl font-bold text-white mb-4 text-center">Add a Connection</h2>
      <p class="text-gray-400 mb-6 text-center text-sm">Connect to a new server.</p>

      <div class="mb-4">
        <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Connection Name</label>
        <input
          v-model="serverName"
          type="text"
          class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="My Server"
        />
      </div>

      <div class="mb-6">
        <label class="block text-xs font-bold text-gray-300 uppercase mb-2">WebSocket Address</label>
        <input
          v-model="serverAddress"
          type="text"
          class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="wss://localhost:3000"
          @keyup.enter="emit('create')"
        />
      </div>

      <div class="flex justify-between items-center">
        <button class="text-gray-400 hover:text-white text-sm" @click="visible = false">Back</button>
        <button class="bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-2 rounded font-medium" @click="emit('create')">Add</button>
      </div>
    </div>
  </div>
</template>
