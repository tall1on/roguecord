import type { Room } from '../mediasoup';

export const formatCallDurationHms = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
};

// Computes + logs duration for a call that is ending. Caller handles rooms.delete + broadcast.
export const logVoiceCallEnded = (channelId: string, room: Room): void => {
  const startedAt = room.callStartedAt;
  if (startedAt == null) return;
  const durationMs = Date.now() - startedAt;
  console.log(`[VOICE] Call ended in channel ${channelId} — duration ${formatCallDurationHms(durationMs)} (${durationMs} ms)`);
};
