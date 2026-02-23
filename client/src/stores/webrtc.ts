import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
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
  const voiceParticipants = ref<any[]>([]);
  const channelParticipants = ref<Map<string, any[]>>(new Map());
  const localStream = shallowRef<MediaStream | null>(null);
  const remoteStreams = shallowRef<Map<string, MediaStream>>(new Map());
  const audioElements = new Map<string, HTMLAudioElement>();
  
  const producerToUser = new Map<string, string>();
  const consumerToProducer = new Map<string, string>();

  const ping = ref<number>(0);
  const bandwidth = ref<number>(0);
  const pingHistory = ref<number[]>([]);
  const connectionQuality = ref<'good' | 'warning' | 'bad'>('good');
  
  let statsInterval: number | null = null;
  let lastBytesSent = 0;
  let lastBytesReceived = 0;
  let lastStatsTime = 0;

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
    chatStore.send('join_voice_channel', { channel_id: channelId });
  };

  const leaveVoiceChannel = () => {
    if (!activeVoiceChannelId.value) return;
    
    chatStore.send('leave_voice_channel', { channel_id: activeVoiceChannelId.value });
    
    if (localStream.value) {
      localStream.value.getTracks().forEach(track => track.stop());
      localStream.value = null;
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
    
    stopStatsCollection();
  };

  const handleMessage = async (message: any) => {
    const { type, payload } = message;
    
    switch (type) {
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
            localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true });
            const audioTrack = localStream.value.getAudioTracks()[0];
            producer.value = await sendTransport.value.produce({ track: audioTrack });
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
          
          consumer.on('producerclose', () => {
            consumers.value.delete(consumer.id);
            remoteStreams.value.delete(consumer.id);
            remoteStreams.value = new Map(remoteStreams.value);
            const audio = audioElements.get(consumer.id);
            if (audio) {
              audio.pause();
              audio.srcObject = null;
              audioElements.delete(consumer.id);
            }
          });
          
          const stream = new MediaStream();
          stream.addTrack(consumer.track);
          
          // Store the stream with the producer ID or user ID
          // We don't have the user ID here easily, so we'll just use consumer ID
          remoteStreams.value.set(consumer.id, stream);
          
          // Play audio
          const audio = new Audio();
          audio.srcObject = stream;
          audio.autoplay = true;
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

  return {
    activeVoiceChannelId,
    voiceParticipants,
    channelParticipants,
    localStream,
    remoteStreams,
    ping,
    bandwidth,
    pingHistory,
    connectionQuality,
    joinVoiceChannel,
    leaveVoiceChannel
  };
});