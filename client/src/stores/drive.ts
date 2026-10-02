import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useChatStore } from './chat';
import { useWebRtcStore } from './webrtc';

export interface DriveLocation {
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  updated_at: number;
}

export const getGpsSpeed = (position: GeolocationPosition, previous: GeolocationPosition | null): number | null => {
  const speed = position.coords.speed;
  if (typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 && speed <= 400) return speed;
  if (!previous) return null;
  const seconds = (position.timestamp - previous.timestamp) / 1000;
  if (seconds < 2 || seconds > 15 || !Number.isFinite(seconds)
    || position.coords.accuracy > 50 || previous.coords.accuracy > 50) return null;
  const radians = Math.PI / 180;
  const latitudeDelta = (position.coords.latitude - previous.coords.latitude) * radians;
  const longitudeDelta = (position.coords.longitude - previous.coords.longitude) * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(previous.coords.latitude * radians) * Math.cos(position.coords.latitude * radians)
    * Math.sin(longitudeDelta / 2) ** 2;
  const distance = 6371000 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine))));
  // Movement inside the combined GPS accuracy radius is indistinguishable from stationary jitter.
  if (distance <= position.coords.accuracy + previous.coords.accuracy) return 0;
  const estimated = distance / seconds;
  return Number.isFinite(estimated) && estimated <= 400 ? estimated : null;
};

export const useDriveStore = defineStore('drive', () => {
  const chatStore = useChatStore();
  const webrtcStore = useWebRtcStore();
  const joinedChannelId = ref<string | null>(null);
  const locations = ref<Map<string, DriveLocation>>(new Map());
  const isSharing = ref(false);
  const locationError = ref<string | null>(null);
  let watchId: number | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingLocation: Pick<DriveLocation, 'latitude' | 'longitude' | 'accuracy' | 'speed'> | null = null;
  let lastSentAt = 0;
  let watchGeneration = 0;
  let locationSharingEnabled = true;
  const receivedAt = new Map<string, number>();
  const now = ref(Date.now());
  let freshnessTimer: ReturnType<typeof setInterval> | null = null;

  const activeChannelId = computed(() => {
    const channel = chatStore.channels.find((entry) => entry.id === webrtcStore.activeVoiceChannelId);
    return channel?.type === 'drive' ? channel.id : null;
  });

  const getSpeedLabel = (userId: string, channelId: string): string | null => {
    if (joinedChannelId.value !== channelId) return null;
    const location = locations.value.get(userId);
    if (!location && !(isSharing.value && chatStore.currentUser?.id === userId)) return null;
    const speed = location?.speed;
    return typeof speed === 'number' && Number.isFinite(speed) && speed >= 0
      && now.value - (receivedAt.get(userId) ?? 0) < 15000
      ? `${Math.round(speed * 3.6)} km/h` : '-- km/h';
  };

  const stopSharing = (notify = true) => {
    if (notify) locationSharingEnabled = false;
    watchGeneration++;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = null;
    pendingLocation = null;
    isSharing.value = false;
    if (chatStore.currentUser) {
      locations.value.delete(chatStore.currentUser.id);
      receivedAt.delete(chatStore.currentUser.id);
    }
    if (notify && joinedChannelId.value && chatStore.isConnected) {
      chatStore.send('drive_location_update', { channel_id: joinedChannelId.value, location: null });
    }
  };

  const startSharing = () => {
    const channelId = joinedChannelId.value;
    if (!channelId || channelId !== activeChannelId.value || isSharing.value) return;
    locationSharingEnabled = true;
    locationError.value = null;
    if (!window.isSecureContext || !navigator.geolocation) {
      locationError.value = 'Location access requires HTTPS (or localhost) and a client that supports geolocation.';
      return;
    }

    isSharing.value = true;
    lastSentAt = 0;
    let previousFix: GeolocationPosition | null = null;
    let estimatedSpeed: number | null = null;
    const generation = ++watchGeneration;
    const sendLocation = () => {
      sendTimer = null;
      if (generation !== watchGeneration || !isSharing.value || activeChannelId.value !== channelId || !pendingLocation) return;
      const { latitude, longitude, accuracy, speed } = pendingLocation;
      pendingLocation = null;
      lastSentAt = Date.now();
      chatStore.send('drive_location_update', { channel_id: channelId, location: { latitude, longitude, accuracy, speed } });
    };

    watchId = navigator.geolocation.watchPosition((position) => {
      if (generation !== watchGeneration || activeChannelId.value !== channelId) return;
      locationError.value = null;
      if (previousFix && (position.timestamp - previousFix.timestamp >= 2000 || position.timestamp <= previousFix.timestamp)) {
        estimatedSpeed = getGpsSpeed(position, previousFix);
        previousFix = position;
      }
      if (!previousFix) previousFix = position;
      const speed = getGpsSpeed(position, null) ?? estimatedSpeed;
      const { latitude, longitude, accuracy } = position.coords;
      pendingLocation = { latitude, longitude, accuracy, speed };
      if (sendTimer === null) {
        const delay = Math.max(0, 1000 - (Date.now() - lastSentAt));
        if (delay === 0) sendLocation();
        else sendTimer = setTimeout(sendLocation, delay);
      }
    }, (error) => {
      if (generation !== watchGeneration) return;
      if (error.code === error.PERMISSION_DENIED) {
        stopSharing();
        locationError.value = 'Location permission was denied. Allow location access in your browser or system settings to share your position.';
      } else {
        locationError.value = error.code === error.TIMEOUT
          ? 'Waiting for a GPS fix. Location access timed out; retrying automatically.'
          : 'Your location is unavailable. Waiting for GPS to recover.';
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  };

  const handleMessage = ({ type, payload }: { type: string; payload: any }) => {
    if (!activeChannelId.value || payload?.channel_id !== activeChannelId.value) return;
    if (type === 'voice_channel_joined') {
      joinedChannelId.value = payload.channel_id;
      if (locationSharingEnabled) startSharing();
    } else if (type === 'drive_locations') {
      now.value = Date.now();
      receivedAt.clear();
      for (const location of payload.locations as DriveLocation[]) {
        receivedAt.set(location.user_id, now.value - Math.max(0, (payload.generated_at ?? now.value) - location.updated_at));
      }
      locations.value = new Map((payload.locations as DriveLocation[]).map((location) => [location.user_id, location]));
    } else if (type === 'drive_location_updated') {
      now.value = Date.now();
      if (payload.location) {
        receivedAt.set(payload.user_id, now.value);
        locations.value.set(payload.user_id, { ...payload.location, user_id: payload.user_id });
      } else {
        locations.value.delete(payload.user_id);
        receivedAt.delete(payload.user_id);
      }
    } else if (type === 'user_left_voice') {
      locations.value.delete(payload.user_id);
      receivedAt.delete(payload.user_id);
    }
  };

  chatStore.addMessageListener(handleMessage);
  watch([activeChannelId, () => chatStore.isConnected], () => {
    // Keep an explicit GPS opt-out until the user enables sharing again.
    stopSharing(false);
    joinedChannelId.value = null;
    locations.value = new Map();
    receivedAt.clear();
    locationError.value = null;
    if (freshnessTimer !== null) clearInterval(freshnessTimer);
    freshnessTimer = activeChannelId.value && chatStore.isConnected
      ? setInterval(() => { now.value = Date.now(); }, 1000) : null;
  }, { flush: 'sync', immediate: true });
  onScopeDispose(() => {
    stopSharing();
    if (freshnessTimer !== null) clearInterval(freshnessTimer);
    chatStore.removeMessageListener(handleMessage);
  });

  return { activeChannelId, joinedChannelId, locations, isSharing, locationError, getSpeedLabel, startSharing, stopSharing };
});
