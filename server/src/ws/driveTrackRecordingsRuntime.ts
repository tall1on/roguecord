import { connectionManager } from './connectionManager';
import { rooms } from '../mediasoup';
import { TRACK_RECORDING_MAX_DURATION_MS } from '../storage/trackRecordingStorage';
import { TrackRecordingManager } from './driveTrackRecordings';

/**
 * Production wiring for the track recording manager: the mediasoup room is the source of truth for
 * whether a driver has a live camera producer, and lifecycle messages are delivered per user.
 */
export const trackRecordings = new TrackRecordingManager(TRACK_RECORDING_MAX_DURATION_MS, {
  hasCameraProducer: (channelId, userId) => {
    const peer = rooms.get(channelId)?.peers.get(userId);
    if (!peer) return false;
    for (const producer of peer.producers.values()) {
      if ((producer.appData as { source?: unknown } | undefined)?.source === 'camera') return true;
    }
    return false;
  },
  sendToUser: (userId, message) => connectionManager.sendToUser(userId, message)
});
