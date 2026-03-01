<script setup lang="ts">
import { computed, ref } from 'vue'
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
const form = defineModel<{
  title: string
  rulesChannelId: string
  welcomeChannelId: string
  storage: {
    enabled: boolean
    endpoint: string
    region: string
    bucket: string
    accessKey: string
    secretKey: string
    prefix: string
    status: 'data_dir' | 's3'
    lastError: string | null
  }
}>('form', { required: true })

defineProps<{
  activeSection: string
  navGroups: ServerSettingsNavGroup[]
  saveDisabled: boolean
  hasUnsavedChanges: boolean
  s3TestState: 'idle' | 'testing' | 'success' | 'error'
  s3TestMessage: string | null
  saveMessage: string | null
  saveError: string | null
  iconPreviewUrl: string | null
  iconError: string | null
  canRemoveIcon: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-group', groupId: string): void
  (e: 'select-section', sectionId: string): void
  (e: 'test-storage'): void
  (e: 'select-icon', file: File): void
  (e: 'remove-icon'): void
  (e: 'save'): void
}>()

const chatStore = useChatStore()
const textChannels = computed(() => chatStore.activeServerChannels.filter((c) => c.type === 'text'))
const storageStatusLabel = computed(() => (form.value.storage.status === 's3' ? 'S3 enabled' : 'data-dir enabled'))
const iconFileInput = ref<HTMLInputElement | null>(null)

const openIconPicker = () => {
  iconFileInput.value?.click()
}

const onIconInputChange = (event: Event) => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) {
    return
  }
  emit('select-icon', file)
  target.value = ''
}
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
            {{ activeSection === 'general-settings' ? 'General Settings' : activeSection === 'storage-settings' ? 'Storage / S3' : 'Server Settings' }}
          </h3>
          <button class="text-gray-400 hover:text-white text-sm font-medium px-3 py-1.5" @click="visible = false">
            Close
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-6 py-5">
          <div v-if="activeSection === 'general-settings'" class="space-y-6 max-w-3xl">
            <div>
              <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Server Icon</label>
              <div class="rounded border border-[#3f4147] bg-[#2b2d31] px-4 py-4">
                <div class="flex items-center gap-4">
                  <div class="w-16 h-16 rounded-2xl bg-[#1e1f22] overflow-hidden flex items-center justify-center text-white font-bold text-xl">
                    <img v-if="iconPreviewUrl" :src="iconPreviewUrl" alt="Server icon preview" class="w-full h-full object-cover" />
                    <span v-else>{{ (form.title || chatStore.server?.title || chatStore.server?.name || 'S').charAt(0).toUpperCase() }}</span>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <input
                      ref="iconFileInput"
                      type="file"
                      accept="image/*"
                      class="hidden"
                      @change="onIconInputChange"
                    />
                    <button
                      type="button"
                      class="bg-[#4f46e5] hover:bg-[#4338ca] text-white px-3 py-1.5 rounded text-sm font-medium transition-colors"
                      @click="openIconPicker"
                    >
                      Upload Icon
                    </button>
                    <button
                      type="button"
                      class="bg-[#4e5058] hover:bg-[#5b5e66] text-white px-3 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      :disabled="!canRemoveIcon"
                      @click="emit('remove-icon')"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <p class="text-gray-400 text-xs mt-2">Upload a square image for best results. PNG, JPG, and WEBP are supported.</p>
                <p v-if="iconError" class="text-rose-300 text-xs mt-2">{{ iconError }}</p>
              </div>
            </div>

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

          <div v-else-if="activeSection === 'storage-settings'" class="space-y-6 max-w-3xl">
            <div class="rounded border border-[#3f4147] bg-[#2b2d31] px-4 py-3">
              <p class="text-xs font-bold uppercase text-gray-300">Current storage mode</p>
              <p class="mt-1 text-sm" :class="form.storage.status === 's3' ? 'text-emerald-300' : 'text-gray-200'">
                {{ storageStatusLabel }}
              </p>
              <p class="mt-1 text-xs text-gray-400">
                Default is data-dir. S3 is only activated after the configuration has been validated successfully.
              </p>
              <p v-if="form.storage.lastError" class="mt-2 text-xs text-rose-300">
                Last storage error: {{ form.storage.lastError }}
              </p>
            </div>

            <div class="flex items-center justify-between rounded border border-[#3f4147] bg-[#2b2d31] px-4 py-3">
              <div>
                <p class="text-sm font-semibold text-white">Enable S3 storage for new uploads</p>
                <p class="text-xs text-gray-400">When enabled and valid, new files are uploaded to S3 instead of data-dir.</p>
              </div>
              <label class="inline-flex items-center cursor-pointer">
                <input v-model="form.storage.enabled" type="checkbox" class="sr-only" />
                <span class="h-6 w-11 rounded-full transition-colors" :class="form.storage.enabled ? 'bg-[#5865F2]' : 'bg-[#4e5058]'">
                  <span
                    class="block h-5 w-5 rounded-full bg-white transition-transform mt-0.5"
                    :class="form.storage.enabled ? 'translate-x-5 ml-0.5' : 'translate-x-0.5'"
                  />
                </span>
              </label>
            </div>

            <div v-show="form.storage.enabled" class="rounded border border-[#3f4147] bg-[#2b2d31] px-4 py-3">
              <p class="text-xs font-bold uppercase text-gray-300">Hetzner S3 help</p>
              <p class="mt-1 text-xs text-gray-400">
                Use Hetzner endpoint format: https://&lt;bucket-name&gt;.&lt;location&gt;.your-objectstorage.com. Bucket and location are parsed from the endpoint URL.
              </p>
              <a
                href="https://hetzner.cloud/?ref=JmdXQVT3XHM1"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-1 inline-block text-sm text-[#8ea1ff] hover:text-[#b6c2ff] underline"
              >
                Create Hetzner account / Object Storage
              </a>
            </div>

            <div v-show="form.storage.enabled" class="grid gap-4 md:grid-cols-2">
              <div>
                <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Endpoint URL</label>
                <input
                  v-model="form.storage.endpoint"
                  type="text"
                  class="w-full bg-[#1e1f22] text-gray-300 rounded p-2 outline-none border border-transparent focus:border-[#5865F2]"
                  placeholder="https://my-bucket.nbg1.your-objectstorage.com"
                />
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Prefix (optional)</label>
                <input
                  v-model="form.storage.prefix"
                  type="text"
                  class="w-full bg-[#1e1f22] text-gray-300 rounded p-2 outline-none border border-transparent focus:border-[#5865F2]"
                  placeholder="guild-a"
                />
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Access Key</label>
                <input
                  v-model="form.storage.accessKey"
                  type="text"
                  class="w-full bg-[#1e1f22] text-gray-300 rounded p-2 outline-none border border-transparent focus:border-[#5865F2]"
                  autocomplete="off"
                />
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Secret Key</label>
                <input
                  v-model="form.storage.secretKey"
                  type="password"
                  class="w-full bg-[#1e1f22] text-gray-300 rounded p-2 outline-none border border-transparent focus:border-[#5865F2]"
                  autocomplete="new-password"
                />
              </div>

              <div class="md:col-span-2 flex items-center gap-3">
                <button
                  class="bg-[#4f46e5] hover:bg-[#4338ca] disabled:bg-[#4e5058] disabled:text-gray-300 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
                  :disabled="s3TestState === 'testing'"
                  @click="emit('test-storage')"
                >
                  {{ s3TestState === 'testing' ? 'Testing...' : 'Test Connection' }}
                </button>
                <p
                  v-if="s3TestMessage"
                  class="text-xs"
                  :class="s3TestState === 'success' ? 'text-emerald-300' : s3TestState === 'error' ? 'text-rose-300' : 'text-gray-400'"
                >
                  {{ s3TestMessage }}
                </p>
              </div>
            </div>

            <p v-if="saveError" class="text-sm text-rose-300">{{ saveError }}</p>
            <p v-if="saveMessage" class="text-sm text-emerald-300">{{ saveMessage }}</p>
          </div>
        </div>

        <div class="px-6 py-4 border-t border-[#1e1f22]">
          <p
            v-if="hasUnsavedChanges"
            class="mb-3 rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200"
          >
            You have unsaved server settings changes.
          </p>
          <div class="flex justify-end gap-3">
            <button class="text-gray-400 hover:text-white text-sm font-medium px-4 py-2" @click="visible = false">Cancel</button>
            <button class="bg-[#5865F2] hover:bg-[#4752C4] disabled:bg-[#4e5058] disabled:text-gray-300 text-white px-4 py-2 rounded text-sm font-medium transition-colors" :disabled="saveDisabled" @click="emit('save')">Save Changes</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
