<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppAvatar from '../common/AppAvatar.vue'
import { useChatStore } from '../../stores/chat'
import type { ModerationDeleteMode, ServerRole, User } from '../../stores/chat'

const chatStore = useChatStore()

const showModerationModal = ref(false)
const moderationAction = ref<'kick' | 'ban'>('kick')
const selectedMember = ref<User | null>(null)
const reason = ref('')
const deleteMode = ref<ModerationDeleteMode>('none')
const isAssigningRoles = ref(false)
const contextMenu = ref<{ visible: boolean; x: number; y: number; member: User | null }>({
  visible: false,
  x: 0,
  y: 0,
  member: null
})
const blacklistIdentity = ref(true)
const blacklistIp = ref(false)

const isAdmin = computed(() => chatStore.userHasRole(chatStore.currentUser, ['admin']))

const assignableRoles = computed(() => {
  return chatStore.serverRoles.filter((role) => role.key !== 'all_users')
})

const roleMap = computed(() => {
  const map = new Map<string, ServerRole>()
  for (const role of chatStore.serverRoles) {
    map.set(role.id, role)
    map.set(role.key, role)
  }
  return map
})

const getDisplayRole = (user: User) => chatStore.getPrimaryServerRole(user) || roleMap.value.get(user.role) || null

const getDisplayRoleById = (roleId: string) => roleMap.value.get(roleId) || null

const getDisplayRoleName = (user: User) => {
  const role = getDisplayRole(user)
  if (role) {
    return role.name
  }

  return user.role || 'all users'
}

const getDisplayRoleColor = (user: User) => getDisplayRole(user)?.color || chatStore.getServerRoleColor(user.role) || null

const getRoleHeading = (user: User) => {
  const label = getDisplayRoleName(user)
  return label.endsWith('s') ? label : `${label}s`
}

const isHiddenSystemMember = (user: User) => {
  return chatStore.userHasRole(user, ['system']) || (chatStore.userHasRole(user, ['bot']) && user.username === 'RSS Bot')
}

const canModerate = (user: User) => {
  if (!isAdmin.value || !chatStore.currentUser) return false
  if (chatStore.currentUser.id === user.id) return false
  return true
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

const isRoleAssignedToMember = (user: User | null, roleId: string) => {
  if (!user) return false
  return Array.isArray(user.role_ids) && user.role_ids.includes(roleId)
}

const toggleRoleAssignment = async (roleId: string) => {
  const member = contextMenu.value.member
  if (!member || !chatStore.server?.id || isAssigningRoles.value) return

  const currentRoleIds = Array.isArray(member.role_ids) ? member.role_ids : []
  const nextRoleIds = currentRoleIds.includes(roleId)
    ? currentRoleIds.filter((id) => id !== roleId)
    : [...currentRoleIds, roleId]

  isAssigningRoles.value = true
  try {
    await chatStore.assignMemberRoles(chatStore.server.id, member.id, nextRoleIds)
    const updatedMember = chatStore.users.find((user) => user.id === member.id) || null
    contextMenu.value = {
      ...contextMenu.value,
      member: updatedMember
    }
  } finally {
    isAssigningRoles.value = false
  }
}

const getRoleButtonClass = (assigned: boolean) => {
  if (assigned) {
    return 'text-white bg-zinc-900/90'
  }

  return 'text-zinc-300 hover:text-white hover:bg-zinc-900'
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
  const online = visibleUsers.filter((u) => chatStore.isUserEffectivelyOnline(u))
  const offline = visibleUsers.filter((u) => !chatStore.isUserEffectivelyOnline(u))

  const onlineByRole: Record<string, typeof online> = {}
  online.forEach((u) => {
    const role = chatStore.getPrimaryServerRole(u)?.id || u.role || 'all_users'

    if (!onlineByRole[role]) onlineByRole[role] = []
    onlineByRole[role]!.push(u)
  })

  const sortedRoles = Object.keys(onlineByRole).sort((a, b) => {
    const roleA = getDisplayRoleById(a)
    const roleB = getDisplayRoleById(b)

    if ((roleA?.key || a) === 'admin') return -1
    if ((roleB?.key || b) === 'admin') return 1

    const positionA = roleA?.position ?? Number.MAX_SAFE_INTEGER
    const positionB = roleB?.position ?? Number.MAX_SAFE_INTEGER
    if (positionA !== positionB) {
      return positionA - positionB
    }

    return (roleA?.name || a || 'all users').localeCompare(roleB?.name || b || 'all users')
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
        <h3 class="text-xs font-bold uppercase tracking-widest mb-3 px-2" :style="{ color: members[0] ? getDisplayRoleColor(members[0]) || '#71717a' : '#71717a' }">
          {{ members[0] ? getRoleHeading(members[0]) : 'Members' }} — {{ members.length }}
        </h3>
        <div class="space-y-0.5">
          <div
            v-for="user in members"
            :key="user.id"
            class="flex items-center px-2 py-1.5 hover:bg-zinc-900/80 rounded-lg cursor-pointer group transition-colors duration-200"
            @contextmenu="openContextMenu($event, user)"
          >
            <AppAvatar
              :src="user.avatar_url"
              :fallback="user.username"
              wrapper-class="relative w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-400 shrink-0 flex items-center justify-center font-bold mr-3 text-sm overflow-visible"
              image-class="w-full h-full object-cover rounded-full"
            >
              <div class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-zinc-950 group-hover:border-zinc-900 bg-green-500 transition-colors"></div>
            </AppAvatar>
            <div class="flex-1 min-w-0">
              <div class="text-[13px] font-semibold truncate transition-colors group-hover:text-white" :style="{ color: getDisplayRoleColor(user) || '#d4d4d8' }">{{ user.username }}</div>
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
            <AppAvatar
              :src="user.avatar_url"
              :fallback="user.username"
              wrapper-class="relative w-8 h-8 rounded-full bg-zinc-800 shrink-0 flex items-center justify-center text-zinc-400 font-bold mr-3 text-sm overflow-visible"
              image-class="w-full h-full object-cover rounded-full grayscale opacity-70 group-hover:opacity-100 transition-opacity"
            >
              <div class="absolute bottom-0 right-0 w-3 h-3 bg-zinc-600 rounded-full border-2 border-zinc-950 group-hover:border-zinc-900 transition-colors"></div>
            </AppAvatar>
            <div class="flex-1 min-w-0">
              <div class="text-[13px] font-medium truncate transition-colors group-hover:text-zinc-300" :style="{ color: getDisplayRoleColor(user) ? `${getDisplayRoleColor(user)}b3` : '#71717a' }">{{ user.username }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="contextMenu.visible"
      class="fixed z-[70] min-w-[14rem] bg-zinc-950 border border-white/10 rounded-xl shadow-2xl py-1 backdrop-blur-md"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
    >
      <div v-if="contextMenu.member && assignableRoles.length > 0" class="px-1 py-1 border-b border-white/5 mb-1">
        <div class="px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Roles</div>
        <button
          v-for="role in assignableRoles"
          :key="role.id"
          class="w-full flex items-center justify-between gap-3 text-left px-3 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          :class="getRoleButtonClass(isRoleAssignedToMember(contextMenu.member, role.id))"
          :disabled="isAssigningRoles"
          @click="toggleRoleAssignment(role.id)"
        >
          <span class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: role.color || '#71717a' }"></span>
            <span class="truncate">{{ role.name }}</span>
          </span>
          <span class="text-[11px] uppercase tracking-wider text-zinc-500">{{ isRoleAssignedToMember(contextMenu.member, role.id) ? 'On' : 'Off' }}</span>
        </button>
      </div>
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
