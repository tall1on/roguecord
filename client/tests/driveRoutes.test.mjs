import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { effectScope, reactive, ref } from 'vue'

let server
let useDriveRoutes
let driveMovementDistance
before(async () => {
  server = await createServer({
    configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom',
  })
  ;({ useDriveRoutes, driveMovementDistance } = await server.ssrLoadModule('/src/composables/useDriveRoutes.ts'))
})
after(async () => server?.close())

const driver = (user_id, longitude = 0) => ({ user_id, latitude: 0, longitude })
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

function setup(context, { drivers = [driver('a')], joined = true, destination = true } = {}) {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 100000 })
  const transport = reactive({
    isConnected: true, activeConnectionId: 'server-a', currentUser: { id: 'me' },
    addMessageListener() {}, removeMessageListener() {}, send() {},
  })
  const channel = ref('trip')
  const locations = ref(drivers)
  const target = ref(destination ? { latitude: 1, longitude: 1, label: 'Target' } : null)
  const admitted = ref(joined)
  const calls = []
  const requestRoute = (connection, channelId, userId, destination, signal) => new Promise((resolve, reject) => {
    calls.push({ connection, channelId, userId, destination, signal, resolve, reject, at: Date.now(),
      origin: { ...locations.value.find((entry) => entry.user_id === userId) } })
  })
  const mount = () => {
    const scope = effectScope()
    const result = scope.run(() => useDriveRoutes(transport, () => channel.value,
      () => locations.value, () => target.value, () => admitted.value, requestRoute))
    context.after(() => scope.stop())
    return { ...result, scope }
  }
  const result = mount()
  const succeed = async (index, origin = calls[index].origin, updatedAt = Date.now()) => {
    const call = calls[index]
    call.resolve({ coordinates: [[origin.longitude, origin.latitude],
      [call.destination.longitude, call.destination.latitude]], distance_m: 100, duration_s: 10,
    origin: { latitude: origin.latitude, longitude: origin.longitude },
    destination: call.destination, provider: 'osrm', updated_at: updatedAt })
    await flush()
  }
  const tick = async (ms) => { context.mock.timers.tick(ms); await flush() }
  const advanceTo = (at) => tick(at - Date.now())
  return { ...result, transport, channel, locations, target, admitted, calls, succeed, tick, advanceTo, mount }
}

test('starts immediately, limits concurrency to two and prioritizes unattempted drivers', async (context) => {
  const state = setup(context, { drivers: ['a', 'b', 'c', 'd'].map((id) => driver(id)) })
  assert.deepEqual(state.calls.map((call) => call.userId), ['a'])
  assert.equal(state.isRouting.value, true)
  assert.equal(state.routes.value.size, 0)
  await state.tick(1099)
  assert.equal(state.calls.length, 1)
  await state.tick(1)
  assert.equal(state.calls[1].userId, 'b')
  await state.advanceTo(115000)
  state.locations.value[0].longitude = 0.001
  await state.succeed(0)
  assert.deepEqual(state.calls.map((call) => call.userId), ['a', 'b', 'c'])
  assert.equal(state.routes.value.size, 1)
  await state.succeed(1)
  assert.equal(state.calls.length, 3)
  await state.tick(1100)
  assert.equal(state.calls[3].userId, 'd')
  await state.succeed(2)
  await state.tick(1100)
  assert.equal(state.calls[4].userId, 'a')
  assert.equal(state.routes.value.has('a'), true)
  await state.succeed(3)
  await state.succeed(4)
  assert.equal(state.routes.value.size, 4)
  assert.equal(state.isRouting.value, false)
})

test('requires 30m movement and 15s throttle, ignores metadata and refreshes stationary routes at 30s', async (context) => {
  const state = setup(context)
  await state.succeed(0)
  state.locations.value[0].speed = 50
  state.locations.value[0].accuracy = 3
  state.locations.value[0].voice = true
  context.mock.timers.tick(15000)
  assert.equal(state.calls.length, 1)
  state.locations.value[0].longitude = 0.0002
  assert.equal(state.calls.length, 1)
  state.locations.value[0].longitude = 0.0003
  assert.equal(state.calls.length, 2)
  assert.equal(state.routes.value.size, 1)
  await state.succeed(1)
  state.locations.value[0].longitude = 0.001
  context.mock.timers.tick(14000)
  assert.equal(state.calls.length, 2)
  context.mock.timers.tick(1000)
  assert.equal(state.calls.length, 3)
  await state.succeed(2)
  context.mock.timers.tick(29000)
  assert.equal(state.calls.length, 3)
  context.mock.timers.tick(1000)
  assert.equal(state.calls.length, 4)
  assert.equal(state.routes.value.size, 1)
  await state.succeed(3)
  context.mock.timers.tick(30000)
  assert.equal(state.calls.length, 5)
})

test('anchors movement at the server execution origin rather than the request origin', async (context) => {
  const state = setup(context)
  state.locations.value[0].longitude = 0.001
  await state.succeed(0, { latitude: 0, longitude: 0.001 })
  context.mock.timers.tick(15000)
  assert.equal(state.calls.length, 1)
  state.locations.value[0].longitude = 0.0012
  assert.equal(state.calls.length, 1)
  state.locations.value[0].longitude = 0.0013
  assert.equal(state.calls.length, 2)
})

test('oldest upstream timestamp takes priority over attempt age and driver order', async (context) => {
  const state = setup(context, { drivers: ['a', 'b', 'c'].map((id) => driver(id)) })
  await state.succeed(0, undefined, 90000)
  await state.tick(1100)
  await state.succeed(1, undefined, 10000)
  await state.tick(1100)
  await state.succeed(2, undefined, 50000)
  await state.tick(15000)
  state.locations.value = ['a', 'c', 'b'].map((id) => driver(id, 0.001))
  assert.equal(state.calls[3].userId, 'b')
  await state.succeed(3)
  await state.tick(1100)
  assert.equal(state.calls[4].userId, 'c')
  await state.succeed(4)
  await state.tick(1100)
  assert.equal(state.calls[5].userId, 'a')
  await state.succeed(5)
  await state.advanceTo(134400)
  state.locations.value[0].longitude = 0.002
  assert.equal(state.calls[6].userId, 'a')
  await state.succeed(6)
  await state.advanceTo(147200)
  await state.tick(800)
  assert.equal(state.calls[7].userId, 'b')
  await state.succeed(7)
  await state.tick(1100)
  assert.equal(state.calls[8].userId, 'c')
  assert.equal(state.routes.value.size, 3)
})

test('cached timestamps preserve priority without immediate refetch or starving another eligible driver', async (context) => {
  const state = setup(context, { drivers: ['a', 'b', 'c'].map((id) => driver(id)) })
  await state.succeed(0, undefined, 1000)
  await state.tick(1100)
  await state.succeed(1, undefined, 2000)
  await state.tick(1100)
  await state.succeed(2, undefined, 3000)
  await state.advanceTo(130000)
  assert.equal(state.calls[3].userId, 'a')
  await state.succeed(3, undefined, 1000)
  await state.tick(2000)
  assert.equal(state.calls[4].userId, 'b')
  await state.succeed(4, undefined, 2000)
  await state.tick(1100)
  assert.equal(state.calls[5].userId, 'c')
  await state.succeed(5, undefined, 3000)
  assert.equal(state.routes.value.get('a').updated_at, 1000)
  assert.equal(state.calls.length, 6)
  await state.advanceTo(144999)
  state.locations.value[0].longitude = 0.001
  assert.equal(state.calls.length, 6)
  await state.tick(1)
  assert.equal(state.calls[6].userId, 'a')
  await state.succeed(6, { latitude: 0, longitude: 0 }, 1000)
  assert.equal(state.calls.length, 7)
  await state.tick(14999)
  assert.equal(state.calls.length, 7)
  await state.tick(1)
  assert.equal(state.calls[7].userId, 'a')
  await state.succeed(7, { latitude: 0, longitude: 0 }, 1000)
  await state.advanceTo(162000)
  assert.equal(state.calls[8].userId, 'b')
  await state.succeed(8, undefined, 2000)
  await state.tick(1100)
  assert.equal(state.calls[9].userId, 'c')
})

test('never-routed drivers and oldest failed attempts take priority over valid routes', async (context) => {
  const state = setup(context, { drivers: ['a', 'b', 'c'].map((id) => driver(id)) })
  await state.succeed(0, undefined, 0)
  await state.tick(1100)
  state.calls[1].reject(new Error('Unavailable b'))
  await flush()
  await state.tick(1100)
  state.calls[2].reject(new Error('Unavailable c'))
  await flush()
  await state.advanceTo(129999)
  state.locations.value.push(driver('d'), driver('e'))
  assert.deepEqual(state.calls.slice(3).map((call) => call.userId), ['d'])
  await state.tick(1100)
  assert.equal(state.calls[4].userId, 'e')
  state.locations.value = [...state.locations.value].reverse()
  await state.tick(1101)
  await state.succeed(3)
  assert.equal(state.calls[5].userId, 'b')
  await state.succeed(4)
  await state.tick(1100)
  assert.equal(state.calls[6].userId, 'c')
  await state.succeed(5)
  await state.tick(1100)
  assert.equal(state.calls[7].userId, 'a')
})

test('stationary refresh remains pending once only and cleared GPS cannot return stale data', async (context) => {
  const state = setup(context)
  await state.succeed(0)
  context.mock.timers.tick(30000)
  assert.equal(state.calls.length, 2)
  assert.equal(state.routes.value.size, 1)
  context.mock.timers.tick(120000)
  state.locations.value[0].speed = 20
  assert.equal(state.calls.length, 2)
  state.locations.value = []
  assert.equal(state.calls[1].signal.aborted, true)
  assert.equal(state.routes.value.size, 0)
  state.locations.value = [driver('a', 0.002)]
  assert.equal(state.calls.length, 3)
  await state.succeed(1)
  assert.equal(state.routes.value.size, 0)
  assert.equal(state.isRouting.value, true)
  await state.succeed(2)
  assert.equal(state.routes.value.get('a').origin.longitude, 0.002)
})

test('failed attempts retry after 30s even when stationary and retain a prior valid route', async (context) => {
  const state = setup(context)
  state.calls[0].reject(new Error('OSRM unavailable'))
  await flush()
  assert.equal(state.routeErrors.value.get('a'), 'OSRM unavailable')
  assert.equal(state.isRouting.value, false)
  context.mock.timers.tick(29000)
  assert.equal(state.calls.length, 1)
  context.mock.timers.tick(1000)
  assert.equal(state.calls.length, 2)
  assert.equal(state.routeErrors.value.size, 0)
  await state.succeed(1)
  context.mock.timers.tick(15000)
  state.locations.value[0].longitude = 0.001
  state.calls[2].reject(new Error('Temporary failure'))
  await flush()
  assert.equal(state.routes.value.size, 1)
  context.mock.timers.tick(30000)
  assert.equal(state.calls.length, 4)
  await state.succeed(3)
  assert.equal(state.routeErrors.value.size, 0)
})

test('destination switch drops old routes and rejects late results and errors', async (context) => {
  const state = setup(context, { drivers: [driver('a'), driver('b')] })
  await state.succeed(0)
  await state.tick(1100)
  const oldSignal = state.calls[1].signal
  state.target.value = { latitude: 2, longitude: 2, label: 'New target' }
  assert.equal(oldSignal.aborted, true)
  assert.equal(state.routes.value.size, 0)
  assert.equal(state.calls.length, 2)
  await state.succeed(1)
  assert.equal(state.routes.value.size, 0)
  assert.equal(state.isRouting.value, true)
  await state.tick(1100)
  await state.succeed(2)
  assert.equal(state.routes.value.get('a').destination.latitude, 2)
  await state.tick(1100)
  state.target.value = null
  state.calls[3].reject(new Error('Late old error'))
  await flush()
  assert.equal(state.routes.value.size, 0)
  assert.equal(state.routeErrors.value.size, 0)
  assert.equal(state.isRouting.value, false)
  context.mock.timers.tick(120000)
  assert.equal(state.calls.length, 4)
})

test('GPS clearing aborts immediately, frees a slot and cannot resurrect a rejoined driver', async (context) => {
  const state = setup(context, { drivers: [driver('a'), driver('b'), driver('c')] })
  await state.tick(1100)
  state.locations.value = [driver('b'), driver('c')]
  assert.equal(state.calls[0].signal.aborted, true)
  assert.equal(state.calls.length, 2)
  state.locations.value.push(driver('a'))
  await state.succeed(0)
  assert.equal(state.routes.value.has('a'), false)
  await state.tick(1100)
  assert.equal(state.calls[2].userId, 'c')
  await state.succeed(1)
  await state.tick(1100)
  assert.equal(state.calls[3].userId, 'a')
  await state.succeed(3)
  state.locations.value = [driver('c')]
  assert.equal(state.routes.value.has('a'), false)
  assert.equal(state.routes.value.has('b'), false)
  state.locations.value = []
  assert.equal(state.calls[2].signal.aborted, true)
  await state.succeed(2)
  assert.equal(state.routes.value.size, 0)
  assert.equal(state.isRouting.value, false)
})

for (const change of ['disconnect', 'leave', 'channel', 'server', 'user']) {
  test(`${change} resets attempts, aborts requests and suppresses late replies`, async (context) => {
    const state = setup(context, { drivers: [driver('a'), driver('b')] })
    await state.succeed(0)
    await state.tick(1100)
    if (change === 'disconnect') state.transport.isConnected = false
    if (change === 'leave') state.admitted.value = false
    if (change === 'channel') state.channel.value = 'other-trip'
    if (change === 'server') state.transport.activeConnectionId = 'server-b'
    if (change === 'user') state.transport.currentUser = { id: 'new-user' }
    assert.equal(state.calls[1].signal.aborted, true)
    assert.equal(state.routes.value.size, 0)
    assert.equal(state.routeErrors.value.size, 0)
    await state.succeed(1)
    assert.equal(state.routes.value.size, 0)
    if (change === 'disconnect' || change === 'leave') {
      context.mock.timers.tick(120000)
      assert.equal(state.calls.length, 2)
      state.transport.isConnected = true
      state.admitted.value = true
    } else {
      await state.tick(1100)
    }
    assert.equal(state.calls.length, 3)
    await state.tick(1100)
    assert.equal(state.calls.length, 4)
    await state.succeed(2)
    assert.equal(state.routes.value.size, 1)
  })
}

test('waits for target and admission then cleans watchers, pacing wake, interval and requests on scope stop', async (context) => {
  const state = setup(context, { joined: false, destination: false, drivers: [driver('a'), driver('b')] })
  const intervals = context.mock.method(globalThis, 'setInterval')
  const cleared = context.mock.method(globalThis, 'clearInterval')
  const timeouts = context.mock.method(globalThis, 'setTimeout')
  const clearedTimeouts = context.mock.method(globalThis, 'clearTimeout')
  assert.equal(state.calls.length, 0)
  state.target.value = { latitude: 1, longitude: 1, label: 'Target' }
  assert.equal(state.calls.length, 0)
  state.admitted.value = true
  assert.equal(state.calls.length, 1)
  assert.equal(intervals.mock.callCount(), 1)
  assert.equal(timeouts.mock.callCount(), 1)
  state.scope.stop()
  assert.equal(cleared.mock.callCount(), 1)
  assert.equal(cleared.mock.calls[0].arguments[0], intervals.mock.calls[0].result)
  assert.ok(clearedTimeouts.mock.calls.some((call) => call.arguments[0] === timeouts.mock.calls[0].result))
  assert.equal(state.calls[0].signal.aborted, true)
  assert.equal(state.isRouting.value, false)
  await state.succeed(0)
  state.locations.value.push(driver('b'))
  state.target.value = { latitude: 2, longitude: 2, label: 'Other' }
  context.mock.timers.tick(120000)
  assert.equal(state.calls.length, 1)
  assert.equal(state.routes.value.size, 0)
})

test('fast cached replies dispatch at exact 1100ms spacing and queued work stays routing', async (context) => {
  const state = setup(context, { drivers: Array.from({ length: 8 }, (_, index) => driver(`${index}`)) })
  for (let index = 0; index < 8; index++) {
    assert.equal(state.calls.length, index + 1)
    assert.equal(state.calls[index].at, 100000 + index * 1100)
    await state.succeed(index, undefined, 1000)
    assert.equal(state.isRouting.value, index < 7)
    if (index < 7) {
      await state.tick(1099)
      assert.equal(state.calls.length, index + 1)
      await state.tick(1)
    }
  }
  assert.equal(state.routes.value.size, 8)
  assert.equal(state.calls.length, 8)
})

test('destination changes, reopening scopes and other instances cannot bypass transport pacing', async (context) => {
  const state = setup(context)
  await state.tick(200)
  state.target.value = { latitude: 2, longitude: 2, label: 'New target' }
  assert.equal(state.calls[0].signal.aborted, true)
  assert.equal(state.isRouting.value, true)
  await state.tick(200)
  state.scope.stop()
  const reopened = state.mount()
  assert.equal(reopened.isRouting.value, true)
  await state.tick(699)
  assert.equal(state.calls.length, 1)
  await state.tick(1)
  assert.equal(state.calls[1].at, 101100)
  assert.equal(state.calls[1].destination.latitude, 2)
  await state.succeed(0)
  assert.equal(reopened.routes.value.size, 0)
  await state.tick(100)
  const other = state.mount()
  await state.tick(999)
  assert.equal(state.calls.length, 2)
  await state.tick(1)
  assert.equal(state.calls[2].at, 102200)
  await state.succeed(1)
  await state.succeed(2)
  assert.equal(reopened.routes.value.size, 1)
  assert.equal(other.routes.value.size, 1)
})

test('pacing wake chooses the current oldest eligible driver instead of reserving one early', async (context) => {
  const state = setup(context, { drivers: [driver('a'), driver('b'), driver('c')] })
  await state.succeed(0)
  const route = state.routes.value.get('a')
  state.routes.value.set('b', { ...route, updated_at: 20 })
  state.routes.value.set('c', { ...route, updated_at: 30 })
  await state.tick(500)
  // Route metadata changes are not a GPS watch event; the wake must read priority afresh.
  state.routes.value.get('c').updated_at = 10
  await state.tick(600)
  assert.equal(state.calls[1].userId, 'c')
  await state.succeed(1)
  await state.tick(1100)
  assert.equal(state.calls[2].userId, 'b')
})

test('scheduler instances share the two-request cap and release slots when a scope closes', async (context) => {
  const state = setup(context)
  state.mount()
  const waiting = state.mount()
  await state.tick(1100)
  assert.equal(state.calls.length, 2)
  assert.equal(waiting.isRouting.value, true)
  await state.tick(5000)
  assert.equal(state.calls.length, 2)
  state.scope.stop()
  assert.equal(state.calls[0].signal.aborted, true)
  await state.tick(1000)
  assert.equal(state.calls.length, 3)
  await state.succeed(0)
  assert.equal(waiting.routes.value.size, 0)
  await state.succeed(2)
  assert.equal(waiting.routes.value.size, 1)
})

test('GPS clear and reset cancel paced work without ghost dispatches', async (context) => {
  const state = setup(context, { drivers: [driver('a'), driver('b')] })
  await state.succeed(0)
  await state.tick(500)
  state.locations.value = []
  assert.equal(state.isRouting.value, false)
  await state.tick(600)
  assert.equal(state.calls.length, 1)
  state.locations.value = [driver('b')]
  assert.equal(state.calls.length, 2)
  await state.succeed(1)
  state.locations.value.push(driver('c'))
  assert.equal(state.isRouting.value, true)
  state.target.value = null
  assert.equal(state.isRouting.value, false)
  await state.tick(120000)
  assert.equal(state.calls.length, 2)
})

test('server rate-limit rejection retries through pacing, not provider backoff, retaining valid geometry', async (context) => {
  const state = setup(context)
  await state.succeed(0)
  await state.tick(15000)
  state.locations.value[0].longitude = 0.001
  await state.tick(200)
  state.calls[1].reject(new Error('Drive request rate limit exceeded.'))
  await flush()
  assert.equal(state.routes.value.size, 1)
  assert.equal(state.isRouting.value, true)
  assert.equal(state.routeErrors.value.get('a'), 'Drive request rate limit exceeded.')
  await state.tick(1099)
  assert.equal(state.calls.length, 2)
  await state.tick(1)
  assert.equal(state.calls[2].at, 116300)
  assert.equal(state.routeErrors.value.size, 0)
  await state.succeed(2)
  assert.equal(state.isRouting.value, false)
  assert.equal(state.routes.value.get('a').origin.longitude, 0.001)
})

test('movement distance handles stationary points and date-line crossings', () => {
  assert.equal(driveMovementDistance(driver('a'), driver('b')), 0)
  assert.ok(Math.abs(driveMovementDistance(driver('a'), driver('b', 0.0003)) - 33.3585) < 0.01)
  assert.ok(Math.abs(driveMovementDistance(driver('a', 179.9999), driver('b', -179.9999)) - 22.239) < 0.01)
})
