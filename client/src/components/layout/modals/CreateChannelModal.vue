<script setup lang="ts">
import { Folder, Hash, Rss, Volume2 } from 'lucide-vue-next'

const visible = defineModel<boolean>('visible', { required: true })
const channelName = defineModel<string>('channelName', { required: true })
const channelType = defineModel<'text' | 'voice' | 'rss' | 'folder'>('channelType', { required: true })
const channelFeedUrl = defineModel<string>('channelFeedUrl', { required: true })

defineProps<{
  errorMessage: string | null
}>()

const emit = defineEmits<{
  (e: 'create'): void
}>()
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
    <div class="bg-[#313338] p-6 rounded-lg shadow-xl w-96">
      <h2 class="text-xl font-bold text-white mb-4">Create Channel</h2>

      <div class="mb-4">
        <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Channel Type</label>
        <div class="space-y-2">
          <label class="flex items-center p-3 bg-[#2b2d31] rounded cursor-pointer hover:bg-[#3f4147]">
            <input v-model="channelType" type="radio" value="text" class="mr-3 text-indigo-500 focus:ring-indigo-500 bg-[#1e1f22] border-gray-600">
            <Hash class="w-5 h-5 text-gray-400 mr-2" />
            <div>
              <div class="text-white font-medium">Text</div>
              <div class="text-xs text-gray-400">Send messages, images, GIFs, emoji, opinions, and puns</div>
            </div>
          </label>
          <label class="flex items-center p-3 bg-[#2b2d31] rounded cursor-pointer hover:bg-[#3f4147]">
            <input v-model="channelType" type="radio" value="voice" class="mr-3 text-indigo-500 focus:ring-indigo-500 bg-[#1e1f22] border-gray-600">
            <Volume2 class="w-5 h-5 text-gray-400 mr-2" />
            <div>
              <div class="text-white font-medium">Voice</div>
              <div class="text-xs text-gray-400">Hang out together with voice, video, and screen share</div>
            </div>
          </label>
          <label class="flex items-center p-3 bg-[#2b2d31] rounded cursor-pointer hover:bg-[#3f4147]">
            <input v-model="channelType" type="radio" value="rss" class="mr-3 text-indigo-500 focus:ring-indigo-500 bg-[#1e1f22] border-gray-600">
            <Rss class="w-5 h-5 text-gray-400 mr-2" />
            <div>
              <div class="text-white font-medium">RSS</div>
              <div class="text-xs text-gray-400">Automatically post updates from an RSS/Atom feed</div>
            </div>
          </label>
          <label class="flex items-center p-3 bg-[#2b2d31] rounded cursor-pointer hover:bg-[#3f4147]">
            <input v-model="channelType" type="radio" value="folder" class="mr-3 text-indigo-500 focus:ring-indigo-500 bg-[#1e1f22] border-gray-600">
            <Folder class="w-5 h-5 text-gray-400 mr-2" />
            <div>
              <div class="text-white font-medium">Folder</div>
              <div class="text-xs text-gray-400">Upload and download files in a shared folder channel</div>
            </div>
          </label>
        </div>
      </div>

      <div class="mb-6">
        <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Channel Name</label>
        <div class="relative">
          <Hash v-if="channelType === 'text'" class="w-4 h-4 text-gray-400 absolute left-3 top-3" />
          <Volume2 v-else-if="channelType === 'voice'" class="w-4 h-4 text-gray-400 absolute left-3 top-3" />
          <Rss v-else-if="channelType === 'rss'" class="w-4 h-4 text-gray-400 absolute left-3 top-3" />
          <Folder v-else class="w-4 h-4 text-gray-400 absolute left-3 top-3" />
          <input
            v-model="channelName"
            type="text"
            class="w-full bg-[#1e1f22] text-white p-2.5 pl-9 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="new-channel"
            @keyup.enter="emit('create')"
          />
        </div>
        <div v-if="channelType === 'rss'" class="mt-3">
          <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Feed URL</label>
          <input
            v-model="channelFeedUrl"
            type="url"
            class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="https://example.com/feed.xml"
            @keyup.enter="emit('create')"
          />
        </div>
        <p v-if="errorMessage" class="mt-2 text-xs text-red-400">
          {{ errorMessage }}
        </p>
      </div>

      <div class="flex justify-end gap-4">
        <button class="text-gray-400 hover:text-white text-sm" @click="visible = false">Cancel</button>
        <button class="bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-2 rounded font-medium" @click="emit('create')">Create Channel</button>
      </div>
    </div>
  </div>
</template>
