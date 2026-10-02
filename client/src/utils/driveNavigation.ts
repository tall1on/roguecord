export interface MapPosition {
  latitude: number;
  longitude: number;
}

export interface DriveDestination extends MapPosition {
  label: string;
}

const searchCache = new Map<string, DriveDestination[]>();

export const searchDriveDestinations = async (query: string, signal: AbortSignal): Promise<DriveDestination[]> => {
  const address = query.trim();
  if (address.length < 2 || address.length > 250) throw new Error('Enter an address between 2 and 250 characters.');
  if (signal.aborted) throw new DOMException('Address search cancelled', 'AbortError');
  const endpoint = import.meta.env.VITE_DRIVE_GEOCODER_URL || 'https://photon.komoot.io/api/';
  const key = `${endpoint}:${address.toLowerCase()}`;
  const cached = searchCache.get(key);
  if (cached) return cached;
  const url = new URL(endpoint);
  url.searchParams.set('q', address);
  url.searchParams.set('limit', '5');
  // Only the submitted address is sent to the geocoder, never participants' GPS positions.
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('Address search is unavailable. Please try again later.');
  const data: unknown = await response.json();
  if (signal.aborted) throw new DOMException('Address search cancelled', 'AbortError');
  if (!data || typeof data !== 'object' || !('features' in data) || !Array.isArray(data.features)) {
    throw new Error('Address search returned an invalid response.');
  }
  const destinations: DriveDestination[] = [];
  for (const feature of data.features) {
    const coordinates = feature?.geometry?.coordinates;
    if (feature?.geometry?.type !== 'Point' || !Array.isArray(coordinates)) continue;
    const [longitude, latitude] = coordinates;
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
      || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) continue;
    const properties = feature.properties || {};
    const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
    const parts = [text(properties.name),
      [text(properties.street), text(properties.housenumber)].filter(Boolean).join(' '),
      [text(properties.postcode), text(properties.city || properties.town || properties.village)].filter(Boolean).join(' '),
      text(properties.state), text(properties.country)];
    const label = [...new Set(parts.filter(Boolean))].join(', ') || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    if (!destinations.some((entry) => entry.latitude === latitude && entry.longitude === longitude && entry.label === label)) {
      destinations.push({ latitude, longitude, label });
    }
    if (destinations.length === 5) break;
  }
  if (searchCache.size >= 30) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(key, destinations);
  return destinations;
};

export const getDriveMapCoordinates = (drivers: MapPosition[], destination: MapPosition | null): [number, number][] => {
  const positions = destination ? [...drivers, destination] : drivers;
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
