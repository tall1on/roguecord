<script setup lang="ts">
withDefaults(defineProps<{
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
</script>

<template>
    <div :class="wrapperClass">
        <img v-if="src" :src="src" :alt="alt" :class="imageClass"/>
        <span v-else>{{ fallback.trim().slice(0, 1).toUpperCase() || '?' }}</span>
        <slot/>
    </div>
</template>
