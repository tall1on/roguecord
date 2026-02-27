import * as mediasoup from 'mediasoup';
import { Worker, Router, Transport, WebRtcTransport, Producer, Consumer } from 'mediasoup/node/lib/types';

let worker: Worker;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isFinite(parsedValue) && parsedValue > 0) {
    return parsedValue;
  }

  console.warn(`[Mediasoup] Invalid positive integer in ${name}: ${rawValue}. Using fallback ${fallback}.`);
  return fallback;
}

const VIDEO_START_BITRATE_KBPS = parsePositiveIntEnv('MEDIA_VIDEO_START_BITRATE_KBPS', 6000);
const VIDEO_MAX_BITRATE_VP8_KBPS = parsePositiveIntEnv('MEDIA_VIDEO_MAX_BITRATE_VP8_KBPS', 25000);
const VIDEO_MAX_BITRATE_H264_KBPS = parsePositiveIntEnv('MEDIA_VIDEO_MAX_BITRATE_H264_KBPS', 30000);
const VIDEO_MAX_BITRATE_VP9_KBPS = parsePositiveIntEnv('MEDIA_VIDEO_MAX_BITRATE_VP9_KBPS', 35000);
const VIDEO_MAX_BITRATE_AV1_KBPS = parsePositiveIntEnv('MEDIA_VIDEO_MAX_BITRATE_AV1_KBPS', 35000);
const TRANSPORT_MAX_INCOMING_BITRATE_BPS = parsePositiveIntEnv('MEDIA_WEBRTC_MAX_INCOMING_BITRATE_BPS', 50000000);
const TRANSPORT_INITIAL_OUTGOING_BITRATE_BPS = parsePositiveIntEnv('MEDIA_WEBRTC_INITIAL_OUTGOING_BITRATE_BPS', 100000000);

export async function createWorker(): Promise<Worker> {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    logTags: [
      'info',
      'ice',
      'dtls',
      'rtp',
      'srtp',
      'rtcp',
    ],
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
}

export function getWorker(): Worker {
  if (!worker) {
    throw new Error('Mediasoup worker not initialized');
  }
  return worker;
}

const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  } as mediasoup.types.RtpCodecCapability,
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    preferredPayloadType: 101,
    parameters: {
      'x-google-start-bitrate': VIDEO_START_BITRATE_KBPS,
      'x-google-max-bitrate': VIDEO_MAX_BITRATE_VP8_KBPS,
    },
  } as mediasoup.types.RtpCodecCapability,
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    preferredPayloadType: 103,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': VIDEO_START_BITRATE_KBPS,
      'x-google-max-bitrate': VIDEO_MAX_BITRATE_H264_KBPS,
    },
  } as mediasoup.types.RtpCodecCapability,
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    preferredPayloadType: 105,
    parameters: {
      'profile-id': 0,
      'x-google-start-bitrate': VIDEO_START_BITRATE_KBPS,
      'x-google-max-bitrate': VIDEO_MAX_BITRATE_VP9_KBPS,
    },
  } as mediasoup.types.RtpCodecCapability,
  {
    kind: 'video',
    mimeType: 'video/AV1',
    clockRate: 90000,
    preferredPayloadType: 107,
    parameters: {
      'x-google-start-bitrate': VIDEO_START_BITRATE_KBPS,
      'x-google-max-bitrate': VIDEO_MAX_BITRATE_AV1_KBPS,
    },
  } as mediasoup.types.RtpCodecCapability,
];

export async function createRouter(): Promise<Router> {
  const currentWorker = getWorker();
  const router = await currentWorker.createRouter({ mediaCodecs });
  return router;
}

// State management for voice channels
export interface Peer {
  id: string;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
  isMuted?: boolean;
  isDeafened?: boolean;
}

export interface Room {
  id: string;
  router: Router;
  peers: Map<string, Peer>;
}

export const rooms = new Map<string, Room>();

export async function getOrCreateRoom(roomId: string): Promise<Room> {
  let room = rooms.get(roomId);
  if (!room) {
    const router = await createRouter();
    room = {
      id: roomId,
      router,
      peers: new Map(),
    };
    rooms.set(roomId, room);
  }
  return room;
}

export function getPeer(room: Room, peerId: string): Peer {
  let peer = room.peers.get(peerId);
  if (!peer) {
    peer = {
      id: peerId,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      isMuted: false,
      isDeafened: false,
    };
    room.peers.set(peerId, peer);
  }
  return peer;
}

export async function createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
  // For remote servers, you MUST set MEDIASOUP_ANNOUNCED_IP to your public IP or domain name.
  // MEDIASOUP_LISTEN_IP defaults to 0.0.0.0 to listen on all interfaces.
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
  const announcedAddress = process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1';

  const transport = await router.createWebRtcTransport({
    listenInfos: [
      {
        protocol: 'udp',
        ip: listenIp,
        announcedAddress: announcedAddress,
        portRange: { min: 10000, max: 10100 }
      },
      {
        protocol: 'tcp',
        ip: listenIp,
        announcedAddress: announcedAddress,
        portRange: { min: 10000, max: 10100 }
      }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: TRANSPORT_INITIAL_OUTGOING_BITRATE_BPS,
  });

  try {
    await transport.setMaxIncomingBitrate(TRANSPORT_MAX_INCOMING_BITRATE_BPS);
  } catch (error) {
    console.warn('[Mediasoup] Failed to set max incoming bitrate for WebRTC transport', {
      maxIncomingBitrate: TRANSPORT_MAX_INCOMING_BITRATE_BPS,
      error,
    });
  }

  return transport;
}
