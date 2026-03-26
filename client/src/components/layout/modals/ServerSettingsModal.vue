<script setup lang="ts">
import { computed, ref } from 'vue'
import { useChatStore, type ServerStorageSettings } from '../../../stores/chat'

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

const props = defineProps<{
  activeSection: string
  navGroups: ServerSettingsNavGroup[]
  saveDisabled: boolean
  hasUnsavedChanges: boolean
  s3TestState: 'idle' | 'testing' | 'success' | 'error'
  s3TestMessage: string | null
  saveMessage: string | null
  saveError: string | null
  storageSettings: ServerStorageSettings
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
const migration = computed(() => props.storageSettings.migration)
const migrationVisible = computed(() => migration.value.status === 'running' || migration.value.status === 'failed')
const migrationProgressPercent = computed(() => {
  if (migration.value.total <= 0) {
    return 0
  }

  return Math.min(100, Math.max(0, Math.round((migration.value.done / migration.value.total) * 100)))
})
const migrationStatusLabel = computed(() => {
  if (migration.value.status === 'running') {
    return 'Migration in progress'
  }

  if (migration.value.status === 'failed') {
    return 'Migration failed'
  }

  return 'Migration idle'
})
const migrationStatusTone = computed(() => {
  if (migration.value.status === 'failed') {
    return 'border-rose-400/20 bg-rose-400/10'
  }

  return 'border-amber-400/20 bg-amber-400/10'
})
const migrationTargetLabel = computed(() => {
  if (migration.value.target === 's3') {
    return 'S3'
  }

  if (migration.value.target === 'data_dir') {
    return 'data-dir'
  }

  return 'Unknown'
})
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
            {{ activeSection === 'general-settings' ? 'Server Overview' : activeSection === 'storage-settings' ? 'Storage / S3' : 'Server Settings' }}
          </h3>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar px-8 py-2">
          <div v-if="activeSection === 'general-settings'" class="space-y-6 max-w-3xl">
            <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
              <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Server Icon</label>
              <div class="flex items-center gap-4">
                <div class="w-16 h-16 rounded-2xl bg-zinc-950 border border-white/10 overflow-hidden flex items-center justify-center text-white font-bold text-xl">
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
                    class="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                    @click="openIconPicker"
                  >
                    Upload Icon
                  </button>
                  <button
                    type="button"
                    class="bg-zinc-700 hover:bg-zinc-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    :disabled="!canRemoveIcon"
                    @click="emit('remove-icon')"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <p class="text-zinc-500 text-xs mt-2">Upload a square image for best results. PNG, JPG, and WEBP are supported.</p>
              <p v-if="iconError" class="text-rose-300 text-xs mt-2">{{ iconError }}</p>
            </div>

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

          <div v-else-if="activeSection === 'storage-settings'" class="space-y-6 max-w-3xl">
            <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
              <p class="text-xs font-bold uppercase text-zinc-400 tracking-wider">Current storage mode</p>
              <p class="mt-1 text-sm" :class="form.storage.status === 's3' ? 'text-emerald-300' : 'text-zinc-200'">
                {{ storageStatusLabel }}
              </p>
              <p class="mt-1 text-xs text-zinc-500">
                Default is data-dir. S3 is only activated after the configuration has been validated successfully.
              </p>
              <p v-if="form.storage.lastError" class="mt-2 text-xs text-rose-300">
                Last storage error: {{ form.storage.lastError }}
              </p>
            </div>

            <div
              v-if="migrationVisible"
              class="rounded-xl border p-5 shadow-sm"
              :class="migrationStatusTone"
            >
              <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p class="text-xs font-bold uppercase tracking-wider text-zinc-300">Storage migration</p>
                    <p class="mt-1 text-sm font-semibold text-white">{{ migrationStatusLabel }}</p>
                    <p class="mt-1 text-xs text-zinc-300/80">
                      Target provider: <span class="font-semibold text-white">{{ migrationTargetLabel }}</span>
                    </p>
                  </div>
                  <span class="inline-flex items-center rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white/90">
                    {{ migration.status }}
                  </span>
                </div>

                <div v-if="migration.total > 0" class="space-y-2">
                  <div class="h-2 w-full overflow-hidden rounded-full border border-white/5 bg-zinc-950/80">
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      :class="migration.status === 'failed' ? 'bg-rose-400' : 'bg-indigo-500'"
                      :style="{ width: `${migrationProgressPercent}%` }"
                    />
                  </div>
                  <div class="flex items-center justify-between text-xs text-zinc-300/80">
                    <span>{{ migration.done }} / {{ migration.total }} processed</span>
                    <span>{{ migrationProgressPercent }}%</span>
                  </div>
                </div>

                <div v-else class="flex items-center gap-3 rounded-lg bg-zinc-950/50 px-3 py-2 text-xs text-zinc-200">
                  <span
                    v-if="migration.status === 'running'"
                    class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-indigo-400"
                  />
                  <span>{{ migration.status === 'running' ? 'Preparing migration progress…' : 'Migration stopped before progress totals were available.' }}</span>
                </div>

                <p v-if="migration.message" class="text-xs text-zinc-100/90">
                  {{ migration.message }}
                </p>
                <p v-if="migration.status === 'running'" class="text-xs text-zinc-300/80">
                  The storage provider switch is still being applied. Keep using the current status above until migration finishes.
                </p>
              </div>
            </div>

            <div class="flex items-center justify-between bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
              <div>
                <p class="text-sm font-semibold text-white">Enable S3 storage for new uploads</p>
                <p class="text-xs text-zinc-500">When enabled and valid, new files are uploaded to S3 instead of data-dir.</p>
              </div>
              <label class="inline-flex items-center cursor-pointer">
                <input v-model="form.storage.enabled" type="checkbox" class="sr-only" />
                <span class="h-6 w-11 rounded-full transition-colors" :class="form.storage.enabled ? 'bg-indigo-600' : 'bg-zinc-700'">
                  <span
                    class="block h-5 w-5 rounded-full bg-white transition-transform mt-0.5"
                    :class="form.storage.enabled ? 'translate-x-5 ml-0.5' : 'translate-x-0.5'"
                  />
                </span>
              </label>
            </div>

            <div v-show="form.storage.enabled" class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
              <p class="text-xs font-bold uppercase text-zinc-400 tracking-wider">Hetzner S3 help</p>
              <p class="mt-1 text-xs text-zinc-500">
                Use Hetzner endpoint format: https://&lt;bucket-name&gt;.&lt;location&gt;.your-objectstorage.com. Bucket and location are parsed from the endpoint URL.
              </p>
              <a
                href="https://hetzner.cloud/?ref=JmdXQVT3XHM1"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-1 inline-block text-sm text-indigo-300 hover:text-indigo-200 underline"
              >
                Create Hetzner account / Object Storage
              </a>
            </div>

            <div v-show="form.storage.enabled" class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm grid gap-4 md:grid-cols-2">
              <div>
                <label class="block text-xs font-bold text-zinc-400 uppercase mb-2 tracking-wider">Endpoint URL</label>
                <input
                  v-model="form.storage.endpoint"
                  type="text"
                  class="w-full bg-zinc-950 text-white rounded-lg p-2.5 outline-none border border-white/10 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50"
                  placeholder="https://my-bucket.nbg1.your-objectstorage.com"
                />
              </div>

              <div>
                <label class="block text-xs font-bold text-zinc-400 uppercase mb-2 tracking-wider">Prefix (optional)</label>
                <input
                  v-model="form.storage.prefix"
                  type="text"
                  class="w-full bg-zinc-950 text-white rounded-lg p-2.5 outline-none border border-white/10 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50"
                  placeholder="guild-a"
                />
              </div>

              <div>
                <label class="block text-xs font-bold text-zinc-400 uppercase mb-2 tracking-wider">Access Key</label>
                <input
                  v-model="form.storage.accessKey"
                  type="text"
                  class="w-full bg-zinc-950 text-white rounded-lg p-2.5 outline-none border border-white/10 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50"
                  autocomplete="off"
                />
              </div>

              <div>
                <label class="block text-xs font-bold text-zinc-400 uppercase mb-2 tracking-wider">Secret Key</label>
                <input
                  v-model="form.storage.secretKey"
                  type="password"
                  class="w-full bg-zinc-950 text-white rounded-lg p-2.5 outline-none border border-white/10 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50"
                  autocomplete="new-password"
                />
              </div>

              <div class="md:col-span-2 flex items-center gap-3">
                <button
                  class="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-300 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  :disabled="s3TestState === 'testing'"
                  @click="emit('test-storage')"
                >
                  {{ s3TestState === 'testing' ? 'Testing...' : 'Test Connection' }}
                </button>
                <p
                  v-if="s3TestMessage"
                  class="text-xs"
                  :class="s3TestState === 'success' ? 'text-emerald-300' : s3TestState === 'error' ? 'text-rose-300' : 'text-zinc-500'"
                >
                  {{ s3TestMessage }}
                </p>
              </div>
            </div>

            <p v-if="saveError" class="text-sm text-rose-300">{{ saveError }}</p>
            <p v-if="saveMessage" class="text-sm text-emerald-300">{{ saveMessage }}</p>
          </div>
        </div>

        <div class="px-8 py-5 border-t border-white/5 bg-zinc-950/80 backdrop-blur-sm">
          <p
            v-if="hasUnsavedChanges"
            class="mb-3 rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200"
          >
            You have unsaved server settings changes.
          </p>
          <div class="flex justify-end gap-3">
            <button class="text-zinc-400 hover:text-white text-sm font-medium px-4 py-2 transition-colors" @click="visible = false">Cancel</button>
            <button
              class="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-300 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors duration-200 shadow-sm"
              :disabled="saveDisabled"
              @click="emit('save')"
            >
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
