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
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
    <div class="bg-zinc-950 border border-white/10 p-6 rounded-xl shadow-2xl w-[440px]">
      <h2 class="text-xl font-bold text-white mb-6">Create Channel</h2>

      <div class="mb-6">
        <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">Channel Type</label>
        <div class="space-y-3">
          <label class="flex items-start p-4 bg-zinc-900 border border-white/5 rounded-xl cursor-pointer hover:bg-zinc-800/80 hover:border-white/10 transition-all" :class="channelType === 'text' ? 'ring-1 ring-indigo-500/50 bg-zinc-800/50' : ''">
            <input v-model="channelType" type="radio" value="text" class="mt-0.5 mr-4 text-indigo-500 focus:ring-indigo-500 bg-zinc-950 border-white/10">
            <Hash class="w-5 h-5 text-zinc-400 mr-3 mt-0.5" :class="channelType === 'text' ? 'text-indigo-400' : ''" />
            <div>
              <div class="text-white font-medium text-sm">Text Channel</div>
              <div class="text-xs text-zinc-500 mt-0.5 leading-relaxed">Send messages, images, GIFs, emoji, opinions, and puns</div>
            </div>
          </label>
          <label class="flex items-start p-4 bg-zinc-900 border border-white/5 rounded-xl cursor-pointer hover:bg-zinc-800/80 hover:border-white/10 transition-all" :class="channelType === 'voice' ? 'ring-1 ring-indigo-500/50 bg-zinc-800/50' : ''">
            <input v-model="channelType" type="radio" value="voice" class="mt-0.5 mr-4 text-indigo-500 focus:ring-indigo-500 bg-zinc-950 border-white/10">
            <Volume2 class="w-5 h-5 text-zinc-400 mr-3 mt-0.5" :class="channelType === 'voice' ? 'text-indigo-400' : ''" />
            <div>
              <div class="text-white font-medium">Voice</div>
              <div class="text-xs text-gray-400">Hang out together with voice, video, and screen share</div>
            </div>
          </label>
          <label class="flex items-center p-4 bg-zinc-900 border border-white/5 rounded-xl cursor-pointer hover:bg-zinc-800/80 hover:border-white/10 transition-all" :class="channelType === 'rss' ? 'ring-1 ring-indigo-500/50 bg-zinc-800/50' : ''">
            <input v-model="channelType" type="radio" value="rss" class="mt-0.5 mr-4 text-indigo-500 focus:ring-indigo-500 bg-zinc-950 border-white/10">
            <Rss class="w-5 h-5 text-zinc-400 mr-3 mt-0.5" :class="channelType === 'rss' ? 'text-indigo-400' : ''" />
            <div>
              <div class="text-white font-medium text-sm">RSS Feed</div>
              <div class="text-xs text-zinc-500 mt-0.5 leading-relaxed">Automatically post updates from an RSS/Atom feed</div>
            </div>
          </label>
          <label class="flex items-center p-4 bg-zinc-900 border border-white/5 rounded-xl cursor-pointer hover:bg-zinc-800/80 hover:border-white/10 transition-all" :class="channelType === 'folder' ? 'ring-1 ring-indigo-500/50 bg-zinc-800/50' : ''">
            <input v-model="channelType" type="radio" value="folder" class="mt-0.5 mr-4 text-indigo-500 focus:ring-indigo-500 bg-zinc-950 border-white/10">
            <Folder class="w-5 h-5 text-zinc-400 mr-3 mt-0.5" :class="channelType === 'folder' ? 'text-indigo-400' : ''" />
            <div>
              <div class="text-white font-medium text-sm">Folder</div>
              <div class="text-xs text-zinc-500 mt-0.5 leading-relaxed">Upload and download files in a shared folder channel</div>
            </div>
          </label>
        </div>
      </div>

      <div class="mb-6">
        <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Channel Name</label>
        <div class="relative bg-zinc-900 border border-white/5 rounded-lg focus-within:ring-1 focus-within:ring-indigo-500 transition-all flex items-center">
          <div class="pl-3 pr-2 text-zinc-500">
            <Hash v-if="channelType === 'text'" class="w-4 h-4" />
            <Volume2 v-else-if="channelType === 'voice'" class="w-4 h-4 text-zinc-400" />
            <Rss v-else-if="channelType === 'rss'" class="w-4 h-4 text-zinc-400" />
            <Folder v-else class="w-4 h-4 text-zinc-400" />
          </div>
          <input
            v-model="channelName"
            type="text"
            class="w-full bg-transparent text-white py-2.5 pr-3 focus:outline-none text-sm placeholder:text-zinc-600 font-medium"
            placeholder="new-channel"
            @keyup.enter="emit('create')"
          />
        </div>
        <div v-if="channelType === 'rss'" class="mt-4">
          <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Feed URL</label>
          <div class="relative bg-zinc-900 border border-white/5 rounded-lg focus-within:ring-1 focus-within:ring-indigo-500 transition-all flex items-center">
            <input
              v-model="channelFeedUrl"
              type="url"
              class="w-full bg-transparent text-white p-2.5 focus:outline-none text-sm placeholder:text-zinc-600 font-medium"
              placeholder="https://example.com/feed.xml"
              @keyup.enter="emit('create')"
            />
          </div>
        </div>
        <p v-if="errorMessage" class="mt-2 text-xs font-medium text-red-400">
          {{ errorMessage }}
        </p>
      </div>

      <div class="flex justify-end gap-3 pt-4 border-t border-white/5">
        <button class="text-zinc-400 hover:text-white text-sm font-medium px-4 py-2 transition-colors duration-200" @click="visible = false">Cancel</button>
        <button class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors duration-200 shadow-sm" @click="emit('create')">Create Channel</button>
      </div>
    </div>
  </div>
</template>
