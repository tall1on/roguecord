import { watch } from 'vue';

export interface MapPosition {
  latitude: number;
  longitude: number;
}

export interface DriveDestination extends MapPosition {
  label: string;
}

export interface DriveRoute {
  coordinates: [number, number][];
  distance_m: number;
  duration_s: number;
  origin: MapPosition;
  destination: MapPosition;
  provider: 'osrm';
  updated_at: number;
}

type NavigationMessage = { type: string; payload: any };

export interface DriveNavigationTransport {
  isConnected: boolean;
  activeConnectionId: string | null;
  currentUser: { id: string } | null;
  addMessageListener: (listener: (message: NavigationMessage) => void) => void;
  removeMessageListener: (listener: (message: NavigationMessage) => void) => void;
  send: (type: string, payload: any) => void;
}

let nextRequestId = 0;

const requestNavigation = (
  transport: DriveNavigationTransport, type: string, responseType: string, channelId: string,
  payload: Record<string, unknown>, signal: AbortSignal, timeoutMs: number
): Promise<any> => {
  if (signal.aborted) return Promise.reject(new DOMException('Navigation request cancelled', 'AbortError'));
  const connectionId = transport.activeConnectionId;
  const userId = transport.currentUser?.id;
  if (!transport.isConnected || !connectionId || !userId) return Promise.reject(new Error('Connect to the guild before requesting navigation.'));
  const requestId = `drive-${Date.now().toString(36)}-${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopWatching();
      signal.removeEventListener('abort', abort);
      transport.removeMessageListener(listener);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new DOMException('Navigation request cancelled', 'AbortError'));
    const listener = (message: NavigationMessage) => {
      if (message.type === 'authenticated') {
        finish(new Error('The guild authentication changed. Please try again.'));
        return;
      }
      if (message.payload?.request_id !== requestId || transport.activeConnectionId !== connectionId || transport.currentUser?.id !== userId) return;
      if (message.type === 'error') {
        finish(new Error(typeof message.payload.message === 'string' ? message.payload.message : 'Navigation request failed.'));
      } else if (message.type === responseType && message.payload.channel_id === channelId) {
        finish(typeof message.payload.error === 'string' ? new Error(message.payload.error) : null, message.payload);
      }
    };
    const timer = setTimeout(() => finish(new Error('Navigation request timed out. Please try again.')), timeoutMs);
    const stopWatching = watch(() => [transport.isConnected, transport.activeConnectionId, transport.currentUser?.id], () => {
      if (!transport.isConnected || transport.activeConnectionId !== connectionId || transport.currentUser?.id !== userId) {
        finish(new Error('The guild connection changed. Please try again.'));
      }
    }, { flush: 'sync' });
    transport.addMessageListener(listener);
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      else transport.send(type, { ...payload, request_id: requestId, channel_id: channelId });
    } catch {
      finish(new Error('Could not send the navigation request.'));
    }
  });
};

const validPosition = (position: any): boolean => !!position
  && typeof position.latitude === 'number' && Number.isFinite(position.latitude) && Math.abs(position.latitude) <= 90
  && typeof position.longitude === 'number' && Number.isFinite(position.longitude) && Math.abs(position.longitude) <= 180;

export const isDriveDestination = (value: unknown): value is DriveDestination => {
  if (!value || typeof value !== 'object') return false;
  const destination = value as Record<string, unknown>;
  return validPosition(destination) && typeof destination.label === 'string' && !!destination.label.trim()
    && destination.label.length <= 500 && !/[\x00-\x1f\x7f]/.test(destination.label);
};

export function driveMovementDistance(a: MapPosition, b: MapPosition): number {
  const radians = Math.PI / 180;
  const haversine = Math.sin((b.latitude - a.latitude) * radians / 2) ** 2
    + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians)
    * Math.sin((b.longitude - a.longitude) * radians / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function rankDriveParticipants<T extends { id: string }>(participants: T[], locations: ReadonlyMap<string, MapPosition>, destination: MapPosition | null) {
  const entries = participants.map((participant) => {
    const location = locations.get(participant.id);
    return { participant, rank: null as number | null,
      distance_m: destination && validPosition(destination) && location && validPosition(location)
        ? driveMovementDistance(location, destination) : null };
  });
  if (!destination) return entries;
  entries.sort((a, b) => {
    if (a.distance_m === null) return b.distance_m === null ? 0 : 1;
    if (b.distance_m === null) return -1;
    return a.distance_m - b.distance_m || (a.participant.id < b.participant.id ? -1 : a.participant.id > b.participant.id ? 1 : 0);
  });
  let rank = 0;
  for (const entry of entries) if (entry.distance_m !== null) entry.rank = ++rank;
  return entries;
}

export const setDriveDestination = async (
  transport: DriveNavigationTransport, channelId: string, destination: DriveDestination | null, signal: AbortSignal
): Promise<DriveDestination | null> => {
  if (destination !== null && !isDriveDestination(destination)) throw new Error('Choose a valid room destination.');
  const response = await requestNavigation(transport, 'drive_set_destination', 'drive_destination_set', channelId, {
    destination: destination ? { latitude: destination.latitude, longitude: destination.longitude, label: destination.label } : null
  }, signal, 10000);
  if (response.destination !== null && !isDriveDestination(response.destination)) throw new Error('Invalid room destination response.');
  return response.destination;
};

export const searchDriveDestinations = async (
  transport: DriveNavigationTransport, channelId: string, query: string, signal: AbortSignal
): Promise<DriveDestination[]> => {
  const address = query.trim();
  if (address.length < 2 || address.length > 250) throw new Error('Enter an address between 2 and 250 characters.');
  const response = await requestNavigation(transport, 'drive_search_destinations', 'drive_destinations', channelId, { query: address }, signal, 20000);
  if (!Array.isArray(response.destinations) || response.destinations.length > 5
    || response.destinations.some((entry: any) => !validPosition(entry) || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 2000)) {
    throw new Error('Address search returned an invalid response.');
  }
  return response.destinations;
};

export const getDriveRoute = async (
  transport: DriveNavigationTransport, channelId: string, userId: string, destination: MapPosition, signal: AbortSignal
): Promise<DriveRoute> => {
  if (!validPosition(destination)) throw new Error('Choose a valid destination.');
  const response = await requestNavigation(transport, 'drive_get_route', 'drive_route', channelId, {
    user_id: userId, destination: { latitude: destination.latitude, longitude: destination.longitude }
  }, signal, 60000);
  const route = response.route;
  if (response.user_id !== userId || !route || route.provider !== 'osrm'
    || !validPosition(route.origin) || !validPosition(route.destination)
    || Math.abs(route.destination.latitude - destination.latitude) > 0.00001 || Math.abs(route.destination.longitude - destination.longitude) > 0.00001
    || typeof route.distance_m !== 'number' || !Number.isFinite(route.distance_m) || route.distance_m < 0
    || typeof route.duration_s !== 'number' || !Number.isFinite(route.duration_s) || route.duration_s < 0
    || typeof route.updated_at !== 'number' || !Number.isFinite(route.updated_at) || route.updated_at < 0
    || !Array.isArray(route.coordinates) || route.coordinates.length < 2 || route.coordinates.length > 50000
    || route.coordinates.some((point: any) => !Array.isArray(point) || point.length !== 2 || !validPosition({ longitude: point[0], latitude: point[1] }))) {
    throw new Error('The routing service returned an invalid street route.');
  }
  return route;
};

export const getDriveMapCoordinates = (drivers: MapPosition[], destination: MapPosition | null, routePositions: MapPosition[] = []): [number, number][] => {
  const positions = [...drivers, ...(destination ? [destination] : []), ...routePositions];
  const longitudes = positions.map((point) => (point.longitude + 360) % 360).sort((a, b) => a - b);
  let startLongitude = longitudes[0] ?? 0;
  let largestGap = -1;
  // Include the destination when finding the smallest longitude span, including date-line crossings.
  for (let index = 0; index < longitudes.length; index++) {
    const next = longitudes[(index + 1) % longitudes.length]! + (index === longitudes.length - 1 ? 360 : 0);
    const gap = next - longitudes[index]!;
    if (gap > largestGap) {
      largestGap = gap;
      startLongitude = next % 360;
    }
  }
  return positions.map((point) => {
    let longitude = (point.longitude + 360) % 360;
    if (longitude < startLongitude) longitude += 360;
    return [point.latitude, longitude];
  });
};
