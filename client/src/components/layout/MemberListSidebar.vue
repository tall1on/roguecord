<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useChatStore } from '../../stores/chat'
import type { ModerationDeleteMode, User } from '../../stores/chat'

const chatStore = useChatStore()

const showModerationModal = ref(false)
const moderationAction = ref<'kick' | 'ban'>('kick')
const selectedMember = ref<User | null>(null)
const reason = ref('')
const deleteMode = ref<ModerationDeleteMode>('none')
const contextMenu = ref<{ visible: boolean; x: number; y: number; member: User | null }>({
  visible: false,
  x: 0,
  y: 0,
  member: null
})
const blacklistIdentity = ref(true)
const blacklistIp = ref(false)

const isAdmin = computed(() => chatStore.currentUserRole === 'admin')

const canModerate = (user: User) => {
  if (!isAdmin.value || !chatStore.currentUser) return false
  if (chatStore.currentUser.id === user.id) return false
  return user.role !== 'admin'
}

const resetModerationForm = () => {
  reason.value = ''
  deleteMode.value = 'none'
  blacklistIdentity.value = true
  blacklistIp.value = false
}

const closeContextMenu = () => {
  contextMenu.value = {
    visible: false,
    x: 0,
    y: 0,
    member: null
  }
}

const openContextMenu = (event: MouseEvent, user: User) => {
  if (!canModerate(user)) {
    closeContextMenu()
    return
  }

  event.preventDefault()
  event.stopPropagation()

  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    member: user
  }
}

const openModerationFromContextMenu = (action: 'kick' | 'ban') => {
  const member = contextMenu.value.member
  if (!member) return
  closeContextMenu()
  openModeration(member, action)
}

const openModeration = (user: User, action: 'kick' | 'ban') => {
  if (!canModerate(user)) return
  moderationAction.value = action
  selectedMember.value = user
  resetModerationForm()
  showModerationModal.value = true
}

const closeModeration = () => {
  showModerationModal.value = false
  selectedMember.value = null
}

const canSubmitBan = computed(() => {
  if (moderationAction.value !== 'ban') return true
  return blacklistIdentity.value || blacklistIp.value
})

const targetIp = computed(() => {
  if (!selectedMember.value) return null
  return chatStore.memberIps[selectedMember.value.id] || null
})

const submitModeration = () => {
  if (!selectedMember.value) return

  if (moderationAction.value === 'kick') {
    chatStore.kickMember(selectedMember.value.id, {
      reason: reason.value,
      deleteMode: deleteMode.value,
      deleteHours: deleteMode.value === 'hours' ? 1 : undefined
    })
  } else {
    if (!canSubmitBan.value) {
      return
    }
    chatStore.banMember(selectedMember.value.id, {
      reason: reason.value,
      deleteMode: deleteMode.value,
      deleteHours: deleteMode.value === 'hours' ? 1 : undefined,
      blacklistIdentity: blacklistIdentity.value,
      blacklistIp: blacklistIp.value
    })
  }

  closeModeration()
}

const groupedMembers = computed(() => {
  const online = chatStore.users.filter((u) => chatStore.onlineUserIds.has(u.id))
  const offline = chatStore.users.filter((u) => !chatStore.onlineUserIds.has(u.id))

  const onlineByRole: Record<string, typeof online> = {}
  online.forEach((u) => {
    let role = u.role || 'user'
    role = role.charAt(0).toUpperCase() + role.slice(1) + 's'

    if (!onlineByRole[role]) onlineByRole[role] = []
    onlineByRole[role]!.push(u)
  })

  const sortedRoles = Object.keys(onlineByRole).sort((a, b) => {
    if (a === 'Admins') return -1
    if (b === 'Admins') return 1
    return a.localeCompare(b)
  })

  const sortedOnlineByRole: Record<string, typeof online> = {}
  sortedRoles.forEach((role) => {
    sortedOnlineByRole[role] = onlineByRole[role]!.sort((a, b) => a.username.localeCompare(b.username))
  })

  return {
    onlineByRole: sortedOnlineByRole,
    offline: offline.sort((a, b) => a.username.localeCompare(b.username))
  }
})

onMounted(() => {
  window.addEventListener('click', closeContextMenu)
  window.addEventListener('contextmenu', closeContextMenu)
})

onUnmounted(() => {
  window.removeEventListener('click', closeContextMenu)
  window.removeEventListener('contextmenu', closeContextMenu)
})
</script>

<template>
  <aside v-if="chatStore.isConnected && chatStore.activeChannelId" class="w-60 bg-zinc-950 flex flex-col shrink-0 border-l border-white/5">
    <div class="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
      <div v-for="(members, role) in groupedMembers.onlineByRole" :key="role">
        <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-3 px-2">
          {{ role }} — {{ members.length }}
        </h3>
        <div class="space-y-0.5">
          <div
            v-for="user in members"
            :key="user.id"
            class="flex items-center px-2 py-1.5 hover:bg-zinc-900/80 rounded-lg cursor-pointer group transition-colors duration-200"
            @contextmenu="openContextMenu($event, user)"
          >
            <div class="relative w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-400 shrink-0 flex items-center justify-center font-bold mr-3 text-sm">
              <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover rounded-full" />
              <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
              <div class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-zinc-950 group-hover:border-zinc-900 bg-green-500 transition-colors"></div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[13px] font-semibold truncate transition-colors" :class="user.role === 'admin' ? 'text-red-400 group-hover:text-red-300' : 'text-zinc-300 group-hover:text-white'">{{ user.username }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="groupedMembers.offline.length > 0">
        <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-3 px-2">
          Offline — {{ groupedMembers.offline.length }}
        </h3>
        <div class="space-y-0.5">
          <div
            v-for="user in groupedMembers.offline"
            :key="user.id"
            class="flex items-center px-2 py-1.5 hover:bg-zinc-900/80 rounded-lg cursor-pointer group opacity-60 hover:opacity-100 transition-all duration-200"
            @contextmenu="openContextMenu($event, user)"
          >
            <div class="relative w-8 h-8 rounded-full bg-zinc-800 shrink-0 flex items-center justify-center text-zinc-400 font-bold mr-3 text-sm">
              <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover rounded-full grayscale opacity-70 group-hover:opacity-100 transition-opacity" />
              <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
              <div class="absolute bottom-0 right-0 w-3 h-3 bg-zinc-600 rounded-full border-2 border-zinc-950 group-hover:border-zinc-900 transition-colors"></div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[13px] font-medium truncate transition-colors" :class="user.role === 'admin' ? 'text-red-400/70 group-hover:text-red-400' : 'text-zinc-500 group-hover:text-zinc-300'">{{ user.username }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="contextMenu.visible"
      class="fixed z-[70] min-w-[10rem] bg-zinc-950 border border-white/10 rounded-xl shadow-2xl py-1 backdrop-blur-md"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
    >
      <button
        class="w-full text-left px-3 py-2 text-sm text-zinc-300 hover:text-white hover:bg-zinc-900 font-medium transition-colors"
        @click="openModerationFromContextMenu('kick')"
      >
        Kick
      </button>
      <button
        class="w-full text-left px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-zinc-900 font-medium transition-colors"
        @click="openModerationFromContextMenu('ban')"
      >
        Ban
      </button>
    </div>

    <div v-if="showModerationModal && selectedMember" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div class="bg-zinc-950 border border-white/10 p-6 rounded-xl shadow-2xl w-[28rem] max-w-[95vw]">
        <h2 class="text-xl font-bold text-white mb-2 tracking-tight">
          {{ moderationAction === 'ban' ? 'Ban member' : 'Kick member' }}: {{ selectedMember.username }}
        </h2>
        <p class="text-sm text-zinc-400 mb-6">
          {{ moderationAction === 'ban' ? 'This user will lose access to the server.' : 'This user will be removed from the server session.' }}
        </p>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Reason (optional)</label>
            <div class="relative bg-zinc-900 border border-white/5 rounded-lg focus-within:ring-1 focus-within:ring-indigo-500 transition-all">
              <textarea
                v-model="reason"
                rows="3"
                class="w-full bg-transparent text-white p-2.5 focus:outline-none text-sm placeholder:text-zinc-600 font-medium resize-none shadow-sm"
                placeholder="Enter moderation reason"
              />
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Delete message history</label>
            <div class="relative bg-zinc-900 border border-white/5 rounded-lg focus-within:ring-1 focus-within:ring-indigo-500 transition-all">
              <select
                v-model="deleteMode"
                class="w-full bg-transparent text-white p-2.5 outline-none text-sm font-medium appearance-none"
              >
                <option value="none" class="bg-zinc-900">Do not delete messages</option>
                <option value="hours" class="bg-zinc-900">Delete last hour of messages</option>
                <option value="all" class="bg-zinc-900">Delete all messages</option>
              </select>
            </div>
          </div>

          <div v-if="moderationAction === 'ban'" class="border border-white/5 rounded-xl p-4 bg-zinc-900/60 shadow-sm mt-2">
            <div class="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2">Blacklist options</div>
            <p class="text-[11px] font-medium text-zinc-500 mb-4">Select at least one blacklist target.</p>
            <label class="flex items-center gap-3 text-sm text-zinc-200 mb-3 cursor-pointer hover:text-white transition-colors">
              <input v-model="blacklistIdentity" type="checkbox" class="accent-indigo-500 w-4 h-4 bg-zinc-950 border-white/10" />
              <span class="font-medium">Blacklist account identity</span>
            </label>
            <label class="flex items-center gap-3 text-sm text-zinc-200 mb-4 cursor-pointer hover:text-white transition-colors">
              <input v-model="blacklistIp" type="checkbox" class="accent-indigo-500 w-4 h-4 bg-zinc-950 border-white/10" />
              <span class="font-medium">Blacklist current IP</span>
            </label>
            <p class="text-xs font-medium text-zinc-500 bg-zinc-950/50 p-2 rounded border border-white/5 inline-block">
              Target IP:
              <span class="text-zinc-300">{{ targetIp || 'Unavailable' }}</span>
            </p>
            <p v-if="!canSubmitBan" class="text-[11px] font-bold text-red-400 mt-3 flex items-center gap-1.5"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>Select identity and/or IP blacklist for ban.</p>
          </div>
        </div>

        <div class="flex justify-end gap-3 mt-8 pt-4 border-t border-white/5">
          <button @click="closeModeration" class="text-zinc-400 hover:text-white text-sm font-medium transition-colors">Cancel</button>
          <button
            @click="submitModeration"
            class="text-white px-5 py-2 rounded-lg font-medium shadow-sm transition-colors"
            :class="moderationAction === 'ban' ? 'bg-red-500 hover:bg-red-600 disabled:opacity-50 disabled:hover:bg-red-500' : 'bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600'"
            :disabled="!canSubmitBan"
          >
            Confirm {{ moderationAction === 'ban' ? 'Ban' : 'Kick' }}
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>
