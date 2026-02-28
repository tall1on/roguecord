<script setup lang="ts">
withDefaults(defineProps<{
  size?: number
}>(), {
  size: 48
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="RougeCord logo"
    role="img"
  >
    <rect x="3" y="3" width="58" height="58" rx="18" fill="#0F1822" />
    <rect x="3" y="3" width="58" height="58" rx="18" stroke="#2A3C50" stroke-width="2" />

    <path d="M8 44L28 10L56 40L36 56L8 44Z" fill="#2C79FF" fill-opacity="0.18" />
    <path d="M6 30L26 8L52 28L34 52L6 30Z" fill="#1F8A70" fill-opacity="0.22" />

    <path
      d="M18 45V19H31.8C38 19 42.1 22.9 42.1 28.4C42.1 32.8 39.7 36 35.6 37.2L44.2 45H36.8L29.3 38.3H24.3V45H18ZM24.3 32.7H31.1C34.2 32.7 35.8 31.1 35.8 28.6C35.8 26 34.1 24.3 31.1 24.3H24.3V32.7Z"
      fill="#F5FBFF"
    />
    <path
      d="M52 24.2C50.5 22.4 48.2 21.2 45.7 21.2C41.2 21.2 37.6 24.8 37.6 29.3C37.6 33.8 41.2 37.4 45.7 37.4C48.3 37.4 50.6 36.2 52 34.4"
      stroke="#53D3B2"
      stroke-width="3.8"
      stroke-linecap="round"
    />
  </svg>
</template>
