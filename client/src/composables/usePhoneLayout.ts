import { onScopeDispose, ref } from 'vue';

// Also cover short, touch-driven phone screens in landscape without changing tablet layouts.
export const PHONE_LAYOUT_QUERY = '(max-width: 767px) and (pointer: coarse), (max-width: 1023px) and (max-height: 500px) and (pointer: coarse)';

export const usePhoneLayout = () => {
  const query = window.matchMedia(PHONE_LAYOUT_QUERY);
  const isPhone = ref(query.matches);
  const update = (event: MediaQueryListEvent) => { isPhone.value = event.matches; };
  // Safari 13 is still included in the client's configured build targets.
  const modernEvents = typeof query.addEventListener === 'function';
  if (modernEvents) query.addEventListener('change', update);
  else query.addListener(update);
  onScopeDispose(() => {
    if (modernEvents) query.removeEventListener('change', update);
    else query.removeListener(update);
  });
  return isPhone;
};
