import * as mediasoup from 'mediasoup';
import { Worker, Router, Transport, WebRtcTransport, Producer, Consumer } from 'mediasoup/node/lib/types';

let worker: Worker;

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
      'x-google-start-bitrate': 1000,
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
      'x-google-start-bitrate': 1000,
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

  return await router.createWebRtcTransport({
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
    initialAvailableOutgoingBitrate: 100000000,
  });
}
