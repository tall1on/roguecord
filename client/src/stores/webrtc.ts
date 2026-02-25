import { defineStore } from 'pinia';
import { ref, shallowRef, watch } from 'vue';
import { Device } from 'mediasoup-client';
import { useChatStore } from './chat';

export const useWebRtcStore = defineStore('webrtc', () => {
  const chatStore = useChatStore();
  
  const device = shallowRef<Device | null>(null);
  const sendTransport = shallowRef<any | null>(null);
  const recvTransport = shallowRef<any | null>(null);
  const producer = shallowRef<any | null>(null);
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
  const consumerToProducer = new Map<string, string>();

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
    consumerToProducer.clear();
    
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
              producerToUser.delete(prodId);
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
          
          sendTransport.value.on('produce', async ({ kind, rtpParameters }: any, callback: any, _errback: any) => {
            chatStore.send('produce', {
              channel_id: payload.channel_id,
              transport_id: sendTransport.value!.id,
              kind,
              rtpParameters
            });
            
            // We need the producer ID from the server
            // We'll handle this in the 'produced' event
            // But mediasoup-client expects the ID in the callback
            // We'll use a temporary listener
            const onProduced = (msg: any) => {
              if (msg.type === 'produced' && msg.payload.channel_id === payload.channel_id) {
                chatStore.removeMessageListener(onProduced);
                callback({ id: msg.payload.id });
              }
            };
            chatStore.addMessageListener(onProduced);
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
          
          consumer.on('producerclose', () => {
            consumers.value.delete(consumer.id);
            remoteStreams.value.delete(consumer.id);
            remoteStreams.value = new Map(remoteStreams.value);
            removeSpeakingDetector(consumer.id);
            const audio = audioElements.get(consumer.id);
            if (audio) {
              audio.pause();
              audio.srcObject = null;
              audioElements.delete(consumer.id);
            }
          });
          
          const stream = new MediaStream();
          stream.addTrack(consumer.track);

          if (remoteUserId) {
            addSpeakingDetector(consumer.id, remoteUserId, stream);
          }
          
          // Store the stream with the producer ID or user ID
          // We don't have the user ID here easily, so we'll just use consumer ID
          remoteStreams.value.set(consumer.id, stream);
          
          // Play audio
          const audio = new Audio();
          audio.srcObject = stream;
          audio.autoplay = true;
          if (isDeafened.value) {
            audio.muted = true;
          }
          audio.play().catch(e => console.error('Audio play failed:', e));
          audioElements.set(consumer.id, audio);
          
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
    ping,
    bandwidth,
    pingHistory,
    connectionQuality,
    isMuted,
    isDeafened,
    joinVoiceChannel,
    leaveVoiceChannel,
    isUserSpeaking,
    toggleMute,
    toggleDeafen
  };
});
