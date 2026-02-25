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
  <div v-if="visible" class="fixed inset-0 z-50 bg-black/80 p-2 sm:p-4">
    <div class="bg-[#313338] w-full h-full sm:h-[95vh] max-w-[1400px] mx-auto rounded-lg shadow-xl overflow-hidden flex flex-col md:flex-row">
      <aside class="w-full md:w-72 md:min-w-72 bg-[#2b2d31] border-b md:border-b-0 md:border-r border-[#1e1f22] p-4 overflow-y-auto">
        <h2 class="text-xl font-bold text-white mb-4">Server Settings</h2>

        <nav class="space-y-2">
          <div v-for="group in navGroups" :key="group.id" class="space-y-1">
            <button
              class="w-full flex items-center justify-between px-2 py-1.5 rounded text-sm text-gray-300 hover:text-white hover:bg-[#3f4147] transition-colors"
              @click="emit('toggle-group', group.id)"
            >
              <span class="font-medium">{{ group.label }}</span>
              <span class="text-xs">{{ group.expanded ? '−' : '+' }}</span>
            </button>

            <div v-if="group.expanded" class="pl-2 space-y-1">
              <button
                v-for="item in group.items"
                :key="item.id"
                class="w-full text-left px-3 py-2 rounded text-sm transition-colors"
                :class="activeSection === item.id ? 'bg-[#5865F2] text-white' : 'text-gray-300 hover:text-white hover:bg-[#3f4147]'"
                @click="emit('select-section', item.id)"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
        </nav>
      </aside>

      <div class="flex-1 flex flex-col min-h-0">
        <div class="flex items-center justify-between px-6 py-4 border-b border-[#1e1f22]">
          <h3 class="text-lg font-semibold text-white">
            {{ activeSection === 'general-settings' ? 'General Settings' : 'Server Settings' }}
          </h3>
          <button class="text-gray-400 hover:text-white text-sm font-medium px-3 py-1.5" @click="visible = false">
            Close
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-6 py-5">
          <div v-if="activeSection === 'general-settings'" class="space-y-6 max-w-3xl">
            <div>
              <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Server Title</label>
              <input
                v-model="form.title"
                type="text"
                class="w-full bg-[#1e1f22] text-gray-300 rounded p-2 outline-none border border-transparent focus:border-[#5865F2]"
                placeholder="My Server"
              />
              <p class="text-gray-400 text-xs mt-1">This title is shown across the UI for this server.</p>
            </div>

            <div>
              <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Rules or guidelines channel</label>
              <select
                v-model="form.rulesChannelId"
                class="w-full bg-[#1e1f22] text-gray-300 rounded p-2 outline-none border border-transparent focus:border-[#5865F2]"
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
              <p class="text-gray-400 text-xs mt-1">Select a channel where members can read the server rules.</p>
            </div>

            <div>
              <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Welcome Channel</label>
              <select
                v-model="form.welcomeChannelId"
                class="w-full bg-[#1e1f22] text-gray-300 rounded p-2 outline-none border border-transparent focus:border-[#5865F2]"
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
              <p class="text-gray-400 text-xs mt-1">Select a channel where new members will be welcomed.</p>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-3 px-6 py-4 border-t border-[#1e1f22]">
          <button class="text-gray-400 hover:text-white text-sm font-medium px-4 py-2" @click="visible = false">Cancel</button>
          <button class="bg-[#5865F2] hover:bg-[#4752C4] text-white px-4 py-2 rounded text-sm font-medium transition-colors" @click="emit('save')">Save Changes</button>
        </div>
      </div>
    </div>
  </div>
</template>
