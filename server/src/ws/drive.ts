import { WebSocket } from 'ws';
import type { ClientConnection } from './connectionManager';

type Location = { latitude: number; longitude: number; accuracy: number; speed: number | null; updated_at: number };
type Participant = { client: ClientConnection; location: Location | null; sharingSession: object | null; lastUpdate: number | null };

export class DriveParticipants {
  private channels = new Map<string, Map<string, Participant>>();

  owns(channelId: string, client: ClientConnection): boolean {
    return !!client.userId && this.channels.get(channelId)?.get(client.userId)?.client === client;
  }

  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  readSharedLocation(channelId: string, client: ClientConnection, userId: string) {
    if (!this.owns(channelId, client) || client.ws.readyState !== WebSocket.OPEN) return null;
    const participants = this.channels.get(channelId)!;
    const source = participants.get(userId);
    if (!source?.location || source.client.userId !== userId || source.client.ws.readyState !== WebSocket.OPEN) return null;
    // Tokens detect leave/rejoin and clear/re-share, without invalidating routes on every normal GPS fix.
    return { membership: participants.get(client.userId!) as object, source: source as object,
      sharingSession: source.sharingSession, location: source.location as Readonly<Location> };
  }

  admit(channelId: string, client: ClientConnection): void {
    if (!client.userId || client.ws.readyState !== WebSocket.OPEN) throw new Error('Connection is not active');
    const participants = this.channels.get(channelId) || new Map<string, Participant>();
    const existing = participants.get(client.userId);
    if (existing && existing.client !== client) throw new Error('Drive channel already joined on another connection');
    if (!existing) participants.set(client.userId, { client, location: null, sharingSession: null, lastUpdate: null });
    this.channels.set(channelId, participants);
  }

  snapshot(channelId: string, client: ClientConnection): void {
    if (!this.owns(channelId, client)) return;
    client.ws.send(JSON.stringify({
      type: 'drive_locations',
      payload: {
        channel_id: channelId,
        generated_at: Date.now(),
        locations: Array.from(this.channels.get(channelId)!.entries())
          .flatMap(([user_id, participant]) => participant.location ? [{ user_id, ...participant.location }] : [])
      }
    }));
  }

  update(channelId: string, client: ClientConnection, value: unknown, now = Date.now()): void {
    if (!this.owns(channelId, client) || client.ws.readyState !== WebSocket.OPEN) throw new Error('Join the drive channel before sharing location');
    const participant = this.channels.get(channelId)!.get(client.userId!)!;
    if (value === null) {
      // Clearing is never throttled; repeated clears do not generate relay traffic.
      if (participant.location) {
        participant.location = null;
        participant.sharingSession = null;
        this.relay(channelId, client.userId!, null);
      }
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid drive location');
    const { latitude, longitude, accuracy, speed } = value as Record<string, unknown>;
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 40075017
      || (speed != null && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0 || speed > 400))) {
      throw new Error('Invalid drive location');
    }
    // Allow a little arrival jitter for clients publishing one GPS fix per second.
    if (participant.lastUpdate !== null && now - participant.lastUpdate < 750) throw new Error('Drive location rate limit exceeded');
    participant.lastUpdate = now;
    participant.sharingSession ||= {};
    participant.location = { latitude, longitude, accuracy, speed: (speed as number | null | undefined) ?? null, updated_at: now };
    this.relay(channelId, client.userId!, participant.location);
  }

  leave(channelId: string, client: ClientConnection): void {
    if (!this.owns(channelId, client)) return;
    const participants = this.channels.get(channelId)!;
    participants.delete(client.userId!);
    this.relay(channelId, client.userId!, null);
    if (!participants.size) this.channels.delete(channelId);
  }

  removeChannel(channelId: string): void {
    const participants = this.channels.get(channelId);
    if (!participants) return;
    for (const userId of participants.keys()) this.relay(channelId, userId, null);
    this.channels.delete(channelId);
  }

  channelsFor(client: ClientConnection): string[] {
    return Array.from(this.channels.keys()).filter((id) => this.owns(id, client));
  }

  private relay(channelId: string, userId: string, location: Location | null): void {
    const data = JSON.stringify({ type: 'drive_location_updated', payload: { channel_id: channelId, user_id: userId, location } });
    for (const { client } of this.channels.get(channelId)?.values() || []) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(data);
    }
  }
}

export const driveParticipants = new DriveParticipants();
