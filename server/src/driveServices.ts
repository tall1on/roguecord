import { createHash } from 'node:crypto';
import type sqlite3 from 'sqlite3';

export type Coordinates = { latitude: number; longitude: number };
export type Destination = Coordinates & { label: string };
export type StreetRoute = {
  coordinates: [number, number][]; distance_m: number; duration_s: number;
  origin: Coordinates; destination: Coordinates; provider: 'osrm'; updated_at: number;
};
export type RouteDispatchContext = {
  channelId: string; userId: string;
  resolveOrigin: () => Promise<Coordinates | null>;
};
export class DriveServiceError extends Error {}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new DriveServiceError('Drive provider unavailable. Please try again later.');

export function validCoordinates(value: unknown): value is Coordinates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { latitude, longitude } = value as Coordinates;
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

export function normalizeDriveQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000) throw new DriveServiceError('Search query must be 2 to 250 characters.');
  const query = value.trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 250 || /[\x00-\x1f\x7f]/.test(query)) throw new DriveServiceError('Search query must be 2 to 250 characters.');
  return query;
}

function endpoint(value: string | undefined, fallback: string, provider: string): string {
  const configured = value === undefined ? fallback : value.trim();
  if (!configured) return '';
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch { throw new DriveServiceError(`${provider} endpoint configuration is invalid.`); }
}

export type DriveConfig = { photonUrl: string; osrmUrl: string; geocodeTtlMs: number; emptyTtlMs: number; maxRows: number };
export function readDriveConfig(env: NodeJS.ProcessEnv = process.env): DriveConfig {
  const integer = (name: string, fallback: number, max: number) => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new DriveServiceError(`Invalid ${name} configuration.`);
    return value;
  };
  return {
    photonUrl: endpoint(env.DRIVE_PHOTON_URL, 'https://photon.komoot.io/api/', 'Photon'),
    osrmUrl: endpoint(env.DRIVE_OSRM_URL, 'https://router.project-osrm.org', 'OSRM'),
    geocodeTtlMs: integer('DRIVE_GEOCODE_TTL_SECONDS', 604800, 31536000) * 1000,
    emptyTtlMs: integer('DRIVE_GEOCODE_EMPTY_TTL_SECONDS', 300, 3600) * 1000,
    maxRows: integer('DRIVE_GEOCODE_MAX_ROWS', 1000, 100000)
  };
}

type Job = { run: (markStarted: () => void) => Promise<unknown>; priority: () => number; deferredStart: boolean;
  resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
// One active fetch per provider, starts at least one second apart even after failures.
export class ProviderQueue {
  private waiting: Job[] = [];
  private active = false;
  private nextStart = 0;
  private wake?: ReturnType<typeof setTimeout>;
  constructor(private maxWaiting: number, private maxWaitMs: number) {}

  submit<T>(run: (markStarted: () => void) => Promise<T>, priority: () => number = () => 0, deferredStart = false): Promise<T> {
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new DriveServiceError('Drive provider busy. Please try again later.'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { run, priority, deferredStart, resolve, reject, timer: setTimeout(() => {
        const index = this.waiting.indexOf(job);
        if (index !== -1) {
          this.waiting.splice(index, 1);
          reject(new DriveServiceError('Drive provider queue timed out. Please try again.'));
        }
      }, this.maxWaitMs) };
      this.waiting.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || this.wake || !this.waiting.length) return;
    const delay = this.nextStart - Date.now();
    if (delay > 0) {
      this.wake = setTimeout(() => { this.wake = undefined; this.pump(); }, delay);
      return;
    }
    let index = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      if (this.waiting[i].priority() < this.waiting[index].priority()) index = i;
    }
    const job = this.waiting.splice(index, 1)[0];
    clearTimeout(job.timer);
    this.active = true;
    const markStarted = () => { this.nextStart = Date.now() + 1000; };
    // OSRM preflight awaits may take time; pace from the actual fetch, not queue selection.
    if (!job.deferredStart) markStarted();
    void job.run(markStarted).then(job.resolve, job.reject).finally(() => { this.active = false; this.pump(); });
  }
}

export class DriveServices {
  private searchInflight = new Map<string, Promise<Destination[]>>();
  private routeInflight = new Map<string, { work: Promise<StreetRoute>; readers: Set<RouteDispatchContext['resolveOrigin']> }>();
  private routeCache = new Map<string, { expires: number; route: StreetRoute }>();
  private routeUpdates = new Map<string, number>();
  private photonQueue = new ProviderQueue(8, 8000);
  private osrmQueue = new ProviderQueue(32, 40000);
  private jobs = 0;
  constructor(private db: sqlite3.Database, private config: DriveConfig,
    private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}

  private run(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => this.db.run(sql, params, (error) => error ? reject(unavailable()) : resolve()));
  }

  private async json(url: URL, timeout: number, maxBytes: number, osrm = false, markStarted?: () => void): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      // No redirects: a configured proxy must not redirect requests (or GPS) to another host.
      const pending = this.fetcher(url, { signal: controller.signal, redirect: 'error',
        headers: { 'User-Agent': 'Roguecord/1.0 (self-hosted drive integration)', Accept: 'application/json' } });
      markStarted?.();
      const response = await pending;
      if ((!response.ok && !(osrm && response.status === 400)) || !response.body) throw unavailable();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { controller.abort(); throw unavailable(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok && !['NoRoute', 'NoSegment'].includes(data?.code)) throw unavailable();
      return data;
    } catch {
      if (controller.signal.aborted) throw new DriveServiceError('Drive provider request timed out or exceeded response limits.');
      throw unavailable();
    } finally { clearTimeout(timer); controller.abort(); }
  }

  private bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.jobs >= 128) return Promise.reject(new DriveServiceError('Drive provider busy. Please try again later.'));
    this.jobs++;
    return work().finally(() => { this.jobs--; });
  }

  search(value: unknown): Promise<Destination[]> {
    const query = normalizeDriveQuery(value);
    if (!this.config.photonUrl) throw new DriveServiceError('Destination search is disabled. Configure DRIVE_PHOTON_URL.');
    const key = hash(JSON.stringify([this.config.photonUrl, query.toLowerCase()]));
    const existing = this.searchInflight.get(key);
    if (existing) return existing;
    const work = this.bounded(async () => {
      await this.prune();
      const row = await new Promise<{ results_json: string; expires_at: number } | undefined>((resolve, reject) => {
        this.db.get('SELECT results_json, expires_at FROM drive_geocode_cache WHERE cache_key = ?', [key],
          (error, row: { results_json: string; expires_at: number } | undefined) => error ? reject(unavailable()) : resolve(row));
      });
      if (row && row.expires_at > this.now()) {
        try {
          const results: unknown = JSON.parse(row.results_json);
          if (validDestinations(results)) return results.map(({ latitude, longitude, label }) => ({ latitude, longitude, label }));
        } catch { /* Invalid persisted data is replaced, never sent to clients. */ }
      }
      const results = await this.photonQueue.submit(async (markStarted) => {
        const url = new URL(this.config.photonUrl);
        url.searchParams.set('q', query);
        url.searchParams.set('limit', '5');
        return parsePhoton(await this.json(url, 10000, 262144, false, markStarted));
      });
      const now = this.now();
      await this.run('INSERT OR REPLACE INTO drive_geocode_cache(cache_key, results_json, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [key, JSON.stringify(results), now + (results.length ? this.config.geocodeTtlMs : this.config.emptyTtlMs), now]);
      await this.prune();
      return results;
    });
    this.searchInflight.set(key, work);
    void work.finally(() => this.searchInflight.delete(key)).catch(() => {});
    return work;
  }

  private async prune(): Promise<void> {
    await this.run('DELETE FROM drive_geocode_cache WHERE expires_at <= ?', [this.now()]);
    await this.run(`DELETE FROM drive_geocode_cache WHERE cache_key IN
      (SELECT cache_key FROM drive_geocode_cache ORDER BY created_at DESC, cache_key LIMIT -1 OFFSET ?)`, [this.config.maxRows]);
  }

  route(origin: Coordinates, destination: Coordinates, context?: RouteDispatchContext): Promise<StreetRoute> {
    if (!validCoordinates(origin) || !validCoordinates(destination)) throw new DriveServiceError('Invalid route coordinates.');
    if (!this.config.osrmUrl) throw new DriveServiceError('Street routing is disabled. Configure DRIVE_OSRM_URL to enable OSRM.');
    const coordinateKey = (from: Coordinates) => hash(JSON.stringify([this.config.osrmUrl, from.latitude, from.longitude, destination.latitude, destination.longitude]));
    const key = coordinateKey(origin);
    const priorityKey = context ? hash(JSON.stringify([this.config.osrmUrl, context.channelId, context.userId, destination.latitude, destination.longitude])) : key;
    const existing = this.routeInflight.get(priorityKey);
    if (existing) {
      if (context) {
        if (existing.readers.size >= 128) throw new DriveServiceError('Drive provider busy. Please try again later.');
        existing.readers.add(context.resolveOrigin);
      }
      return existing.work;
    }
    for (const [key, entry] of this.routeCache) if (entry.expires <= this.now()) this.routeCache.delete(key);
    const cached = this.routeCache.get(key);
    if (cached) return Promise.resolve(cached.route);
    // Copy only the coordinate pair, never accuracy, user IDs, or other shared GPS metadata.
    const initial = { latitude: origin.latitude, longitude: origin.longitude };
    const to = { latitude: destination.latitude, longitude: destination.longitude };
    const readers = new Set<RouteDispatchContext['resolveOrigin']>(context ? [context.resolveOrigin] : []);
    const deadline = Date.now() + 55000;
    const work = this.bounded(() => this.osrmQueue.submit(async (markStarted) => {
      let from: Coordinates | null = context ? null : initial;
      for (const reader of readers) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new DriveServiceError('Drive route request timed out. Please try again.');
        let timer!: ReturnType<typeof setTimeout>;
        try {
          const current = await Promise.race([reader(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new DriveServiceError('Drive route request timed out. Please try again.')), remaining);
          })]);
          if (validCoordinates(current)) { from = { latitude: current.latitude, longitude: current.longitude }; break; }
        } finally { clearTimeout(timer); }
      }
      if (!from) throw new DriveServiceError('Drive membership or shared location changed. Request a new route.');
      const dispatchKey = coordinateKey(from);
      const cached = this.routeCache.get(dispatchKey);
      if (cached && cached.expires > this.now()) return cached.route;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DriveServiceError('Drive route request timed out. Please try again.');
      const url = new URL(this.config.osrmUrl);
      url.pathname = `${url.pathname.replace(/\/$/, '')}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
      // Avoid silently routing from a distant road when either waypoint is off the road network.
      for (const [key, value] of Object.entries({ overview: 'full', geometries: 'geojson', steps: 'false', alternatives: 'false', radiuses: '1000;1000' })) url.searchParams.set(key, value);
      const route = parseOsrm(await this.json(url, Math.min(15000, remaining), 4194304, true, markStarted), from, to, this.now());
      this.routeCache.set(dispatchKey, { route, expires: route.updated_at + 30000 });
      while (this.routeCache.size > 128) this.routeCache.delete(this.routeCache.keys().next().value!);
      // Cache reads do not touch priority. Keep this history bounded and only in memory.
      this.routeUpdates.delete(priorityKey);
      this.routeUpdates.set(priorityKey, route.updated_at);
      while (this.routeUpdates.size > 1024) this.routeUpdates.delete(this.routeUpdates.keys().next().value!);
      return route;
    }, () => this.routeUpdates.get(priorityKey) ?? -Infinity, true));
    this.routeInflight.set(priorityKey, { work, readers });
    void work.finally(() => this.routeInflight.delete(priorityKey)).catch(() => {});
    return work;
  }
}

function validDestinations(value: unknown): value is Destination[] {
  return Array.isArray(value) && value.length <= 5 && value.every((item) => {
    const label = item?.label;
    return validCoordinates(item) && typeof label === 'string' && label.length > 0 && label.length <= 500 && !/[\x00-\x1f\x7f]/.test(label);
  });
}

export function parsePhoton(data: any): Destination[] {
  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > 100) throw unavailable();
  const results: Destination[] = [];
  for (const feature of data.features) {
    const pair = feature?.geometry?.coordinates;
    const properties = feature?.properties;
    if (feature?.geometry?.type !== 'Point' || !Array.isArray(pair) || pair.length !== 2 || !properties || typeof properties !== 'object') throw unavailable();
    const point = { longitude: pair[0], latitude: pair[1] };
    if (!validCoordinates(point)) throw unavailable();
    const street = [properties.street, properties.housenumber].filter((value) => typeof value === 'string' && value.trim()).join(' ');
    const parts = [properties.name, street, properties.postcode, properties.city || properties.town || properties.village, properties.state, properties.country]
      .filter((value): value is string => typeof value === 'string' && !!value.trim()).map((value) => value.trim());
    const label = [...new Set(parts)].join(', ').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').slice(0, 500).trim();
    if (!label) throw unavailable();
    if (results.length < 5) results.push({ ...point, label });
  }
  return results;
}

export function parseOsrm(data: any, origin: Coordinates, destination: Coordinates, updatedAt = Date.now()): StreetRoute {
  if (data?.code === 'NoRoute') throw new DriveServiceError('No street route found between these locations.');
  if (data?.code === 'NoSegment') throw new DriveServiceError('No routable road found near one of these locations.');
  const route = data?.routes?.[0];
  const geometry = route?.geometry;
  if (data?.code !== 'Ok' || geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)
    || geometry.coordinates.length < 2 || geometry.coordinates.length > 50000
    || !geometry.coordinates.every((pair: unknown) => Array.isArray(pair) && pair.length === 2 && validCoordinates({ longitude: pair[0], latitude: pair[1] }))
    || typeof route.distance !== 'number' || !Number.isFinite(route.distance) || route.distance < 0
    || typeof route.duration !== 'number' || !Number.isFinite(route.duration) || route.duration < 0) throw unavailable();
  return { coordinates: geometry.coordinates, distance_m: route.distance, duration_s: route.duration, origin, destination, provider: 'osrm', updated_at: updatedAt };
}
