<script setup lang="ts">
import { computed } from 'vue'
import { useChatStore } from '../../stores/chat'

const chatStore = useChatStore()

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
  </aside>
</template>
