<script setup lang="ts">
import { computed } from 'vue'
import { useChatStore } from '../../../stores/chat'

type ServerSettingsNavItem = {
  id: string
  label: string
}

type ServerSettingsNavGroup = {
  id: string
  label: string
  expanded: boolean
  items: ServerSettingsNavItem[]
}

const visible = defineModel<boolean>('visible', { required: true })
const form = defineModel<{ title: string; rulesChannelId: string; welcomeChannelId: string }>('form', { required: true })

defineProps<{
  activeSection: string
  navGroups: ServerSettingsNavGroup[]
}>()

const emit = defineEmits<{
  (e: 'toggle-group', groupId: string): void
  (e: 'select-section', sectionId: string): void
  (e: 'save'): void
}>()

const chatStore = useChatStore()
const textChannels = computed(() => chatStore.activeServerChannels.filter((c) => c.type === 'text'))
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-[2px] p-2 sm:p-4 flex items-center justify-center">
    <div class="bg-zinc-950 border border-white/5 w-full h-full sm:h-[95vh] max-w-[1400px] mx-auto rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row">
      <aside class="w-full md:w-72 md:min-w-72 bg-zinc-900 border-b md:border-b-0 md:border-r border-white/5 p-4 overflow-y-auto custom-scrollbar flex flex-col gap-1">
        <h2 class="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 px-2">Server Settings</h2>

        <nav class="space-y-3">
          <div v-for="group in navGroups" :key="group.id" class="space-y-1">
            <button
              class="w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-bold text-zinc-400 uppercase tracking-wider hover:text-zinc-200 transition-colors"
              @click="emit('toggle-group', group.id)"
            >
              <span>{{ group.label }}</span>
              <span class="text-[10px]">{{ group.expanded ? '▼' : '▶' }}</span>
            </button>

            <div v-if="group.expanded" class="space-y-0.5 mt-1">
              <button
                v-for="item in group.items"
                :key="item.id"
                class="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200"
                :class="activeSection === item.id ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'"
                @click="emit('select-section', item.id)"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
        </nav>
      </aside>

      <div class="flex-1 flex flex-col min-h-0 bg-zinc-950/50 relative">
        <div class="absolute top-6 right-6 z-10">
          <button class="w-8 h-8 flex items-center justify-center rounded-full border border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-white hover:border-zinc-700 transition-all duration-200" @click="visible = false">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        <div class="px-8 pt-8 pb-4">
          <h3 class="text-2xl font-bold text-white tracking-tight">
            {{ activeSection === 'general-settings' ? 'Server Overview' : 'Server Settings' }}
          </h3>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar px-8 py-2">
          <div v-if="activeSection === 'general-settings'" class="space-y-6 max-w-2xl">
            <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
              <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Server Title</label>
              <input
                v-model="form.title"
                type="text"
                class="w-full bg-zinc-950 text-white p-2.5 rounded-lg border border-white/10 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all font-medium"
                placeholder="My Server"
              />
              <p class="text-zinc-500 text-xs mt-2">This title is shown across the UI for this server.</p>
            </div>

            <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm space-y-5">
              <div>
                <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Rules or guidelines channel</label>
                <div class="relative">
                  <select
                    v-model="form.rulesChannelId"
                    class="w-full bg-zinc-950 text-sm font-medium text-white rounded-lg px-3 py-2.5 border border-white/10 appearance-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                  >
                    <option value="">None</option>
                    <option
                      v-for="channel in textChannels"
                      :key="channel.id"
                      :value="channel.id"
                    >
                      # {{ channel.name }}
                    </option>
                  </select>
                  <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-zinc-400">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                  </div>
                </div>
                <p class="text-zinc-500 text-xs mt-2">Select a channel where members can read the server rules.</p>
              </div>

              <div class="pt-5 border-t border-white/5">
                <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Welcome Channel</label>
                <div class="relative">
                  <select
                    v-model="form.welcomeChannelId"
                    class="w-full bg-zinc-950 text-sm font-medium text-white rounded-lg px-3 py-2.5 border border-white/10 appearance-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                  >
                    <option value="">None</option>
                    <option
                      v-for="channel in textChannels"
                      :key="channel.id"
                      :value="channel.id"
                    >
                      # {{ channel.name }}
                    </option>
                  </select>
                  <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-zinc-400">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                  </div>
                </div>
                <p class="text-zinc-500 text-xs mt-2">Select a channel where new members will be welcomed.</p>
              </div>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-3 px-8 py-5 border-t border-white/5 bg-zinc-950/80 backdrop-blur-sm">
          <button class="text-zinc-400 hover:text-white text-sm font-medium px-4 py-2 transition-colors" @click="visible = false">Cancel</button>
          <button class="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors duration-200 shadow-sm" @click="emit('save')">Save Changes</button>
        </div>
      </div>
    </div>
  </div>
</template>
