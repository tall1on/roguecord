<script setup lang="ts">
import { ref, watch } from 'vue'
import { useChatStore } from '../../../stores/chat'
import { useWebRtcStore } from '../../../stores/webrtc'

type SettingsSection = 'general' | 'audio' | 'connections' | 'server'

const props = defineProps<{
  visible: boolean
  activeSection?: SettingsSection
  autoConnectLastServer: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'update:activeSection', value: SettingsSection): void
  (e: 'update:autoConnectLastServer', value: boolean): void
}>()

const chatStore = useChatStore()
const webrtcStore = useWebRtcStore()

const editedUsername = ref(chatStore.localUsername || '')
const adminKeyInput = ref('')

const saveUsernamePreference = () => {
  if (editedUsername.value.trim()) {
    chatStore.saveLocalUsername(editedUsername.value.trim())
  }
}

const handleAdminKeySubmit = () => {
  if (adminKeyInput.value.trim()) {
    chatStore.submitAdminKey(adminKeyInput.value.trim())
    adminKeyInput.value = ''
  }
}

const handleInputDeviceChange = async (event: Event) => {
  const target = event.target as HTMLSelectElement
  await webrtcStore.setInputDevice(target.value)
}

const handleOutputDeviceChange = async (event: Event) => {
  const target = event.target as HTMLSelectElement
  await webrtcStore.setOutputDevice(target.value)
}

const handleInputVolumeChange = (event: Event) => {
  const target = event.target as HTMLInputElement
  webrtcStore.setInputVolume(Number(target.value))
}

const handleOutputVolumeChange = (event: Event) => {
  const target = event.target as HTMLInputElement
  webrtcStore.setOutputVolume(Number(target.value))
}

const handleNoiseGateToggle = (event: Event) => {
  const target = event.target as HTMLInputElement
  webrtcStore.setNoiseGateEnabled(target.checked)
}

const handleNoiseGateThresholdChange = (event: Event) => {
  const target = event.target as HTMLInputElement
  webrtcStore.setNoiseGateThreshold(Number(target.value))
}

const handleBrowserAudioProcessingToggle = (event: Event) => {
  const target = event.target as HTMLInputElement
  webrtcStore.setBrowserAudioProcessingEnabled(target.checked)
}

const handleEchoCancellationToggle = (event: Event) => {
  const target = event.target as HTMLInputElement
  webrtcStore.setEchoCancellationEnabled(target.checked)
}

const handleNoiseSuppressionToggle = (event: Event) => {
  const target = event.target as HTMLInputElement
  webrtcStore.setNoiseSuppressionEnabled(target.checked)
}

const handleAutoGainControlToggle = (event: Event) => {
  const target = event.target as HTMLInputElement
  webrtcStore.setAutoGainControlEnabled(target.checked)
}

watch(() => chatStore.localUsername, (value) => {
  editedUsername.value = value || ''
})
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-[2px] flex items-center justify-center p-4">
    <div class="w-full max-w-5xl h-[min(760px,94vh)] bg-zinc-950 border border-white/5 rounded-2xl shadow-2xl overflow-hidden flex">
      <aside class="w-64 bg-zinc-900 border-r border-white/5 p-3 flex flex-col gap-1">
        <div class="px-3 py-2 text-xs font-bold text-zinc-400 uppercase tracking-widest mb-1">User Settings</div>
        
        <button 
          @click="emit('update:activeSection', 'general')" 
          class="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200" 
          :class="activeSection === 'general' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'"
        >General</button>
        
        <button 
          @click="emit('update:activeSection', 'audio')" 
          class="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200" 
          :class="activeSection === 'audio' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'"
        >Audio & Voice</button>
        
        <button 
          @click="emit('update:activeSection', 'connections')" 
          class="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200" 
          :class="activeSection === 'connections' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'"
        >Connections</button>
        
        <div class="my-2 border-t border-white/5"></div>
        
        <button 
          @click="emit('update:activeSection', 'server')" 
          class="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200" 
          :class="activeSection === 'server' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'"
        >Server Tools</button>
      </aside>

      <section class="flex-1 overflow-y-auto custom-scrollbar p-8 bg-zinc-950/50 relative">
        <button 
          @click="emit('update:visible', false)" 
          class="absolute top-6 right-6 w-8 h-8 flex items-center justify-center rounded-full border border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-white hover:border-zinc-700 transition-all duration-200"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>

        <div class="mb-8 pr-12">
          <h2 class="text-2xl font-bold text-white tracking-tight">
            {{
              activeSection === 'general' ? 'General Settings'
              : activeSection === 'audio' ? 'Audio & Voice'
              : activeSection === 'connections' ? 'Connections'
              : 'Server Tools'
            }}
          </h2>
          <p class="text-sm text-zinc-400 mt-2">
            {{
              activeSection === 'general' ? 'Basic client behavior and profile defaults.'
              : activeSection === 'audio' ? 'Input/output devices, gain and voice cleanup.'
              : activeSection === 'connections' ? 'Manage your saved servers and quick connect.'
              : 'Admin and maintenance actions for active servers.'
            }}
          </p>
        </div>

        <div v-if="activeSection === 'general'" class="space-y-6 max-w-2xl">
          <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
            <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">Display Name</label>
            <div class="flex gap-3">
              <input v-model="editedUsername" @keyup.enter="saveUsernamePreference" type="text" class="flex-1 bg-zinc-950 text-white p-2.5 rounded-lg border border-white/10 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all font-medium" placeholder="Your local username" />
              <button @click="saveUsernamePreference" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 rounded-lg font-medium transition-colors duration-200 shadow-sm">Save</button>
            </div>
          </div>

          <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
            <label class="flex items-center justify-between cursor-pointer group">
              <div>
                <span class="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">Auto-connect to last server on startup</span>
                <p class="text-xs text-zinc-500 mt-1">Automatically join the last server you were connected to when you open the app.</p>
              </div>
              <div class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" :checked="autoConnectLastServer" @change="e => emit('update:autoConnectLastServer', (e.target as HTMLInputElement).checked)" class="sr-only peer" />
                <div class="w-11 h-6 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
              </div>
            </label>
          </div>
        </div>

        <div v-else-if="activeSection === 'audio'" class="space-y-6 max-w-2xl">
          
          <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-sm font-bold text-zinc-300 uppercase tracking-wider">Audio Devices</h3>
              <button @click="webrtcStore.refreshAudioDevices()" class="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors bg-indigo-500/10 hover:bg-indigo-500/20 px-3 py-1.5 rounded-md">Refresh Devices</button>
            </div>

            <div class="space-y-5">
              <div>
                <label class="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wide">Input Device</label>
                <div class="relative">
                  <select :value="webrtcStore.selectedInputDeviceId" @change="handleInputDeviceChange" class="w-full bg-zinc-950 text-sm font-medium text-white rounded-lg px-3 py-2.5 border border-white/10 appearance-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all">
                    <option v-for="device in webrtcStore.availableInputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || `Input ${device.deviceId.slice(0, 8)}` }}</option>
                  </select>
                  <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-zinc-400">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                  </div>
                </div>
              </div>

              <div>
                <label class="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wide">Output Device</label>
                <div class="relative">
                  <select :value="webrtcStore.selectedOutputDeviceId" @change="handleOutputDeviceChange" :disabled="!webrtcStore.canSelectOutputDevice" class="w-full bg-zinc-950 text-sm font-medium text-white rounded-lg px-3 py-2.5 border border-white/10 appearance-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all disabled:opacity-50">
                    <option value="default">System Default</option>
                    <option v-for="device in webrtcStore.availableOutputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || `Output ${device.deviceId.slice(0, 8)}` }}</option>
                  </select>
                  <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-zinc-400">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm space-y-6">
            <div>
              <div class="flex items-center justify-between text-xs font-medium text-zinc-400 mb-2"><span>Input Volume</span><span class="text-white">{{ webrtcStore.inputVolume }}%</span></div>
              <input type="range" min="0" max="200" step="1" :value="webrtcStore.inputVolume" @input="handleInputVolumeChange" class="w-full accent-indigo-500 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
            </div>
            
            <div class="pt-2">
              <div class="flex items-center justify-between text-xs font-medium text-zinc-400 mb-2"><span>Output Volume</span><span class="text-white">{{ webrtcStore.outputVolume }}%</span></div>
              <input type="range" min="0" max="100" step="1" :value="webrtcStore.outputVolume" @input="handleOutputVolumeChange" class="w-full accent-indigo-500 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
            </div>
            
            <div class="pt-2">
              <div class="flex items-center justify-between text-xs font-medium text-zinc-400 mb-2"><span>Mic Level Assessment</span><span :class="webrtcStore.micLevel > 85 ? 'text-red-400' : webrtcStore.micLevel > 55 ? 'text-yellow-400' : 'text-green-400'">{{ webrtcStore.micLevel }}%</span></div>
              <div class="h-1.5 bg-zinc-950 rounded-full overflow-hidden border border-white/5">
                <div class="h-full transition-all duration-100" :class="webrtcStore.micLevel > 85 ? 'bg-red-500' : webrtcStore.micLevel > 55 ? 'bg-yellow-500' : 'bg-green-500'" :style="{ width: `${webrtcStore.micLevel}%` }"></div>
              </div>
            </div>
          </div>

          <div class="bg-zinc-900 border border-white/5 rounded-xl p-5 shadow-sm">
            <label class="flex items-center justify-between cursor-pointer group mb-4 pb-4 border-b border-white/5">
              <div>
                <span class="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">Browser Built-in Audio Processing</span>
                <p class="text-xs text-zinc-500 mt-1">Let the browser try to clean up your voice automatically.</p>
              </div>
              <div class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" :checked="webrtcStore.browserAudioProcessingEnabled" @change="handleBrowserAudioProcessingToggle" class="sr-only peer" />
                <div class="w-9 h-5 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
              </div>
            </label>

            <div class="space-y-4 mb-6 pl-2" :class="{ 'opacity-50 pointer-events-none': !webrtcStore.browserAudioProcessingEnabled }">
              <label class="flex items-center justify-between cursor-pointer group">
                <span class="text-sm text-zinc-400 group-hover:text-zinc-300 transition-colors">Echo Cancellation</span>
                <div class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" :checked="webrtcStore.echoCancellationEnabled" @change="handleEchoCancellationToggle" class="sr-only peer" />
                  <div class="w-9 h-5 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                </div>
              </label>
              
              <label class="flex items-center justify-between cursor-pointer group">
                <span class="text-sm text-zinc-400 group-hover:text-zinc-300 transition-colors">Noise Suppression</span>
                <div class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" :checked="webrtcStore.noiseSuppressionEnabled" @change="handleNoiseSuppressionToggle" class="sr-only peer" />
                  <div class="w-9 h-5 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                </div>
              </label>
              
              <label class="flex items-center justify-between cursor-pointer group">
                <span class="text-sm text-zinc-400 group-hover:text-zinc-300 transition-colors">Automatic Gain Control</span>
                <div class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" :checked="webrtcStore.autoGainControlEnabled" @change="handleAutoGainControlToggle" class="sr-only peer" />
                  <div class="w-9 h-5 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                </div>
              </label>
            </div>

            <div class="pt-4 border-t border-white/5">
              <label class="flex items-center justify-between cursor-pointer group mb-4">
                <div>
                  <span class="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">Enable Noise Gate</span>
                  <p class="text-xs text-zinc-500 mt-1">Automatically mute your mic when you aren't talking.</p>
                </div>
                <div class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" :checked="webrtcStore.noiseGateEnabled" @change="handleNoiseGateToggle" class="sr-only peer" />
                  <div class="w-9 h-5 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                </div>
              </label>
              
              <div :class="{ 'opacity-50 pointer-events-none': !webrtcStore.noiseGateEnabled }">
                <div class="flex items-center justify-between text-xs font-medium text-zinc-400 mb-2"><span>Gate Threshold</span><span class="text-white">{{ webrtcStore.noiseGateThreshold }}%</span></div>
                <input type="range" min="0" max="100" step="1" :value="webrtcStore.noiseGateThreshold" @input="handleNoiseGateThresholdChange" class="w-full accent-indigo-500 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="activeSection === 'connections'" class="space-y-4 max-w-2xl">
          <div v-if="chatStore.savedConnections.length === 0" class="bg-zinc-900 border border-white/5 rounded-xl p-8 text-center text-zinc-500 shadow-sm flex flex-col items-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" class="mb-3 text-zinc-700 hover:text-zinc-600 transition-colors" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
            <p>You have no saved server connections yet.</p>
          </div>
          
          <div v-for="connection in chatStore.savedConnections" :key="connection.id" class="bg-zinc-900 border border-white/5 hover:border-white/10 rounded-xl p-4 flex items-center justify-between gap-4 shadow-sm transition-colors group">
            <div class="min-w-0 flex flex-col">
              <div class="text-white font-bold tracking-wide truncate flex items-center gap-2">
                <span class="w-2 h-2 rounded-full" :class="chatStore.activeConnectionId === connection.id ? 'bg-green-500' : 'bg-zinc-600'"></span>
                {{ connection.name }}
              </div>
              <div class="text-xs text-zinc-500 truncate font-mono mt-0.5 ml-4">{{ connection.address }}</div>
            </div>
            
            <div class="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
              <button @click="chatStore.connect(connection.address); emit('update:visible', false)" class="px-3.5 py-1.5 rounded-lg bg-white text-black hover:bg-zinc-200 text-sm font-medium transition-colors shadow-sm">
                Connect
              </button>
              <button @click="chatStore.removeSavedConnection(connection.id)" class="px-3 py-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-400/10 text-sm font-medium transition-colors">
                Remove
              </button>
            </div>
          </div>
        </div>

        <div v-else class="space-y-6 max-w-2xl">
          <div class="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-5 shadow-sm">
            <h3 class="flex items-center gap-2 text-sm font-bold text-indigo-400 uppercase tracking-widest mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              Admin Authentication
            </h3>
            <p class="text-sm text-indigo-300/70 mb-4">Enter an administrative key to gain access to server management features like creating channels and managing user permissions.</p>
            
            <div class="flex gap-3">
              <input v-model="adminKeyInput" @keyup.enter="handleAdminKeySubmit" type="password" class="flex-1 bg-zinc-950 text-white p-2.5 rounded-lg border border-indigo-500/30 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 transition-all font-mono placeholder:font-sans" placeholder="Enter admin key" />
              <button @click="handleAdminKeySubmit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 rounded-lg font-medium transition-colors duration-200 shadow-sm">Authenticate</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
