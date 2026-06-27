<script setup lang="ts">
import { computed } from 'vue'
import { useWebRtcStore } from '../../stores/webrtc'
import { useCallTimer } from '../../composables/useCallTimer'
import { formatDurationHms } from '../../utils/formatDuration'

const props = defineProps<{
  channelId: string
}>()

const webrtcStore = useWebRtcStore()
const { now } = useCallTimer()

const startedAt = computed(() => webrtcStore.getCallStartedAt(props.channelId))

const label = computed(() => {
  if (startedAt.value == null) {
    return ''
  }
  return formatDurationHms(now.value - startedAt.value)
})
</script>

<template>
  <span
    v-if="startedAt != null"
    class="text-zinc-400 text-xs font-medium tabular-nums"
    :title="`Call duration ${label}`"
  >{{ label }}</span>
</template>
