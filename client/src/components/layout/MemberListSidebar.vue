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

const isHiddenSystemMember = (user: User) => {
  return user.role === 'system' || (user.role === 'bot' && user.username === 'RSS Bot')
}

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
  const visibleUsers = chatStore.users.filter((u) => !isHiddenSystemMember(u))
  const online = visibleUsers.filter((u) => chatStore.onlineUserIds.has(u.id))
  const offline = visibleUsers.filter((u) => !chatStore.onlineUserIds.has(u.id))

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
  <aside v-if="chatStore.isConnected && chatStore.activeChannelId" class="w-60 bg-[#2b2d31] flex flex-col shrink-0 border-l border-[#1e1f22]">
    <div class="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
      <div v-for="(members, role) in groupedMembers.onlineByRole" :key="role">
        <h3 class="text-xs font-bold text-gray-400 uppercase mb-2 px-2">
          {{ role }} — {{ members.length }}
        </h3>
        <div class="space-y-1">
          <div
            v-for="user in members"
            :key="user.id"
            class="flex items-center px-2 py-1.5 hover:bg-[#3f4147] rounded cursor-pointer group"
            @contextmenu="openContextMenu($event, user)"
          >
            <div class="relative w-8 h-8 rounded-full bg-indigo-500 shrink-0 flex items-center justify-center text-white font-bold mr-3">
              <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover rounded-full" />
              <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
              <div class="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-[#2b2d31] group-hover:border-[#3f4147] bg-green-500"></div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate group-hover:text-gray-100" :class="user.role === 'admin' ? 'text-red-500' : 'text-gray-300'">{{ user.username }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="groupedMembers.offline.length > 0">
        <h3 class="text-xs font-bold text-gray-400 uppercase mb-2 px-2">
          Offline — {{ groupedMembers.offline.length }}
        </h3>
        <div class="space-y-1">
          <div
            v-for="user in groupedMembers.offline"
            :key="user.id"
            class="flex items-center px-2 py-1.5 hover:bg-[#3f4147] rounded cursor-pointer group opacity-50 hover:opacity-100"
            @contextmenu="openContextMenu($event, user)"
          >
            <div class="relative w-8 h-8 rounded-full bg-gray-600 shrink-0 flex items-center justify-center text-white font-bold mr-3">
              <img v-if="user.avatar_url" :src="user.avatar_url" alt="Avatar" class="w-full h-full object-cover rounded-full grayscale" />
              <span v-else>{{ user.username.charAt(0).toUpperCase() }}</span>
              <div class="absolute bottom-0 right-0 w-3.5 h-3.5 bg-gray-500 rounded-full border-2 border-[#2b2d31] group-hover:border-[#3f4147]"></div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate group-hover:text-gray-300" :class="user.role === 'admin' ? 'text-red-500' : 'text-gray-400'">{{ user.username }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="contextMenu.visible"
      class="fixed z-[70] min-w-[10rem] bg-[#1e1f22] border border-[#3f4147] rounded shadow-xl py-1"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
    >
      <button
        class="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-[#3f4147]"
        @click="openModerationFromContextMenu('kick')"
      >
        Kick
      </button>
      <button
        class="w-full text-left px-3 py-2 text-sm text-red-300 hover:bg-[#3f4147]"
        @click="openModerationFromContextMenu('ban')"
      >
        Ban
      </button>
    </div>

    <div v-if="showModerationModal && selectedMember" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div class="bg-[#313338] p-6 rounded-lg shadow-xl w-[28rem] max-w-[95vw]">
        <h2 class="text-xl font-bold text-white mb-2">
          {{ moderationAction === 'ban' ? 'Ban member' : 'Kick member' }}: {{ selectedMember.username }}
        </h2>
        <p class="text-sm text-gray-400 mb-4">
          {{ moderationAction === 'ban' ? 'This user will lose access to the server.' : 'This user will be removed from the server session.' }}
        </p>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Reason (optional)</label>
            <textarea
              v-model="reason"
              rows="3"
              class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              placeholder="Enter moderation reason"
            />
          </div>

          <div>
            <label class="block text-xs font-bold text-gray-300 uppercase mb-2">Delete message history</label>
            <select
              v-model="deleteMode"
              class="w-full bg-[#1e1f22] text-white p-2.5 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="none">Do not delete messages</option>
              <option value="hours">Delete last hour of messages</option>
              <option value="all">Delete all messages</option>
            </select>
          </div>

          <div v-if="moderationAction === 'ban'" class="border border-[#1e1f22] rounded p-3 bg-[#2b2d31]">
            <div class="text-xs font-bold text-gray-300 uppercase mb-2">Blacklist options</div>
            <p class="text-xs text-gray-400 mb-3">Select at least one blacklist target.</p>
            <label class="flex items-center gap-2 text-sm text-gray-200 mb-2">
              <input v-model="blacklistIdentity" type="checkbox" class="accent-indigo-500" />
              Blacklist account identity
            </label>
            <label class="flex items-center gap-2 text-sm text-gray-200 mb-3">
              <input v-model="blacklistIp" type="checkbox" class="accent-indigo-500" />
              Blacklist current IP
            </label>
            <p class="text-xs text-gray-400">
              Target IP:
              <span class="text-gray-200">{{ targetIp || 'Unavailable' }}</span>
            </p>
            <p v-if="!canSubmitBan" class="text-xs text-red-400 mt-2">Select identity and/or IP blacklist for ban.</p>
          </div>
        </div>

        <div class="flex justify-end gap-3 mt-6">
          <button @click="closeModeration" class="text-gray-400 hover:text-white text-sm">Cancel</button>
          <button
            @click="submitModeration"
            class="text-white px-5 py-2 rounded font-medium"
            :class="moderationAction === 'ban' ? 'bg-[#8b2e35] hover:bg-[#a03a42]' : 'bg-indigo-500 hover:bg-indigo-600'"
            :disabled="!canSubmitBan"
          >
            Confirm {{ moderationAction === 'ban' ? 'Ban' : 'Kick' }}
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>
