import { onMounted, onUnmounted, ref } from 'vue';

const now = ref(Date.now());
let intervalId: number | null = null;
let subscribers = 0;

export function useCallTimer() {
  onMounted(() => {
    subscribers++;
    if (intervalId == null) {
      intervalId = window.setInterval(() => { now.value = Date.now(); }, 1000);
    }
  });
  onUnmounted(() => {
    subscribers--;
    if (subscribers <= 0 && intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });
  return { now };
}
