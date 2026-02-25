<script setup lang="ts">
const username = defineModel<string>('username', { required: true })

defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'login'): void
}>()
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
    <div class="bg-[#313338] p-8 rounded-lg shadow-xl w-96 text-center">
      <h2 class="text-2xl font-bold text-white mb-2">Welcome back!</h2>
      <p class="text-gray-400 mb-6">We're so excited to see you again!</p>

      <div class="text-left mb-4">
        <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Username</label>
        <input
          v-model="username"
          type="text"
          class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="Enter your username"
          @keyup.enter="emit('login')"
        />
      </div>

      <button
        class="w-full bg-indigo-500 hover:bg-indigo-600 text-white font-semibold py-2.5 rounded transition-colors"
        @click="emit('login')"
      >
        Log In
      </button>
    </div>
  </div>
</template>
