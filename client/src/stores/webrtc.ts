import { defineStore } from 'pinia';
import { ref, shallowRef, watch } from 'vue';
import { Device } from 'mediasoup-client';
import { useChatStore } from './chat';

type MediaSourceType = 'mic' | 'screen' | 'camera';
type ScreenStreamFps = 30 | 60;
type ScreenStreamResolution = 'source' | '1080p' | '720p' | '480p' | '4k' | '8k';

type ScreenStreamPreference = {
  fps: ScreenStreamFps;
  resolution: ScreenStreamResolution;
};

type ScreenStreamVolumePreference = {
  volume: number;
  muted: boolean;
  lastNonZeroVolume: number;
};

const DEFAULT_SCREEN_STREAM_PREFERENCE: ScreenStreamPreference = {
  fps: 30,
  resolution: 'source'
};

const DEFAULT_SCREEN_STREAM_VOLUME_PREFERENCE: ScreenStreamVolumePreference = {
  volume: 1,
  muted: false,
  lastNonZeroVolume: 1
};

export const useWebRtcStore = defineStore('webrtc', () => {
  const chatStore = useChatStore();
  
  const device = shallowRef<Device | null>(null);
  const sendTransport = shallowRef<any | null>(null);
  const recvTransport = shallowRef<any | null>(null);
  const producer = shallowRef<any | null>(null);
  const screenProducer = shallowRef<any | null>(null);
  const screenShareStream = shallowRef<MediaStream | null>(null);
  const screenShareError = ref<string | null>(null);
  const consumers = shallowRef<Map<string, any>>(new Map());
  
  const activeVoiceChannelId = ref<string | null>(null);
  const lastActiveVoiceChannelId = ref<string | null>(null);
  const voiceParticipants = ref<any[]>([]);
  const channelParticipants = ref<Map<string, any[]>>(new Map());
  const localStream = shallowRef<MediaStream | null>(null);
  const audioContext = shallowRef<AudioContext | null>(null);
  const remoteStreams = shallowRef<Map<string, MediaStream>>(new Map());
  const audioElements = new Map<string, HTMLAudioElement>();
  
  const producerToUser = new Map<string, string>();
  const producerToSource = new Map<string, MediaSourceType>();
  const consumerToProducer = new Map<string, string>();
  const userScreenStreams = shallowRef<Map<string, MediaStream>>(new Map());
  const screenStreamMuteState = ref<Map<string, boolean>>(new Map());
  const screenStreamPreferenceState = ref<Map<string, ScreenStreamPreference>>(new Map());
  const screenStreamVolumeState = ref<Map<string, number>>(new Map());
  const screenStreamLastNonZeroVolumeState = ref<Map<string, number>>(new Map());
  const screenAudioConsumersByUser = new Map<string, Set<string>>();

  const closeConsumer = (consumerId: string, reason: string) => {
    const producerId = consumerToProducer.get(consumerId);
    const source = producerId ? producerToSource.get(producerId) : null;
    const userId = producerId ? producerToUser.get(producerId) : null;

    const consumer = consumers.value.get(consumerId);
    if (consumer) {
      try {
        consumer.close();
      } catch (_e) {
        // no-op
      }
      consumers.value.delete(consumerId);
    }

    removeSpeakingDetector(consumerId);
    remoteStreams.value.delete(consumerId);

    const audio = audioElements.get(consumerId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audioElements.delete(consumerId);
    }

    if (source === 'screen' && userId) {
      const consumerIds = screenAudioConsumersByUser.get(userId);
      if (consumerIds) {
        consumerIds.delete(consumerId);
        if (consumerIds.size === 0) {
          screenAudioConsumersByUser.delete(userId);
        }
      }
    }

    consumerToProducer.delete(consumerId);

    console.info('[WebRTC][consume] Consumer closed locally', {
      consumerId,
      reason
    });
  };

  const getScreenStreamPreference = (userId: string): ScreenStreamPreference => {
    return screenStreamPreferenceState.value.get(userId) || DEFAULT_SCREEN_STREAM_PREFERENCE;
  };

  const getScreenStreamFps = (userId: string): ScreenStreamFps => {
    return getScreenStreamPreference(userId).fps;
  };

  const getScreenStreamResolution = (userId: string): ScreenStreamResolution => {
    return getScreenStreamPreference(userId).resolution;
  };

  const isScreenStreamMuted = (userId: string) => {
    return screenStreamMuteState.value.get(userId) === true;
  };

  const getScreenStreamVolume = (userId: string) => {
    return screenStreamVolumeState.value.get(userId) ?? DEFAULT_SCREEN_STREAM_VOLUME_PREFERENCE.volume;
  };

  const getScreenStreamLastNonZeroVolume = (userId: string) => {
    return screenStreamLastNonZeroVolumeState.value.get(userId) ?? DEFAULT_SCREEN_STREAM_VOLUME_PREFERENCE.lastNonZeroVolume;
  };

  const clampScreenStreamVolume = (volume: number) => {
    if (!Number.isFinite(volume)) return DEFAULT_SCREEN_STREAM_VOLUME_PREFERENCE.volume;
    return Math.min(1, Math.max(0, volume));
  };

  const applyScreenStreamAudioState = (userId: string) => {
    const volume = getScreenStreamVolume(userId);
    const muted = isScreenStreamMuted(userId) || volume <= 0;

    const consumerIds = screenAudioConsumersByUser.get(userId);
    if (!consumerIds) {
      return;
    }

    for (const consumerId of consumerIds) {
      const audio = audioElements.get(consumerId);
      if (!audio) continue;
      audio.volume = volume;
      audio.muted = muted;
    }
  };

  const setScreenStreamVolume = (userId: string, volume: number) => {
    const clampedVolume = clampScreenStreamVolume(volume);

    if (clampedVolume >= 1) {
      screenStreamVolumeState.value.delete(userId);
    } else {
      screenStreamVolumeState.value.set(userId, clampedVolume);
    }
    screenStreamVolumeState.value = new Map(screenStreamVolumeState.value);

    if (clampedVolume > 0) {
      screenStreamLastNonZeroVolumeState.value.set(userId, clampedVolume);
      screenStreamLastNonZeroVolumeState.value = new Map(screenStreamLastNonZeroVolumeState.value);
      if (isScreenStreamMuted(userId)) {
        screenStreamMuteState.value.delete(userId);
        screenStreamMuteState.value = new Map(screenStreamMuteState.value);
      }
    } else {
      if (!isScreenStreamMuted(userId)) {
        screenStreamMuteState.value.set(userId, true);
        screenStreamMuteState.value = new Map(screenStreamMuteState.value);
      }
    }

    applyScreenStreamAudioState(userId);
  };

  const setScreenStreamMuted = (userId: string, isMuted: boolean) => {
    if (isMuted) {
      screenStreamMuteState.value.set(userId, true);
      const currentVolume = getScreenStreamVolume(userId);
      if (currentVolume > 0) {
        screenStreamLastNonZeroVolumeState.value.set(userId, currentVolume);
        screenStreamLastNonZeroVolumeState.value = new Map(screenStreamLastNonZeroVolumeState.value);
      }
    } else {
      screenStreamMuteState.value.delete(userId);
      if (getScreenStreamVolume(userId) <= 0) {
        const restoredVolume = getScreenStreamLastNonZeroVolume(userId);
        if (restoredVolume >= 1) {
          screenStreamVolumeState.value.delete(userId);
        } else {
          screenStreamVolumeState.value.set(userId, restoredVolume);
        }
        screenStreamVolumeState.value = new Map(screenStreamVolumeState.value);
      }
    }
    screenStreamMuteState.value = new Map(screenStreamMuteState.value);
    applyScreenStreamAudioState(userId);
  };

  const getResolutionTarget = (resolution: ScreenStreamResolution, sourceAspectRatio: number) => {
    const targetHeightByResolution: Record<Exclude<ScreenStreamResolution, 'source'>, number> = {
      '1080p': 1080,
      '720p': 720,
      '480p': 480,
      '4k': 2160,
      '8k': 4320
    };

    if (resolution === 'source') {
      return null;
    }

    const targetHeight = targetHeightByResolution[resolution];
    const targetWidth = Math.max(1, Math.round(targetHeight * sourceAspectRatio));

    return {
      width: targetWidth,
      height: targetHeight
    };
  };

  const applyScreenTrackPreference = async (track: MediaStreamTrack, preference: ScreenStreamPreference) => {
    const settings = track.getSettings();
    const sourceWidth = settings.width || 1920;
    const sourceHeight = settings.height || 1080;
    const sourceAspectRatio = sourceHeight > 0 ? sourceWidth / sourceHeight : 16 / 9;

    const resolutionTarget = getResolutionTarget(preference.resolution, sourceAspectRatio);
    const preferredConstraints: MediaTrackConstraints = {
      frameRate: {
        ideal: preference.fps,
        max: preference.fps
      }
    };

    if (resolutionTarget) {
      preferredConstraints.width = {
        ideal: resolutionTarget.width,
        max: resolutionTarget.width
      };
      preferredConstraints.height = {
        ideal: resolutionTarget.height,
        max: resolutionTarget.height
      };
    }

    try {
      await track.applyConstraints(preferredConstraints);
      return;
    } catch (error) {
      console.warn('[WebRTC][screen] Failed to apply preferred screen constraints, retrying with fps-only', {
        preference,
        preferredConstraints,
        error
      });
    }

    try {
      await track.applyConstraints({
        frameRate: {
          ideal: preference.fps,
          max: preference.fps
        }
      });
      return;
    } catch (error) {
      console.warn('[WebRTC][screen] Failed to apply fps-only constraints, retrying with unconstrained track', {
        preference,
        error
      });
    }

    try {
      await track.applyConstraints({});
    } catch (error) {
      console.warn('[WebRTC][screen] Failed to reset track constraints after unsupported preference', {
        preference,
        error
      });
    }
  };

  const setScreenStreamPreference = async (
    userId: string,
    updates: Partial<ScreenStreamPreference>
  ) => {
    const currentPreference = getScreenStreamPreference(userId);
    const nextPreference: ScreenStreamPreference = {
      fps: updates.fps ?? currentPreference.fps,
      resolution: updates.resolution ?? currentPreference.resolution
    };

    screenStreamPreferenceState.value.set(userId, nextPreference);
    screenStreamPreferenceState.value = new Map(screenStreamPreferenceState.value);

    const localUserId = chatStore.currentUser?.id;
    if (localUserId !== userId) {
      console.info('[WebRTC][screen] Screen preference updated for remote stream (hook point)', {
        userId,
        preference: nextPreference
      });
      return;
    }

    const localScreenTrack = screenShareStream.value?.getVideoTracks()[0] || null;
    if (!localScreenTrack) {
      return;
    }

    await applyScreenTrackPreference(localScreenTrack, nextPreference);
  };

  const setScreenStreamFps = async (userId: string, fps: ScreenStreamFps) => {
    await setScreenStreamPreference(userId, { fps });
  };

  const setScreenStreamResolution = async (userId: string, resolution: ScreenStreamResolution) => {
    await setScreenStreamPreference(userId, { resolution });
  };

  const setUserScreenStream = (userId: string, stream: MediaStream) => {
    userScreenStreams.value.set(userId, stream);
    userScreenStreams.value = new Map(userScreenStreams.value);

    const track = stream.getVideoTracks()[0] || null;
    console.info('[WebRTC][screen] User screen stream updated', {
      userId,
      streamId: stream.id,
      trackId: track?.id || null,
      trackReadyState: track?.readyState || null,
      trackMuted: track?.muted ?? null
    });
  };

  const deleteUserScreenStream = (userId: string) => {
    if (!userScreenStreams.value.has(userId)) return;
    userScreenStreams.value.delete(userId);
    userScreenStreams.value = new Map(userScreenStreams.value);
  };

  const cleanupScreenShareProducer = (notifyServer: boolean = true) => {
    const currentScreenProducerId = screenProducer.value?.id as string | undefined;
    if (screenProducer.value) {
      try {
        screenProducer.value.close();
      } catch (_e) {
        // no-op
      }
      screenProducer.value = null;
    }

    if (notifyServer && currentScreenProducerId && activeVoiceChannelId.value) {
      console.info('[WebRTC][screen] Requesting server-side producer close', {
        channelId: activeVoiceChannelId.value,
        producerId: currentScreenProducerId
      });
      chatStore.send('close_producer', {
        channel_id: activeVoiceChannelId.value,
        producer_id: currentScreenProducerId
      });
    }

    if (screenShareStream.value) {
      screenShareStream.value.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_e) {
          // no-op
        }
      });
      screenShareStream.value = null;
    }

    const localUserId = chatStore.currentUser?.id;
    if (localUserId && userScreenStreams.value.has(localUserId)) {
      deleteUserScreenStream(localUserId);
    }
  };

  const removeUserScreenByProducer = (producerId: string) => {
    const source = producerToSource.get(producerId);
    if (source !== 'screen') return;

    const userId = producerToUser.get(producerId);
    if (!userId) return;

    let hasAnotherScreenProducer = false;
    for (const [otherProducerId, otherUserId] of producerToUser.entries()) {
      if (otherProducerId !== producerId && otherUserId === userId && producerToSource.get(otherProducerId) === 'screen') {
        hasAnotherScreenProducer = true;
        break;
      }
    }

    if (!hasAnotherScreenProducer) {
      const existing = userScreenStreams.value.get(userId);
      if (existing) {
        existing.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (_e) {
            // no-op
          }
        });
      }
      deleteUserScreenStream(userId);
    }
  };

  const stopScreenShare = () => {
    screenShareError.value = null;
    cleanupScreenShareProducer(true);
  };

  const waitForSendTransport = async (timeoutMs: number = 4000) => {
    if (sendTransport.value) return sendTransport.value;

    const startedAt = Date.now();
    while (!sendTransport.value && activeVoiceChannelId.value && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return sendTransport.value;
  };

  const startScreenShare = async () => {
    if (!activeVoiceChannelId.value) {
      screenShareError.value = 'Join a voice channel before sharing your screen.';
      return;
    }
    if (screenProducer.value) return;

    screenShareError.value = null;
    console.info('[WebRTC][screen] Share requested', {
      channelId: activeVoiceChannelId.value,
      hasSendTransport: Boolean(sendTransport.value)
    });

    const readySendTransport = await waitForSendTransport();
    if (!readySendTransport) {
      screenShareError.value = 'Screen share is not ready yet. Please try again in a moment.';
      console.warn('[WebRTC][screen] Share failed: send transport not ready');
      return;
    }

    const canProduceVideo = Boolean(device.value?.canProduce('video'));
    console.info('[WebRTC][screen] Capability check', {
      hasDevice: Boolean(device.value),
      canProduceVideo,
      routerVideoCodecs: (device.value?.rtpCapabilities?.codecs || []).filter((codec: any) => codec.kind === 'video').map((codec: any) => codec.mimeType)
    });

    if (!canProduceVideo) {
      screenShareError.value = 'Failed to start screen share. Please try again.';
      console.error('[WebRTC][screen] Aborting: device cannot produce video');
      return;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });

      console.info('[WebRTC][screen] getDisplayMedia resolved', {
        streamId: displayStream.id,
        trackCount: displayStream.getTracks().length
      });

      const videoTrack = displayStream.getVideoTracks()[0];
      if (!videoTrack) {
        displayStream.getTracks().forEach((track) => track.stop());
        screenShareError.value = 'No screen video track was provided by the browser.';
        console.warn('[WebRTC][screen] Share failed: missing video track after picker confirm');
        return;
      }

      console.info('[WebRTC][screen] Producing screen track', {
        trackId: videoTrack.id,
        readyState: videoTrack.readyState
      });

      const localUserId = chatStore.currentUser?.id;
      if (localUserId) {
        const preferredScreenPreference = getScreenStreamPreference(localUserId);
        await applyScreenTrackPreference(videoTrack, preferredScreenPreference);
      }

      screenShareStream.value = displayStream;
      videoTrack.onended = () => {
        stopScreenShare();
      };

      screenProducer.value = await readySendTransport.produce({
        track: videoTrack,
        appData: { source: 'screen' as MediaSourceType }
      });

      console.info('[WebRTC][screen] Produce resolved', {
        producerId: screenProducer.value?.id
      });

      
      if (localUserId) {
        setUserScreenStream(localUserId, displayStream);
      }

      screenProducer.value.on('transportclose', () => {
        cleanupScreenShareProducer(false);
      });
    } catch (error) {
      screenShareError.value = 'Failed to start screen share. Please try again.';
      console.error('[WebRTC][screen] Failed to start screen share:', error);
      cleanupScreenShareProducer();
    }
  };

  const speakingUserIds = ref<Set<string>>(new Set());
  const speakingDetectors = new Map<string, {
    userId: string;
    analyser: AnalyserNode;
    source: MediaStreamAudioSourceNode;
    dataArray: Uint8Array<ArrayBuffer>;
    lastAboveThresholdAt: number;
    isLocal: boolean;
  }>();
  const speakingContext = shallowRef<AudioContext | null>(null);
  let speakingInterval: number | null = null;

  const SPEAKING_THRESHOLD = 0.026;
  const SPEAKING_HOLD_MS = 180;

  const ping = ref<number>(0);
  const bandwidth = ref<number>(0);
  const pingHistory = ref<number[]>([]);
  const connectionQuality = ref<'good' | 'warning' | 'bad'>('good');
  
  const isMuted = ref(false);
  const isDeafened = ref(false);
  
  let statsInterval: number | null = null;
  let lastBytesSent = 0;
  let lastBytesReceived = 0;
  let lastStatsTime = 0;

  const ensureSpeakingContext = () => {
    if (!speakingContext.value) {
      speakingContext.value = new AudioContext();
    }
    return speakingContext.value;
  };

  const startSpeakingDetection = () => {
    if (speakingInterval) return;

    speakingInterval = window.setInterval(() => {
      const now = Date.now();
      const nextSpeakingUsers = new Set<string>();

      speakingDetectors.forEach((detector) => {
        detector.analyser.getByteTimeDomainData(detector.dataArray);

        let sumSquares = 0;
        for (const sample of detector.dataArray) {
          const normalized = (sample - 128) / 128;
          sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / detector.dataArray.length);
        const overThreshold = rms > SPEAKING_THRESHOLD;

        if (overThreshold) {
          detector.lastAboveThresholdAt = now;
        }

        let isSpeaking = now - detector.lastAboveThresholdAt <= SPEAKING_HOLD_MS;

        if (detector.isLocal && (isMuted.value || isDeafened.value)) {
          isSpeaking = false;
        }

        if (isSpeaking) {
          nextSpeakingUsers.add(detector.userId);
        }
      });

      speakingUserIds.value = nextSpeakingUsers;
    }, 120);
  };

  const removeSpeakingDetector = (detectorKey: string) => {
    const detector = speakingDetectors.get(detectorKey);
    if (!detector) return;

    try {
      detector.source.disconnect();
    } catch (_e) {
      // no-op
    }

    speakingDetectors.delete(detectorKey);

    if (speakingDetectors.size === 0) {
      speakingUserIds.value = new Set();
    }
  };

  const addSpeakingDetector = (detectorKey: string, userId: string, stream: MediaStream, isLocal: boolean = false) => {
    if (speakingDetectors.has(detectorKey)) {
      removeSpeakingDetector(detectorKey);
    }

    const context = ensureSpeakingContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.45;

    source.connect(analyser);

    speakingDetectors.set(detectorKey, {
      userId,
      analyser,
      source,
      dataArray: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      lastAboveThresholdAt: 0,
      isLocal,
    });

    startSpeakingDetection();
  };

  const stopSpeakingDetection = async () => {
    if (speakingInterval) {
      clearInterval(speakingInterval);
      speakingInterval = null;
    }

    speakingDetectors.forEach((detector) => {
      try {
        detector.source.disconnect();
      } catch (_e) {
        // no-op
      }
    });

    speakingDetectors.clear();
    speakingUserIds.value = new Set();

    if (speakingContext.value) {
      try {
        await speakingContext.value.close();
      } catch (_e) {
        // no-op
      }
      speakingContext.value = null;
    }
  };

  const isUserSpeaking = (userId: string) => speakingUserIds.value.has(userId);

  const startStatsCollection = () => {
    if (statsInterval) clearInterval(statsInterval);
    
    lastBytesSent = 0;
    lastBytesReceived = 0;
    lastStatsTime = Date.now();
    pingHistory.value = [];
    
    statsInterval = window.setInterval(async () => {
      if (!sendTransport.value && !recvTransport.value) return;
      
      let currentPing = 0;
      let currentBytesSent = 0;
      let currentBytesReceived = 0;
      
      try {
        if (sendTransport.value) {
          const sendStats = await sendTransport.value.getStats();
          sendStats.forEach((stat: any) => {
            if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
              if (stat.currentRoundTripTime !== undefined) {
                currentPing = stat.currentRoundTripTime * 1000;
              }
            }
            if (stat.type === 'outbound-rtp') {
              currentBytesSent += stat.bytesSent || 0;
            }
          });
        }
        
        if (recvTransport.value) {
          const recvStats = await recvTransport.value.getStats();
          recvStats.forEach((stat: any) => {
            if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
              if (stat.currentRoundTripTime !== undefined && currentPing === 0) {
                currentPing = stat.currentRoundTripTime * 1000;
              }
            }
            if (stat.type === 'inbound-rtp') {
              currentBytesReceived += stat.bytesReceived || 0;
            }
          });
        }
        
        ping.value = Math.round(currentPing);
        pingHistory.value.push(ping.value);
        if (pingHistory.value.length > 20) {
          pingHistory.value.shift();
        }
        
        if (ping.value < 100) {
          connectionQuality.value = 'good';
        } else if (ping.value < 250) {
          connectionQuality.value = 'warning';
        } else {
          connectionQuality.value = 'bad';
        }
        
        const now = Date.now();
        const timeDiff = (now - lastStatsTime) / 1000;
        
        if (timeDiff > 0) {
          const bytesSentDiff = currentBytesSent - lastBytesSent;
          const bytesReceivedDiff = currentBytesReceived - lastBytesReceived;
          
          const totalBytesDiff = Math.max(0, bytesSentDiff) + Math.max(0, bytesReceivedDiff);
          bandwidth.value = Math.round((totalBytesDiff * 8) / 1000 / timeDiff);
        }
        
        lastBytesSent = currentBytesSent;
        lastBytesReceived = currentBytesReceived;
        lastStatsTime = now;
        
      } catch (error) {
        console.error('Failed to get WebRTC stats:', error);
      }
    }, 2000);
  };

  const stopStatsCollection = () => {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
    ping.value = 0;
    bandwidth.value = 0;
    pingHistory.value = [];
    connectionQuality.value = 'good';
  };

  const toggleMute = () => {
    if (isDeafened.value) {
      // If deafened, clicking mute will undeafen but keep muted
      isDeafened.value = false;
      isMuted.value = true;
      
      // Unmute all incoming audio
      audioElements.forEach(audio => {
        audio.muted = false;
      });
      
      // Mic stays disabled because isMuted is true
      if (localStream.value) {
        localStream.value.getAudioTracks().forEach(track => {
          track.enabled = false;
        });
      }
      if (producer.value) {
        producer.value.pause();
      }
    } else {
      isMuted.value = !isMuted.value;
      
      if (localStream.value) {
        localStream.value.getAudioTracks().forEach(track => {
          track.enabled = !isMuted.value;
        });
      }
      if (producer.value) {
        if (isMuted.value) {
          producer.value.pause();
        } else {
          producer.value.resume();
        }
      }
    }

    if (activeVoiceChannelId.value) {
      chatStore.send('voice_state_update', {
        channel_id: activeVoiceChannelId.value,
        isMuted: isMuted.value,
        isDeafened: isDeafened.value
      });
    }
  };

  const toggleDeafen = () => {
    isDeafened.value = !isDeafened.value;
    
    if (isDeafened.value) {
      // When deafened, also mute the mic
      if (localStream.value) {
        localStream.value.getAudioTracks().forEach(track => {
          track.enabled = false;
        });
      }
      if (producer.value) {
        producer.value.pause();
      }
      
      // Mute all incoming audio
      audioElements.forEach(audio => {
        audio.muted = true;
      });
    } else {
      // Restore mic state
      if (localStream.value) {
        localStream.value.getAudioTracks().forEach(track => {
          track.enabled = !isMuted.value;
        });
      }
      if (producer.value) {
        if (isMuted.value) {
          producer.value.pause();
        } else {
          producer.value.resume();
        }
      }
      
      // Unmute all incoming audio
      audioElements.forEach(audio => {
        audio.muted = false;
      });
    }

    if (activeVoiceChannelId.value) {
      chatStore.send('voice_state_update', {
        channel_id: activeVoiceChannelId.value,
        isMuted: isMuted.value,
        isDeafened: isDeafened.value
      });
    }
  };

  const initDevice = async (routerRtpCapabilities: any) => {
    try {
      device.value = new Device();
      await device.value.load({ routerRtpCapabilities });
    } catch (error) {
      console.error('Failed to initialize Mediasoup device:', error);
    }
  };

  const joinVoiceChannel = (channelId: string) => {
    if (activeVoiceChannelId.value === channelId) {
      return;
    }

    if (activeVoiceChannelId.value) {
      leaveVoiceChannel();
    }

    activeVoiceChannelId.value = channelId;
    chatStore.send('join_voice_channel', { 
      channel_id: channelId,
      isMuted: isMuted.value,
      isDeafened: isDeafened.value
    });
  };

  const leaveVoiceChannel = () => {
    if (!activeVoiceChannelId.value) return;
    
    chatStore.send('leave_voice_channel', { channel_id: activeVoiceChannelId.value });
    
    cleanupScreenShareProducer();

    if (localStream.value) {
      localStream.value.getTracks().forEach(track => track.stop());
      localStream.value = null;
    }
    
    if (audioContext.value) {
      audioContext.value.close();
      audioContext.value = null;
    }
    
    if (producer.value) {
      producer.value.close();
      producer.value = null;
    }
    
    if (sendTransport.value) {
      sendTransport.value.close();
      sendTransport.value = null;
    }
    
    if (recvTransport.value) {
      recvTransport.value.close();
      recvTransport.value = null;
    }
    
    consumers.value.forEach(consumer => consumer.close());
    consumers.value.clear();
    
    audioElements.forEach(audio => {
      audio.pause();
      audio.srcObject = null;
    });
    audioElements.clear();
    
    producerToUser.clear();
    producerToSource.clear();
    consumerToProducer.clear();
    userScreenStreams.value.forEach((stream) => {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_e) {
          // no-op
        }
      });
    });
    userScreenStreams.value.clear();
    userScreenStreams.value = new Map(userScreenStreams.value);
    
    remoteStreams.value.clear();
    voiceParticipants.value = [];
    activeVoiceChannelId.value = null;
    device.value = null;
    speakingUserIds.value = new Set();
    
    stopStatsCollection();
    void stopSpeakingDetection();
  };

  const handleMessage = async (message: any) => {
    const { type, payload } = message;
    
    switch (type) {
      case 'authenticated':
        if (activeVoiceChannelId.value) {
          const id = activeVoiceChannelId.value;
          leaveVoiceChannel();
          // Rejoin after a short delay to ensure state is clean
          setTimeout(() => {
            joinVoiceChannel(id);
          }, 100);
        } else if (lastActiveVoiceChannelId.value) {
          const id = lastActiveVoiceChannelId.value;
          lastActiveVoiceChannelId.value = null;
          setTimeout(() => {
            joinVoiceChannel(id);
          }, 100);
        }
        break;

      case 'voice_participants_list':
        const newMap = new Map<string, any[]>();
        for (const [channelId, users] of Object.entries(payload.participants)) {
          newMap.set(channelId, users as any[]);
        }
        channelParticipants.value = newMap;
        break;

      case 'voice_channel_joined':
        if (payload.channel_id !== activeVoiceChannelId.value) return;
        await initDevice(payload.rtpCapabilities);
        voiceParticipants.value = payload.users;

        speakingUserIds.value = new Set();
        
        // Create send and recv transports
        chatStore.send('create_webrtc_transport', { channel_id: payload.channel_id, direction: 'send' });
        chatStore.send('create_webrtc_transport', { channel_id: payload.channel_id, direction: 'recv' });
        
        startStatsCollection();
        break;
        
      case 'user_joined_voice':
        if (payload.channel_id === activeVoiceChannelId.value && !voiceParticipants.value.find(u => u.id === payload.user.id)) {
          voiceParticipants.value.push(payload.user);
        }
        
        const currentParticipants = channelParticipants.value.get(payload.channel_id) || [];
        if (!currentParticipants.find(u => u.id === payload.user.id)) {
          const newParticipants = [...currentParticipants, payload.user];
          channelParticipants.value.set(payload.channel_id, newParticipants);
          channelParticipants.value = new Map(channelParticipants.value);
        }
        break;
        
      case 'user_left_voice':
        const participants = channelParticipants.value.get(payload.channel_id);
        if (participants) {
          const newParticipants = participants.filter(u => u.id !== payload.user_id);
          if (newParticipants.length === 0) {
            channelParticipants.value.delete(payload.channel_id);
          } else {
            channelParticipants.value.set(payload.channel_id, newParticipants);
          }
          channelParticipants.value = new Map(channelParticipants.value);
        }

        if (payload.channel_id === activeVoiceChannelId.value) {
          voiceParticipants.value = voiceParticipants.value.filter(u => u.id !== payload.user_id);
          
          const producersToRemove = new Set<string>();
          for (const [prodId, userId] of producerToUser.entries()) {
            if (userId === payload.user_id) {
              producersToRemove.add(prodId);
              removeUserScreenByProducer(prodId);
              producerToUser.delete(prodId);
              producerToSource.delete(prodId);
            }
          }
          
          for (const [consId, prodId] of consumerToProducer.entries()) {
            if (producersToRemove.has(prodId)) {
              const consumer = consumers.value.get(consId);
              if (consumer) {
                consumer.close();
                consumers.value.delete(consId);
              }

              removeSpeakingDetector(consId);
               
              remoteStreams.value.delete(consId);
               
              const audio = audioElements.get(consId);
              if (audio) {
                audio.pause();
                audio.srcObject = null;
                audioElements.delete(consId);
              }
              
              consumerToProducer.delete(consId);
            }
          }
          
          remoteStreams.value = new Map(remoteStreams.value);
        }
        break;

      case 'channel_deleted':
        channelParticipants.value.delete(payload.channel_id);
        channelParticipants.value = new Map(channelParticipants.value);

        if (payload.channel_id === activeVoiceChannelId.value) {
          leaveVoiceChannel();
        }
        break;
        
      case 'voice_state_updated':
        if (payload.channel_id === activeVoiceChannelId.value) {
          const user = voiceParticipants.value.find(u => u.id === payload.user_id);
          if (user) {
            user.isMuted = payload.isMuted;
            user.isDeafened = payload.isDeafened;
          }
        }
        
        const stateParticipants = channelParticipants.value.get(payload.channel_id);
        if (stateParticipants) {
          const user = stateParticipants.find(u => u.id === payload.user_id);
          if (user) {
            user.isMuted = payload.isMuted;
            user.isDeafened = payload.isDeafened;
            channelParticipants.value = new Map(channelParticipants.value);
          }
        }
        break;

      case 'webrtc_transport_created':
        if (payload.channel_id !== activeVoiceChannelId.value || !device.value) return;
        
        if (payload.direction === 'send') {
          sendTransport.value = device.value.createSendTransport(payload.transportOptions);
          
          sendTransport.value.on('connect', ({ dtlsParameters }: any, callback: any, _errback: any) => {
            chatStore.send('connect_webrtc_transport', {
              channel_id: payload.channel_id,
              transport_id: sendTransport.value!.id,
              dtlsParameters
            });
            
            // We need to wait for the server to confirm connection
            // For simplicity, we'll just call callback immediately
            // A better approach is to use a request-response pattern over WS
            callback();
          });
          
          sendTransport.value.on('produce', async ({ kind, rtpParameters, appData }: any, callback: any, errback: any) => {
            const inferredSource: MediaSourceType = kind === 'audio' ? 'mic' : 'camera';
            const appDataSource = appData?.source;
            const source: MediaSourceType =
              appDataSource === 'mic' || appDataSource === 'screen' || appDataSource === 'camera'
                ? appDataSource
                : inferredSource;
            const requestId = typeof crypto?.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

            let settled = false;
            let producedTimeout: number | null = null;
            const cleanupProducedWait = () => {
              if (producedTimeout !== null) {
                window.clearTimeout(producedTimeout);
                producedTimeout = null;
              }
              chatStore.removeMessageListener(onProduced);
            };

            const onProduced = (msg: any) => {
              if (
                msg.type === 'produced'
                && msg.payload.channel_id === payload.channel_id
                && msg.payload.request_id === requestId
              ) {
                settled = true;
                cleanupProducedWait();
                console.info('[WebRTC][produce] ACK received', {
                  source,
                  requestId,
                  producerId: msg.payload.id
                });
                callback({ id: msg.payload.id });
              }
            };

            chatStore.addMessageListener(onProduced);

            producedTimeout = window.setTimeout(() => {
              if (settled) return;
              cleanupProducedWait();
              if (source === 'screen') {
                screenShareError.value = 'Screen share did not start (produce acknowledgement timeout). Please retry.';
              }
              console.warn('[WebRTC][produce] ACK timeout', {
                source,
                requestId,
                channelId: payload.channel_id
              });
              errback(new Error(`Produce ACK timeout for source: ${source}`));
            }, 5000);

            console.info('[WebRTC][produce] Sending produce request', {
              source,
              requestId,
              channelId: payload.channel_id
            });

            chatStore.send('produce', {
              channel_id: payload.channel_id,
              transport_id: sendTransport.value!.id,
              kind,
              rtpParameters,
              source,
              request_id: requestId
            });
          });
          
          // Start producing audio
          try {
            localStream.value = await navigator.mediaDevices.getUserMedia({
              audio: {
                autoGainControl: true,
                noiseSuppression: true,
                echoCancellation: true
              }
            });
            
            // Create Web Audio API context
            audioContext.value = new AudioContext();
            
            // Create source from the raw microphone stream
            const source = audioContext.value.createMediaStreamSource(localStream.value);
            
            // Create a highpass filter to remove low-frequency rumble/background noise
            const filter = audioContext.value.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.value = 80; // 80 Hz is a good starting point for voice
            
            // Create a compressor for auto level adjustment
            const compressor = audioContext.value.createDynamicsCompressor();
            compressor.threshold.value = -50;
            compressor.knee.value = 40;
            compressor.ratio.value = 12;
            compressor.attack.value = 0;
            compressor.release.value = 0.25;
            
            // Create a destination node to get the processed stream
            const destination = audioContext.value.createMediaStreamDestination();
            
            // Connect the nodes: source -> filter -> compressor -> destination
            source.connect(filter);
            filter.connect(compressor);
            compressor.connect(destination);
            
            // Get the processed audio track
            const processedStream = destination.stream;
            const audioTrack = processedStream.getAudioTracks()[0];
            
            if (audioTrack) {
              // Apply current mute/deafen state
              if (isMuted.value || isDeafened.value) {
                localStream.value.getAudioTracks().forEach(track => {
                  track.enabled = false;
                });
              }

              if (chatStore.currentUser?.id) {
                addSpeakingDetector('local', chatStore.currentUser.id, localStream.value, true);
              }
               
              producer.value = await sendTransport.value.produce({ track: audioTrack });
              
              if (isMuted.value || isDeafened.value) {
                producer.value.pause();
              }
            }
          } catch (error) {
            console.error('Failed to get user media or produce:', error);
          }
          
        } else if (payload.direction === 'recv') {
          recvTransport.value = device.value.createRecvTransport(payload.transportOptions);
          
          recvTransport.value.on('connect', ({ dtlsParameters }: any, callback: any, _errback: any) => {
            chatStore.send('connect_webrtc_transport', {
              channel_id: payload.channel_id,
              transport_id: recvTransport.value!.id,
              dtlsParameters
            });
            callback();
          });
          
          // Request existing producers
          chatStore.send('get_producers', { channel_id: payload.channel_id });
        }
        break;
        
      case 'new_producer':
        if (payload.channel_id !== activeVoiceChannelId.value || !device.value || !recvTransport.value) return;

          producerToUser.set(payload.producer_id, payload.user_id);
          producerToSource.set(payload.producer_id, (payload.source as MediaSourceType | undefined) || (payload.kind === 'audio' ? 'mic' : 'camera'));
        
        chatStore.send('consume', {
          channel_id: payload.channel_id,
          transport_id: recvTransport.value.id,
          producer_id: payload.producer_id,
          rtpCapabilities: device.value.rtpCapabilities
        });
        break;
        
      case 'consumed':
        if (payload.channel_id !== activeVoiceChannelId.value || !recvTransport.value) return;
        
        try {
          const consumer = await recvTransport.value.consume({
            id: payload.id,
            producerId: payload.producer_id,
            kind: payload.kind,
            rtpParameters: payload.rtpParameters,
          });
          
          consumers.value.set(consumer.id, consumer);
          consumerToProducer.set(consumer.id, payload.producer_id);

          const remoteUserId = producerToUser.get(payload.producer_id);
          const remoteSource = producerToSource.get(payload.producer_id) || ((payload.kind === 'audio' ? 'mic' : 'camera') as MediaSourceType);

          if (remoteSource === 'screen' && remoteUserId) {
            for (const [existingConsumerId, existingProducerId] of consumerToProducer.entries()) {
              if (existingConsumerId === consumer.id) continue;
              if (existingProducerId !== payload.producer_id) continue;
              closeConsumer(existingConsumerId, 'duplicate screen consumer for same producer');
            }
          }
          
          consumer.on('producerclose', () => {
            closeConsumer(consumer.id, 'producerclose event');
            removeUserScreenByProducer(payload.producer_id);
            producerToUser.delete(payload.producer_id);
            producerToSource.delete(payload.producer_id);
            remoteStreams.value = new Map(remoteStreams.value);
          });
          
          const stream = new MediaStream();
          stream.addTrack(consumer.track);

          if (remoteSource === 'screen') {
            consumer.track.onended = () => {
              console.warn('[WebRTC][screen] Remote screen track ended', {
                consumerId: consumer.id,
                producerId: payload.producer_id,
                remoteUserId
              });

              closeConsumer(consumer.id, 'remote screen track ended');
              if (remoteUserId) {
                deleteUserScreenStream(remoteUserId);
              }
              remoteStreams.value = new Map(remoteStreams.value);
            };

            consumer.track.onmute = () => {
              console.warn('[WebRTC][screen] Remote screen track muted', {
                consumerId: consumer.id,
                producerId: payload.producer_id,
                remoteUserId,
                readyState: consumer.track.readyState
              });
            };

            consumer.track.onunmute = () => {
              console.info('[WebRTC][screen] Remote screen track unmuted', {
                consumerId: consumer.id,
                producerId: payload.producer_id,
                remoteUserId,
                readyState: consumer.track.readyState
              });
            };
          }

          if (remoteUserId) {
            if (remoteSource === 'screen') {
              setUserScreenStream(remoteUserId, stream);
            } else if (payload.kind === 'audio') {
              addSpeakingDetector(consumer.id, remoteUserId, stream);
            }
          }
          
          // Store the stream with the producer ID or user ID
          // We don't have the user ID here easily, so we'll just use consumer ID
          remoteStreams.value.set(consumer.id, stream);
          
          // Play audio
          if (payload.kind === 'audio') {
            const audio = new Audio();
            audio.srcObject = stream;
            audio.autoplay = true;
            if (isDeafened.value) {
              audio.muted = true;
            }
            if (remoteSource === 'screen' && remoteUserId) {
              if (!screenAudioConsumersByUser.has(remoteUserId)) {
                screenAudioConsumersByUser.set(remoteUserId, new Set());
              }
              screenAudioConsumersByUser.get(remoteUserId)!.add(consumer.id);
            }
            audio.play().catch(e => console.error('Audio play failed:', e));
            audioElements.set(consumer.id, audio);

            if (remoteSource === 'screen' && remoteUserId) {
              applyScreenStreamAudioState(remoteUserId);
            }
          }
          
          // Trigger reactivity
          remoteStreams.value = new Map(remoteStreams.value);
          
          chatStore.send('resume_consumer', {
            channel_id: payload.channel_id,
            consumer_id: consumer.id
          });
        } catch (error) {
          console.error('Failed to consume:', error);
        }
        break;

      case 'producer_closed': {
        if (payload.channel_id !== activeVoiceChannelId.value) return;

        const producerId = payload.producer_id as string;
        const source = producerToSource.get(producerId)
          || (payload.source as MediaSourceType | undefined)
          || null;

        console.info('[WebRTC][consume] Producer closed notification', {
          channelId: payload.channel_id,
          producerId,
          source,
          userId: payload.user_id
        });

        const consumerIdsToClose: string[] = [];
        for (const [consumerId, mappedProducerId] of consumerToProducer.entries()) {
          if (mappedProducerId === producerId) {
            consumerIdsToClose.push(consumerId);
          }
        }

        for (const consumerId of consumerIdsToClose) {
          closeConsumer(consumerId, `producer_closed notification (${producerId})`);
        }

        if (source === 'screen') {
          if (!producerToSource.has(producerId) && payload.user_id) {
            deleteUserScreenStream(payload.user_id as string);
          }
          removeUserScreenByProducer(producerId);
        }

        producerToUser.delete(producerId);
        producerToSource.delete(producerId);
        remoteStreams.value = new Map(remoteStreams.value);
        break;
      }
    }
  };

  // Register listener
  chatStore.addMessageListener(handleMessage);

  // Watch for websocket disconnects to clean up voice state
  watch(() => chatStore.isConnected, (isConnected) => {
    if (!isConnected) {
      if (activeVoiceChannelId.value) {
        lastActiveVoiceChannelId.value = activeVoiceChannelId.value;
        leaveVoiceChannel();
      }
      channelParticipants.value = new Map();
    }
  });

  return {
    activeVoiceChannelId,
    voiceParticipants,
    channelParticipants,
    speakingUserIds,
    localStream,
    remoteStreams,
    userScreenStreams,
    screenShareStream,
    screenShareError,
    screenProducer,
    ping,
    bandwidth,
    pingHistory,
    connectionQuality,
    isMuted,
    isDeafened,
    screenStreamMuteState,
    screenStreamPreferenceState,
    screenStreamVolumeState,
    joinVoiceChannel,
    leaveVoiceChannel,
    isUserSpeaking,
    isScreenStreamMuted,
    getScreenStreamVolume,
    setScreenStreamVolume,
    setScreenStreamMuted,
    getScreenStreamPreference,
    getScreenStreamFps,
    getScreenStreamResolution,
    setScreenStreamFps,
    setScreenStreamResolution,
    toggleMute,
    toggleDeafen,
    startScreenShare,
    stopScreenShare
  };
});
