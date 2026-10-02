import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { createPinia, defineStore, disposePinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'

let server
let useDriveStore
let getGpsSpeed
let getDriveMapCoordinates
let searchDriveDestinations
let usePhoneLayout
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
  ;({ useDriveStore, getGpsSpeed } = await server.ssrLoadModule('/src/stores/drive.ts'))
  ;({ getDriveMapCoordinates, searchDriveDestinations } = await server.ssrLoadModule('/src/utils/driveNavigation.ts'))
  ;({ usePhoneLayout } = await server.ssrLoadModule('/src/composables/usePhoneLayout.ts'))
})
after(async () => server?.close())

function setup(context, { secure = true } = {}) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const watches = []
  const cleared = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { geolocation: {
      watchPosition(success, error, options) {
        watches.push({ success, error, options })
        return watches.length
      },
      clearWatch(id) { cleared.push(id) }
    } }
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: secure } })
  const pinia = createPinia()
  setActivePinia(pinia)
  const sent = []
  const listeners = new Set()
  const chat = defineStore('chat', () => ({
    channels: ref([{ id: 'trip', type: 'drive' }, { id: 'voice', type: 'voice' }]),
    currentUser: ref({ id: 'me' }),
    isConnected: ref(true),
    activeMainPanel: ref({ type: 'voice', channelId: 'trip' }),
    send: (type, payload) => sent.push({ type, payload }),
    addMessageListener: (listener) => listeners.add(listener),
    removeMessageListener: (listener) => listeners.delete(listener)
  }))()
  const webrtc = defineStore('webrtc', () => ({ activeVoiceChannelId: ref('trip') }))()
  const drive = useDriveStore()
  const emit = (type, payload = {}) => {
    for (const listener of listeners) listener({ type, payload: { channel_id: 'trip', ...payload } })
  }
  context.after(() => {
    disposePinia(pinia)
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else delete globalThis.navigator
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })
  return { chat, webrtc, drive, emit, sent, watches, cleared }
}

test('GPS starts only after drive admission and keeps running when navigating away', (context) => {
  const { drive, emit, chat, watches } = setup(context)
  assert.equal(watches.length, 0)
  emit('voice_channel_joined')
  assert.equal(drive.isSharing, true)
  assert.equal(watches.length, 1)
  assert.equal(watches[0].options.enableHighAccuracy, true)
  chat.activeMainPanel = { type: 'text', channelId: 'chat' }
  assert.equal(drive.isSharing, true)
})

test('GPS sends latest coordinates with throttling and clears sharing on demand', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 })
  const { drive, emit, watches, sent, cleared } = setup(context)
  emit('voice_channel_joined')
  watches[0].success({ coords: { latitude: 10, longitude: 20, accuracy: 5 } })
  watches[0].success({ coords: { latitude: 11, longitude: 21, accuracy: 6 } })
  watches[0].success({ coords: { latitude: 12, longitude: 22, accuracy: 7 } })
  assert.equal(sent.length, 1)
  context.mock.timers.tick(1000)
  assert.deepEqual(sent[1].payload.location, { latitude: 12, longitude: 22, accuracy: 7, speed: null })
  emit('drive_location_updated', { user_id: 'me', location: { latitude: 12, longitude: 22, accuracy: 7, updated_at: 12000 } })
  drive.stopSharing()
  assert.equal(drive.isSharing, false)
  assert.equal(drive.locations.has('me'), false)
  assert.deepEqual(cleared, [1])
  assert.equal(sent.at(-1).payload.location, null)
  const count = sent.length
  watches[0].success({ coords: { latitude: 13, longitude: 23, accuracy: 7 } })
  context.mock.timers.tick(2000)
  assert.equal(sent.length, count)
})

test('snapshots, updates and departures only affect the active drive call', (context) => {
  const { drive, emit } = setup(context)
  emit('voice_channel_joined')
  emit('drive_locations', { locations: [{ user_id: 'other', latitude: 1, longitude: 2, accuracy: 3, updated_at: 4 }] })
  assert.equal(drive.locations.size, 1)
  emit('drive_location_updated', { channel_id: 'elsewhere', user_id: 'outsider', location: { latitude: 5, longitude: 6 } })
  assert.equal(drive.locations.size, 1)
  emit('user_left_voice', { user_id: 'other' })
  assert.equal(drive.locations.size, 0)
})

test('leaving or disconnecting clears the GPS watcher and retained locations', (context) => {
  const { drive, emit, webrtc, chat, watches, cleared } = setup(context)
  emit('voice_channel_joined')
  webrtc.activeVoiceChannelId = 'voice'
  assert.equal(drive.isSharing, false)
  assert.equal(drive.joinedChannelId, null)
  assert.deepEqual(cleared, [1])
  webrtc.activeVoiceChannelId = 'trip'
  emit('voice_channel_joined')
  assert.equal(watches.length, 2)
  chat.isConnected = false
  assert.equal(drive.locations.size, 0)
  assert.equal(drive.isSharing, false)
  assert.deepEqual(cleared, [1, 2])
})

test('permission denial clears sharing and allows a deliberate retry', (context) => {
  const { drive, emit, watches, sent } = setup(context)
  emit('voice_channel_joined')
  watches[0].error({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3 })
  assert.equal(drive.isSharing, false)
  assert.match(drive.locationError, /permission was denied/)
  drive.startSharing()
  assert.equal(watches.length, 2)
  assert.equal(drive.locationError, null)
  const count = sent.length
  watches[0].success({ coords: { latitude: 1, longitude: 2, accuracy: 3 } })
  assert.equal(sent.length, count)
})

test('ordinary voice calls never request GPS', (context) => {
  const { drive, emit, webrtc, watches } = setup(context)
  webrtc.activeVoiceChannelId = 'voice'
  emit('voice_channel_joined', { channel_id: 'voice' })
  drive.startSharing()
  assert.equal(watches.length, 0)
  assert.equal(drive.joinedChannelId, null)
})

test('reconnects and new calls preserve GPS opt-out until explicit restart', (context) => {
  const { drive, emit, webrtc, chat, watches } = setup(context)
  emit('voice_channel_joined')
  drive.stopSharing()
  chat.isConnected = false
  webrtc.activeVoiceChannelId = null
  chat.isConnected = true
  webrtc.activeVoiceChannelId = 'trip'
  emit('voice_channel_joined')
  assert.equal(drive.isSharing, false)
  assert.equal(watches.length, 1)
  webrtc.activeVoiceChannelId = null
  webrtc.activeVoiceChannelId = 'trip'
  emit('voice_channel_joined')
  assert.equal(drive.isSharing, false)
  drive.startSharing()
  assert.equal(drive.isSharing, true)
  assert.equal(watches.length, 2)
})

test('insecure clients can still join voice without requesting GPS', (context) => {
  const { drive, emit, watches } = setup(context, { secure: false })
  emit('voice_channel_joined')
  assert.equal(drive.joinedChannelId, 'trip')
  assert.equal(drive.isSharing, false)
  assert.equal(watches.length, 0)
  assert.match(drive.locationError, /HTTPS/)
})

const fix = (timestamp, latitude, longitude, speed = null, accuracy = 3) => ({
  timestamp, coords: { latitude, longitude, speed, accuracy }
})

test('speed uses native GPS values or accurate timed positions without stationary jitter', () => {
  assert.equal(getGpsSpeed(fix(1000, 0, 0, 12), null), 12)
  assert.equal(getGpsSpeed(fix(1000, 0, 0, 0), null), 0)
  assert.equal(getGpsSpeed(fix(1000, 0, 0, -1), null), null)
  assert.equal(getGpsSpeed(fix(1000, 0, 0, Infinity), null), null)
  const previous = fix(1000, 0, 0)
  assert.ok(Math.abs(getGpsSpeed(fix(3000, 0, 0.0002), previous) - 11.1195) < 0.01)
  assert.equal(getGpsSpeed(fix(3000, 0, 0.00001), previous), 0)
  assert.equal(getGpsSpeed(fix(2000, 0, 0.0002), previous), null)
  assert.equal(getGpsSpeed(fix(20000, 0, 0.0002), previous), null)
  assert.equal(getGpsSpeed(fix(3000, 0, 0.0002, null, 100), previous), null)
  assert.equal(getGpsSpeed(fix(3000, 0, 1), previous), null)
  assert.ok(Math.abs(getGpsSpeed(fix(3000, 0, -179.9999), fix(1000, 0, 179.9999)) - 11.1195) < 0.01)
})

test('GPS watches fresh fixes and publishes estimated speed when native speed is absent', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 })
  const { emit, watches, sent } = setup(context)
  emit('voice_channel_joined')
  assert.equal(watches[0].options.maximumAge, 0)
  watches[0].success(fix(10000, 0, 0))
  assert.equal(sent[0].payload.location.speed, null)
  context.mock.timers.tick(1000)
  watches[0].success(fix(11000, 0, 0.0001))
  context.mock.timers.tick(1000)
  watches[0].success(fix(12000, 0, 0.0002))
  assert.ok(Math.abs(sent.at(-1).payload.location.speed - 11.1195) < 0.01)
  context.mock.timers.tick(1000)
  watches[0].success(fix(13000, 0, 0.0003, 15))
  assert.equal(sent.at(-1).payload.location.speed, 15)
})

test('participant speed labels respect GPS sharing, channel boundaries and stale readings', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 })
  const { drive, emit } = setup(context)
  emit('voice_channel_joined')
  assert.equal(drive.getSpeedLabel('me', 'trip'), '-- km/h')
  assert.equal(drive.getSpeedLabel('other', 'trip'), null)
  emit('drive_location_updated', { user_id: 'other', location: { latitude: 0, longitude: 0, accuracy: 3, speed: 10, updated_at: 500000 } })
  assert.equal(drive.getSpeedLabel('other', 'trip'), '36 km/h')
  assert.equal(drive.getSpeedLabel('other', 'elsewhere'), null)
  context.mock.timers.tick(15000)
  assert.equal(drive.getSpeedLabel('other', 'trip'), '-- km/h')
  emit('drive_locations', { generated_at: 500000, locations: [{ user_id: 'other', latitude: 0, longitude: 0, accuracy: 3, speed: 10, updated_at: 480000 }] })
  assert.equal(drive.getSpeedLabel('other', 'trip'), '-- km/h')
  emit('drive_location_updated', { user_id: 'other', location: null })
  assert.equal(drive.getSpeedLabel('other', 'trip'), null)
  drive.stopSharing()
  assert.equal(drive.getSpeedLabel('me', 'trip'), null)
})

test('map bounds always include the destination, even without drivers or after GPS updates', () => {
  const destination = { latitude: 52.51627, longitude: 13.3777 }
  const targetOnly = getDriveMapCoordinates([], destination)
  assert.equal(targetOnly.length, 1)
  assert.equal(targetOnly[0][0], destination.latitude)
  assert.ok(Math.abs(targetOnly[0][1] - destination.longitude) < 0.00001)
  const drivers = [{ latitude: 50, longitude: 5 }, { latitude: 51, longitude: 9 }]
  const coordinates = getDriveMapCoordinates(drivers, destination)
  assert.equal(coordinates.length, 3)
  assert.equal(coordinates.at(-1)[0], destination.latitude)
  assert.ok(Math.abs((coordinates.at(-1)[1] % 360) - destination.longitude) < 0.00001)
  const moved = getDriveMapCoordinates([{ latitude: 49, longitude: 4 }], destination)
  assert.equal(moved.length, 2)
  assert.equal(moved.at(-1)[0], destination.latitude)
  assert.equal(getDriveMapCoordinates(drivers, null).length, 2)
  assert.deepEqual(getDriveMapCoordinates([], null), [])
})

test('driver lines and destination bounds use the same short date-line crossing', () => {
  const coordinates = getDriveMapCoordinates([{ latitude: 10, longitude: -179.8 }, { latitude: 11, longitude: 179.8 }], { latitude: 12, longitude: 179.9 })
  const longitudes = coordinates.map((point) => point[1])
  assert.ok(Math.max(...longitudes) - Math.min(...longitudes) < 0.5)
  assert.equal(coordinates.at(-1)[0], 12)
})

test('address search validates results, caches explicit queries and does not send driver coordinates', async (context) => {
  const feature = { geometry: { type: 'Point', coordinates: [13.3777, 52.51627] }, properties: {
    name: 'Brandenburg Gate', street: 'Pariser Platz', housenumber: '1', postcode: '10117', city: 'Berlin', country: 'Germany'
  } }
  let requests = 0
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++
    assert.equal(url.searchParams.get('q'), 'Test Landmark Search')
    assert.equal(url.searchParams.get('limit'), '5')
    assert.deepEqual([...url.searchParams.keys()].sort(), ['limit', 'q'])
    assert.equal(options.credentials, 'omit')
    assert.equal(options.referrerPolicy, 'no-referrer')
    return { ok: true, json: async () => ({ features: [null, feature, feature,
      { geometry: { type: 'Point', coordinates: [200, 52] } },
      { geometry: { type: 'Point', coordinates: [13, '52'] } }] }) }
  })
  const result = await searchDriveDestinations('  Test Landmark Search  ', new AbortController().signal)
  assert.deepEqual(result, [{ latitude: 52.51627, longitude: 13.3777, label: 'Brandenburg Gate, Pariser Platz 1, 10117 Berlin, Germany' }])
  assert.deepEqual(await searchDriveDestinations('test landmark search', new AbortController().signal), result)
  assert.equal(requests, 1)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(searchDriveDestinations('Test Landmark Search', aborted.signal), { name: 'AbortError' })
  assert.equal(requests, 1)
})

test('address lookup handles empty, malformed and failed responses and limits results', async (context) => {
  let response = { ok: false }
  context.mock.method(globalThis, 'fetch', async () => response)
  const search = (query) => searchDriveDestinations(query, new AbortController().signal)
  await assert.rejects(search('a'), /Enter an address/)
  await assert.rejects(search('x'.repeat(251)), /Enter an address/)
  await assert.rejects(search('Unavailable test address'), /unavailable/)
  response = { ok: true, json: async () => ({ unexpected: true }) }
  await assert.rejects(search('Malformed test address'), /invalid response/)
  response = { ok: true, json: async () => ({ features: [] }) }
  assert.deepEqual(await search('Empty test address'), [])
  response = { ok: true, json: async () => ({ features: Array.from({ length: 8 }, (_, index) => ({
    geometry: { type: 'Point', coordinates: [index, 50] }, properties: { name: `Address ${index}` }
  })) }) }
  assert.equal((await search('Multiple test addresses')).length, 5)
})

test('cancelled address lookup cannot return a destination after its request completes', async (context) => {
  const controller = new AbortController()
  context.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => {
    controller.abort()
    return { features: [{ geometry: { type: 'Point', coordinates: [13, 52] }, properties: { name: 'Cancelled target' } }] }
  } }))
  await assert.rejects(searchDriveDestinations('Cancelled test address', controller.signal), { name: 'AbortError' })
})

test('selected targets survive navigation and GPS disconnects without being persisted to storage', (context) => {
  const { drive, chat } = setup(context)
  const destination = { latitude: 52, longitude: 13, label: 'Target' }
  drive.destinations.set('server:trip', destination)
  chat.activeMainPanel = { type: 'text', channelId: 'chat' }
  chat.isConnected = false
  assert.deepEqual(drive.destinations.get('server:trip'), destination)
  assert.equal(drive.destinations.has('other-server:trip'), false)
})

test('phone layout follows modern and legacy media changes and cleans up on unmount', (context) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let listener
  let removed = false
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: (query) => {
    assert.match(query, /pointer: coarse/)
    return { matches: true,
      addEventListener: (event, handler) => { assert.equal(event, 'change'); listener = handler },
      removeEventListener: (event, handler) => { assert.equal(event, 'change'); assert.equal(handler, listener); removed = true }
    }
  } } })
  const scope = effectScope()
  context.after(() => {
    scope.stop()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })
  const isPhone = scope.run(usePhoneLayout)
  assert.equal(isPhone.value, true)
  listener({ matches: false })
  assert.equal(isPhone.value, false)
  listener({ matches: true })
  assert.equal(isPhone.value, true)
  scope.stop()
  assert.equal(removed, true)
  removed = false
  window.matchMedia = () => ({ matches: false,
    addListener: (handler) => { listener = handler },
    removeListener: (handler) => { assert.equal(handler, listener); removed = true }
  })
  const legacyScope = effectScope()
  context.after(() => legacyScope.stop())
  const legacyPhone = legacyScope.run(usePhoneLayout)
  assert.equal(legacyPhone.value, false)
  listener({ matches: true })
  assert.equal(legacyPhone.value, true)
  legacyScope.stop()
  assert.equal(removed, true)
})
