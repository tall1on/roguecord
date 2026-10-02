import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useChatStore } from './chat';
import { useWebRtcStore } from './webrtc';

export interface DriveLocation {
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  updated_at: number;
}

export const useDriveStore = defineStore('drive', () => {
  const chatStore = useChatStore();
  const webrtcStore = useWebRtcStore();
  const joinedChannelId = ref<string | null>(null);
  const locations = ref<Map<string, DriveLocation>>(new Map());
  const isSharing = ref(false);
  const locationError = ref<string | null>(null);
  let watchId: number | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingLocation: GeolocationCoordinates | null = null;
  let lastSentAt = 0;
  let watchGeneration = 0;
  let locationSharingEnabled = true;

  const activeChannelId = computed(() => {
    const channel = chatStore.channels.find((entry) => entry.id === webrtcStore.activeVoiceChannelId);
    return channel?.type === 'drive' ? channel.id : null;
  });

  const stopSharing = (notify = true) => {
    if (notify) locationSharingEnabled = false;
    watchGeneration++;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = null;
    pendingLocation = null;
    isSharing.value = false;
    if (chatStore.currentUser) locations.value.delete(chatStore.currentUser.id);
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
    const generation = ++watchGeneration;
    const sendLocation = () => {
      sendTimer = null;
      if (generation !== watchGeneration || !isSharing.value || activeChannelId.value !== channelId || !pendingLocation) return;
      const { latitude, longitude, accuracy } = pendingLocation;
      pendingLocation = null;
      lastSentAt = Date.now();
      chatStore.send('drive_location_update', { channel_id: channelId, location: { latitude, longitude, accuracy } });
    };

    watchId = navigator.geolocation.watchPosition((position) => {
      if (generation !== watchGeneration || activeChannelId.value !== channelId) return;
      locationError.value = null;
      pendingLocation = position.coords;
      if (sendTimer === null) {
        const delay = Math.max(0, 2000 - (Date.now() - lastSentAt));
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
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  };

  const handleMessage = ({ type, payload }: { type: string; payload: any }) => {
    if (!activeChannelId.value || payload?.channel_id !== activeChannelId.value) return;
    if (type === 'voice_channel_joined') {
      joinedChannelId.value = payload.channel_id;
      if (locationSharingEnabled) startSharing();
    } else if (type === 'drive_locations') {
      locations.value = new Map((payload.locations as DriveLocation[]).map((location) => [location.user_id, location]));
    } else if (type === 'drive_location_updated') {
      if (payload.location) locations.value.set(payload.user_id, { ...payload.location, user_id: payload.user_id });
      else locations.value.delete(payload.user_id);
    } else if (type === 'user_left_voice') {
      locations.value.delete(payload.user_id);
    }
  };

  chatStore.addMessageListener(handleMessage);
  watch([activeChannelId, () => chatStore.isConnected], () => {
    // Keep an explicit GPS opt-out until the user enables sharing again.
    stopSharing(false);
    joinedChannelId.value = null;
    locations.value = new Map();
    locationError.value = null;
  }, { flush: 'sync' });
  onScopeDispose(() => {
    stopSharing();
    chatStore.removeMessageListener(handleMessage);
  });

  return { activeChannelId, joinedChannelId, locations, isSharing, locationError, startSharing, stopSharing };
});
