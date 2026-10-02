import { computed, onScopeDispose, ref, watch } from 'vue';
import {
  getDriveRoute,
  driveMovementDistance,
  type DriveDestination,
  type DriveNavigationTransport,
  type DriveRoute,
  type MapPosition,
} from '../utils/driveNavigation';
export { driveMovementDistance } from '../utils/driveNavigation';

type DriverPosition = MapPosition & { user_id: string };
type Attempt = { at: number; anchor: MapPosition; failed: boolean; rateLimited?: boolean };
const dispatchStates = new WeakMap<DriveNavigationTransport, { at: number; pending: number }>();

export function useDriveRoutes(
  transport: DriveNavigationTransport,
  getChannelId: () => string,
  getLocations: () => DriverPosition[],
  getDestination: () => DriveDestination | null,
  isJoined: () => boolean,
  requestRoute: typeof getDriveRoute = getDriveRoute,
) {
  const dispatch = dispatchStates.get(transport) ?? { at: -Infinity, pending: 0 };
  dispatchStates.set(transport, dispatch);
  const routes = ref(new Map<string, DriveRoute>());
  const routeErrors = ref(new Map<string, string>());
  const pendingCount = ref(0);
  const scheduled = ref(false);
  const isRouting = computed(() => pendingCount.value > 0 || scheduled.value);
  const pending = new Map<string, AbortController>();
  const attempts = new Map<string, Attempt>();
  let interval: ReturnType<typeof setInterval> | undefined;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const active = () => !disposed && transport.isConnected && isJoined()
    && !!getChannelId() && !!getDestination();

  function cancel(userId: string) {
    const controller = pending.get(userId);
    pending.delete(userId);
    pendingCount.value = pending.size;
    if (controller) {
      dispatch.pending--;
      controller.abort();
    }
  }

  function reset() {
    if (interval !== undefined) clearInterval(interval);
    if (wake !== undefined) clearTimeout(wake);
    interval = undefined;
    wake = undefined;
    scheduled.value = false;
    for (const userId of pending.keys()) cancel(userId);
    attempts.clear();
    routes.value.clear();
    routeErrors.value.clear();
  }

  async function start(driver: DriverPosition, destination: DriveDestination) {
    const userId = driver.user_id;
    const controller = new AbortController();
    const attempt: Attempt = {
      at: Date.now(), anchor: { latitude: driver.latitude, longitude: driver.longitude }, failed: false,
    };
    attempts.set(userId, attempt);
    pending.set(userId, controller);
    dispatch.pending++;
    pendingCount.value = pending.size;
    routeErrors.value.delete(userId);
    try {
      const route = await requestRoute(transport, getChannelId(), userId, destination, controller.signal);
      // Controller identity also rejects late replies after removal, rejoin or target changes.
      if (pending.get(userId) !== controller) return;
      attempt.anchor = route.origin ?? attempt.anchor;
      routes.value.set(userId, route);
    } catch (error) {
      if (pending.get(userId) !== controller) return;
      attempt.failed = true;
      const message = error instanceof Error ? error.message : 'Route unavailable.';
      attempt.rateLimited = message === 'Drive request rate limit exceeded.';
      // Allow a soon retry, but give the server a full quiet window after its rejection.
      if (attempt.rateLimited) dispatch.at = Date.now();
      routeErrors.value.set(userId, message);
    } finally {
      if (pending.get(userId) === controller) {
        pending.delete(userId);
        dispatch.pending--;
        pendingCount.value = pending.size;
        schedule();
      }
    }
  }

  function schedule() {
    if (wake !== undefined) clearTimeout(wake);
    wake = undefined;
    scheduled.value = false;
    if (!active()) return;
    const drivers = new Map(getLocations().map((driver) => [driver.user_id, driver]));
    for (const userId of attempts.keys()) {
      if (!drivers.has(userId)) {
        cancel(userId);
        attempts.delete(userId);
        routes.value.delete(userId);
        routeErrors.value.delete(userId);
      }
    }
    const now = Date.now();
    const eligible = [...drivers.values()].filter((driver) => {
      if (pending.has(driver.user_id)) return false;
      const attempt = attempts.get(driver.user_id);
      if (!attempt || attempt.rateLimited) return true;
      const elapsed = now - attempt.at;
      return elapsed >= 30000 || (!attempt.failed && elapsed >= 15000
        && driveMovementDistance(attempt.anchor, driver) >= 30);
    });
    // Cached results keep their upstream age, but eligibility always uses the attempt throttle.
    eligible.sort((a, b) => (routes.value.get(a.user_id)?.updated_at ?? -1)
      - (routes.value.get(b.user_id)?.updated_at ?? -1)
      || (attempts.get(a.user_id)?.at ?? -Infinity) - (attempts.get(b.user_id)?.at ?? -Infinity));
    scheduled.value = eligible.length > 0;
    if (!eligible.length || dispatch.pending >= 2) return;
    const delay = dispatch.at + 1100 - now;
    if (delay > 0) {
      wake = setTimeout(schedule, delay);
      return;
    }
    dispatch.at = now;
    void start(eligible[0]!, { ...getDestination()! });
    schedule();
  }

  const stopContext = watch(() => [
    transport.isConnected, transport.activeConnectionId, transport.currentUser?.id,
    getChannelId(), isJoined(), getDestination()?.latitude,
    getDestination()?.longitude, getDestination()?.label,
  ], () => {
    reset();
    if (active()) {
      interval = setInterval(schedule, 1000);
      schedule();
    }
  }, { immediate: true, flush: 'sync' });
  const stopLocations = watch(() => getLocations().map(({ user_id, latitude, longitude }) =>
    [user_id, latitude, longitude]), schedule, { deep: true, flush: 'sync' });

  onScopeDispose(() => {
    disposed = true;
    stopContext();
    stopLocations();
    reset();
  });
  return { routes, routeErrors, isRouting };
}
