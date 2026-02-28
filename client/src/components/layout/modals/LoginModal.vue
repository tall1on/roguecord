<script setup lang="ts">
import RougeCordMark from '../../branding/RougeCordMark.vue'

const username = defineModel<string>('username', { required: true })

defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'login'): void
}>()
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
    <div class="bg-zinc-950 border border-white/10 p-8 rounded-xl shadow-2xl w-96 text-center">
      <div class="w-12 h-12 mx-auto mb-4">
        <RougeCordMark :size="48" class="text-white" />
      </div>
      <h2 class="text-2xl font-bold text-white mb-2 tracking-tight">Welcome to RougeCord</h2>
      <p class="text-zinc-400 mb-6 text-sm">Connect to your own communities without platform lock-in.</p>

      <div class="text-left mb-6">
        <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Username</label>
        <div class="relative bg-zinc-900 border border-white/5 rounded-lg focus-within:ring-1 focus-within:ring-indigo-500 transition-all flex items-center">
          <input
            v-model="username"
            type="text"
            class="w-full bg-transparent text-white p-2.5 focus:outline-none text-sm placeholder:text-zinc-600 font-medium"
            placeholder="Enter your username"
            @keyup.enter="emit('login')"
          />
        </div>
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
