<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  src?: string | null
  fallback: string
  alt?: string
  wrapperClass?: string
  imageClass?: string
}>(), {
  src: null,
  alt: 'Avatar',
  wrapperClass: '',
  imageClass: ''
})

const imageLoadFailed = ref(false)

const sanitizedSrc = computed<string | undefined>(() => {
  const value = props.src?.trim()
  return value ? value : undefined
})

const shouldShowImage = computed(() => Boolean(sanitizedSrc.value) && !imageLoadFailed.value)

const fallbackInitials = computed(() => {
  const text = props.fallback.trim()
  if (!text) {
    return '?'
  }

  const tokens = text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    return '?'
  }

  if (tokens.length === 1) {
    return tokens[0].slice(0, 2).toUpperCase()
  }

  return `${tokens[0][0]}${tokens[tokens.length - 1][0]}`.toUpperCase()
})

const handleImageError = () => {
  imageLoadFailed.value = true
}

watch(sanitizedSrc, () => {
  imageLoadFailed.value = false
})
</script>

<template>
  <div :class="wrapperClass">
    <img
      v-if="shouldShowImage"
      :src="sanitizedSrc"
      :alt="alt"
      :class="imageClass"
      @error="handleImageError"
    />
    <span v-else>{{ fallbackInitials }}</span>
    <slot />
  </div>
</template>
