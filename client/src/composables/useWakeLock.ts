import { ref, type Ref } from 'vue';

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
  removeEventListener?: (type: 'release', listener: () => void) => void;
};

const isWakeLockSupported = () =>
  typeof navigator !== 'undefined' && 'wakeLock' in navigator && typeof document !== 'undefined';

export function useWakeLock(): {
  isActive: Ref<boolean>;
  enable: () => void;
  disable: () => void;
} {
  const isActive = ref(false);
  let sentinel: WakeLockSentinelLike | null = null;
  let wanted = false;
  let listening = false;

  const request = async () => {
    if (!wanted || !isWakeLockSupported()) return;
    if (sentinel && !sentinel.released) return;
    if (document.visibilityState !== 'visible') return;

    try {
      const acquired = (await (navigator as Navigator & {
        wakeLock: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
      }).wakeLock.request('screen')) as WakeLockSentinelLike;
      sentinel = acquired;
      isActive.value = true;

      acquired.addEventListener('release', () => {
        if (sentinel === acquired) {
          sentinel = null;
          isActive.value = false;
        }
      });
    } catch (_e) {
      sentinel = null;
      isActive.value = false;
    }
  };

  const release = async () => {
    const current = sentinel;
    sentinel = null;
    isActive.value = false;
    if (current && !current.released) {
      try {
        await current.release();
      } catch (_e) {
        // no-op
      }
    }
  };

  const handleVisibilityChange = () => {
    if (!wanted) return;
    if (document.visibilityState === 'visible') {
      void request();
    }
  };

  const enable = () => {
    if (wanted) return;
    wanted = true;
    if (!listening) {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      listening = true;
    }
    void request();
  };

  const disable = () => {
    if (!wanted) return;
    wanted = false;
    if (listening) {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      listening = false;
    }
    void release();
  };

  return { isActive, enable, disable };
}
