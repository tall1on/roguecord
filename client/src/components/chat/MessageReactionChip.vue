<script setup lang="ts">
import { computed } from 'vue'
import type { MessageReaction } from '../../stores/chat'

const props = defineProps<{
  reaction: MessageReaction
}>()

const emit = defineEmits<{
  toggle: [emoji: string]
}>()

const isActive = computed(() => props.reaction.reacted_by_current_user)

const reactionCountLabel = computed(() => {
  return props.reaction.count === 1
    ? '1 reaction'
    : `${props.reaction.count} reactions`
})

const reactionTitle = computed(() => {
  return isActive.value
    ? `You reacted with ${props.reaction.emoji} • ${reactionCountLabel.value}`
    : `${reactionCountLabel.value} with ${props.reaction.emoji}`
})

const reactionAriaLabel = computed(() => {
  const ownership = isActive.value ? 'You reacted' : 'Other users reacted'
  const action = isActive.value ? 'remove your reaction' : 'add your reaction'

  return `${ownership} with ${props.reaction.emoji}; ${reactionCountLabel.value}. Click to ${action}.`
})

const toggleReaction = () => {
  emit('toggle', props.reaction.emoji)
}
</script>

<template>
  <button
    type="button"
    class="relative inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold shadow-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#313338]"
    :class="isActive
      ? 'border-indigo-400/45 bg-indigo-500/10 text-indigo-100 shadow-none ring-1 ring-inset ring-indigo-400/20 hover:border-indigo-300/60 hover:bg-indigo-500/15 hover:text-white focus-visible:ring-indigo-400/70'
      : 'border-white/10 bg-zinc-900/70 text-zinc-300 hover:border-white/20 hover:bg-zinc-800/90 hover:text-white focus-visible:ring-zinc-500'"
    :aria-pressed="isActive"
    :aria-label="reactionAriaLabel"
    :title="reactionTitle"
    @click="toggleReaction"
  >
    <span v-twemoji="reaction.emoji" class="inline-flex items-center" aria-hidden="true"></span>
    <span class="tabular-nums">{{ reaction.count }}</span>
  </button>
</template>
