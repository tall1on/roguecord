import { WebSocket } from 'ws';
import { db, channelsSchemaReady } from '../db';
import { getChannelById } from '../models';
import { DriveServiceError, DriveServices, normalizeDriveQuery, readDriveConfig, validCoordinates } from '../driveServices';
import type { ClientConnection } from './connectionManager';
import { DriveParticipants, driveParticipants, validDriveId as validId } from './drive';

type Dependencies = {
  ready: Promise<void>;
  channel: (id: string) => Promise<{ type: string } | undefined>;
  services: () => Pick<DriveServices, 'search' | 'route'>;
  participants: DriveParticipants;
};

export function createDriveNavigationHandler(dependencies: Dependencies) {
  const limits = new WeakMap<ClientConnection, { search: number; route: number; pending: number }>();
  let outstanding = 0;
  return async (client: ClientConnection, type: string, raw: unknown): Promise<void> => {
    const search = type === 'drive_search_destinations';
    const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const requestId = payload.request_id;
    const channelId = payload.channel_id;
    const targetId = payload.user_id;
    const userId = client.userId;
    const identityVersion = client.identityVersion;
    const active = () => client.ws.readyState === WebSocket.OPEN && client.userId === userId && client.identityVersion === identityVersion;
    const identifiers = {
      request_id: validId(requestId) ? requestId : null,
      channel_id: validId(channelId) ? channelId : null,
      ...(!search ? { user_id: validId(targetId) ? targetId : null } : {})
    };
    const reply = (result: Record<string, unknown>) => {
      if (active()) client.ws.send(JSON.stringify({ type: search ? 'drive_destinations' : 'drive_route', payload: { ...identifiers, ...result } }));
    };
    let admitted = false;
    let limit = limits.get(client);
    try {
      if (!validId(requestId) || !validId(channelId) || (!search && !validId(targetId))) throw new DriveServiceError('Invalid request identifiers.');
      if (!userId || !active()) throw new DriveServiceError('Authentication required.');
      const query = search ? normalizeDriveQuery(payload.query) : undefined;
      if (!search && !validCoordinates(payload.destination)) throw new DriveServiceError('Invalid destination coordinates.');
      const requestedDestination = search ? null : {
        latitude: (payload.destination as { latitude: number }).latitude,
        longitude: (payload.destination as { longitude: number }).longitude
      };
      if (!limit) { limit = { search: -Infinity, route: -Infinity, pending: 0 }; limits.set(client, limit); }
      const now = Date.now();
      const kind = search ? 'search' : 'route';
      if (now - limit[kind] < 1000) throw new DriveServiceError('Drive request rate limit exceeded.');
      limit[kind] = now;
      if (limit.pending >= 4 || outstanding >= 128) throw new DriveServiceError('Too many outstanding drive requests. Please try again.');
      limit.pending++;
      outstanding++;
      admitted = true;
      await dependencies.ready;
      const channel = await dependencies.channel(channelId);
      if (!active()) return;
      if (channel?.type !== 'drive') throw new DriveServiceError('Drive channel not found.');
      if (search) {
        const destinations = await dependencies.services().search(query);
        const current = await dependencies.channel(channelId);
        if (!active()) return;
        if (current?.type !== 'drive') throw new DriveServiceError('Drive channel not found.');
        reply({ destinations });
      } else {
        const source = dependencies.participants.readSharedLocation(channelId, client, targetId as string);
        if (!source) throw new DriveServiceError('Join the drive channel and select a participant sharing location.');
        const destination = dependencies.participants.destinationFor(channelId, client);
        if (!destination || destination.latitude !== requestedDestination!.latitude || destination.longitude !== requestedDestination!.longitude) {
          throw new DriveServiceError('Select the shared room destination before requesting a matching route.');
        }
        const currentSource = () => {
          if (!active() || dependencies.participants.destinationFor(channelId, client) !== destination) return null;
          const latest = dependencies.participants.readSharedLocation(channelId, client, targetId as string);
          return latest && latest.membership === source.membership && latest.source === source.source
            && latest.sharingSession === source.sharingSession ? latest.location : null;
        };
        const route = await dependencies.services().route(source.location, { latitude: destination.latitude, longitude: destination.longitude }, {
          channelId, userId: targetId as string,
          resolveOrigin: async () => {
            const current = await dependencies.channel(channelId);
            return current?.type === 'drive' ? currentSource() : null;
          }
        });
        const current = await dependencies.channel(channelId);
        if (!active()) return;
        if (current?.type !== 'drive' || !currentSource()) {
          throw new DriveServiceError('Drive membership, shared location or destination changed. Request a new route.');
        }
        reply({ route });
      }
    } catch (error) {
      reply({ ...(search ? { destinations: [] } : {}),
        error: error instanceof DriveServiceError ? error.message : 'Drive request failed. Please try again later.' });
    } finally {
      if (admitted) { limit!.pending--; outstanding--; }
    }
  };
}

// Imported before dotenv.config() runs; read configuration only on the first authenticated request.
let services: DriveServices | undefined;
export const handleDriveNavigation = createDriveNavigationHandler({
  ready: channelsSchemaReady,
  channel: getChannelById,
  participants: driveParticipants,
  services: () => services ||= new DriveServices(db, readDriveConfig())
});
