<script setup lang="ts">
import { computed } from 'vue'
import { getFlagEmojiImageUrl, isFlagEmoji } from '../../utils/flagEmoji'

const props = withDefaults(defineProps<{
  emoji: string
  alt?: string
  class?: string
}>(), {
  alt: undefined,
  class: ''
})

const imageUrl = computed(() => getFlagEmojiImageUrl(props.emoji))
const shouldRenderImage = computed(() => isFlagEmoji(props.emoji) && Boolean(imageUrl.value))
const imageAlt = computed(() => props.alt || props.emoji)
</script>

<template>
  <img
    v-if="shouldRenderImage && imageUrl"
    :src="imageUrl"
    :alt="imageAlt"
    :class="props.class"
    loading="lazy"
    decoding="async"
    draggable="false"
  />
  <span v-else>{{ emoji }}</span>
</template>
