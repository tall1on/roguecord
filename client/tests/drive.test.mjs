import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { createPinia, defineStore, disposePinia, setActivePinia } from 'pinia'
import { effectScope, reactive, ref } from 'vue'

let server
let useDriveStore
let getGpsSpeed
let getDriveMapCoordinates
let searchDriveDestinations
let getDriveRoute
let setDriveDestination
let rankDriveParticipants
let usePhoneLayout
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
  ;({ useDriveStore, getGpsSpeed } = await server.ssrLoadModule('/src/stores/drive.ts'))
  ;({ getDriveMapCoordinates, searchDriveDestinations, getDriveRoute, setDriveDestination, rankDriveParticipants } = await server.ssrLoadModule('/src/utils/driveNavigation.ts'))
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
    activeConnectionId: ref('guild'),
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

function navigationTransport() {
  const listeners = new Set()
  const sent = []
  const transport = reactive({
    isConnected: true, activeConnectionId: 'guild', currentUser: { id: 'me' },
    addMessageListener: (listener) => listeners.add(listener),
    removeMessageListener: (listener) => listeners.delete(listener),
    send: (type, payload) => sent.push({ type, payload })
  })
  const reply = (type, payload) => { for (const listener of [...listeners]) listener({ type, payload }) }
  return { transport, listeners, sent, reply }
}

test('address search uses the guild socket, matches concurrent replies, and never contacts Photon from the client', async (context) => {
  const directFetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected direct upstream request') })
  const { transport, listeners, sent, reply } = navigationTransport()
  const first = searchDriveDestinations(transport, 'trip', '  Berlin Gate  ', new AbortController().signal)
  const second = searchDriveDestinations(transport, 'trip', 'Munich', new AbortController().signal)
  assert.equal(listeners.size, 2)
  assert.deepEqual(Object.keys(sent[0].payload).sort(), ['channel_id', 'query', 'request_id'])
  assert.equal(sent[0].type, 'drive_search_destinations')
  assert.equal(sent[0].payload.query, 'Berlin Gate')
  assert.notEqual(sent[0].payload.request_id, sent[1].payload.request_id)
  reply('drive_destinations', { ...sent[0].payload, channel_id: 'elsewhere', destinations: [] })
  assert.equal(listeners.size, 2)
  reply('drive_destinations', { ...sent[1].payload, destinations: [] })
  assert.deepEqual(await second, [])
  const destination = { latitude: 52.51627, longitude: 13.3777, label: 'Brandenburg Gate, Berlin' }
  reply('drive_destinations', { ...sent[0].payload, destinations: [destination] })
  assert.deepEqual(await first, [destination])
  assert.equal(listeners.size, 0)
  assert.equal(directFetch.mock.callCount(), 0)
})

test('address proxy handles invalid queries, malformed results and correlated upstream errors', async () => {
  const { transport, listeners, sent, reply } = navigationTransport()
  const search = (query) => searchDriveDestinations(transport, 'trip', query, new AbortController().signal)
  await assert.rejects(search('a'), /Enter an address/)
  await assert.rejects(search('x'.repeat(251)), /Enter an address/)
  assert.equal(sent.length, 0)
  const failed = search('Unavailable address')
  reply('drive_destinations', { ...sent.at(-1).payload, error: 'Address search unavailable.' })
  await assert.rejects(failed, /unavailable/)
  const malformed = search('Malformed address')
  reply('drive_destinations', { ...sent.at(-1).payload, destinations: [{ latitude: 200, longitude: 13, label: 'Invalid' }] })
  await assert.rejects(malformed, /invalid response/)
  const generic = search('Generic server error')
  reply('error', { request_id: sent.at(-1).payload.request_id, message: 'Permission denied' })
  await assert.rejects(generic, /Permission denied/)
  assert.equal(listeners.size, 0)
})

test('navigation cancels on abort, server switch, reauthentication, disconnect and timeout without accepting late replies', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { transport, listeners, sent, reply } = navigationTransport()
  const controller = new AbortController()
  const aborted = searchDriveDestinations(transport, 'trip', 'Cancelled address', controller.signal)
  const late = sent.at(-1).payload
  controller.abort()
  await assert.rejects(aborted, { name: 'AbortError' })
  reply('drive_destinations', { ...late, destinations: [] })
  assert.equal(listeners.size, 0)
  const switched = searchDriveDestinations(transport, 'trip', 'Other address', new AbortController().signal)
  transport.activeConnectionId = 'other-guild'
  await assert.rejects(switched, /connection changed/)
  const reauthenticated = searchDriveDestinations(transport, 'trip', 'Reauthenticated address', new AbortController().signal)
  reply('authenticated', { user: { id: 'me' } })
  await assert.rejects(reauthenticated, /authentication changed/)
  const disconnected = searchDriveDestinations(transport, 'trip', 'Third address', new AbortController().signal)
  transport.isConnected = false
  await assert.rejects(disconnected, /connection changed/)
  await assert.rejects(searchDriveDestinations(transport, 'trip', 'Offline address', new AbortController().signal), /Connect to the guild/)
  transport.isConnected = true
  const timeout = searchDriveDestinations(transport, 'trip', 'Timeout address', new AbortController().signal)
  context.mock.timers.tick(20000)
  await assert.rejects(timeout, /timed out/)
  assert.equal(listeners.size, 0)
})

test('street routing submits only driver identity and target and validates road geometry', async () => {
  const { transport, listeners, sent, reply } = navigationTransport()
  const destination = { latitude: 52.52, longitude: 13.4 }
  const route = {
    coordinates: [[13.39, 52.51], [13.395, 52.515], [13.4, 52.52]], distance_m: 1500, duration_s: 120,
    origin: { latitude: 52.51, longitude: 13.39 }, destination, provider: 'osrm', updated_at: 100000
  }
  const request = getDriveRoute(transport, 'trip', 'driver', destination, new AbortController().signal)
  assert.equal(sent.at(-1).type, 'drive_get_route')
  assert.deepEqual(Object.keys(sent.at(-1).payload).sort(), ['channel_id', 'destination', 'request_id', 'user_id'])
  reply('drive_route', { ...sent.at(-1).payload, route })
  assert.deepEqual(await request, route)
  for (const invalid of [{ ...route, coordinates: [[13, 52], [200, 52]] }, { ...route, duration_s: Infinity }, { ...route, updated_at: undefined }, { ...route, destination: { latitude: 0, longitude: 0 } }]) {
    const bad = getDriveRoute(transport, 'trip', 'driver', destination, new AbortController().signal)
    reply('drive_route', { ...sent.at(-1).payload, route: invalid })
    await assert.rejects(bad, /invalid street route/)
  }
  assert.equal(listeners.size, 0)
})

test('automatic bounds include road detours as well as drivers and the destination', () => {
  const drivers = [{ latitude: 50, longitude: 8 }]
  const destination = { latitude: 51, longitude: 9 }
  const street = [{ latitude: 50, longitude: 8 }, { latitude: 54, longitude: 12 }, { latitude: 51, longitude: 9 }]
  const coordinates = getDriveMapCoordinates(drivers, destination, street)
  assert.equal(coordinates.length, 5)
  assert.equal(coordinates[1][0], destination.latitude)
  assert.equal(Math.max(...coordinates.map((point) => point[0])), 54)
})

test('shared targets survive panel navigation but reset on disconnect until a fresh room snapshot', (context) => {
  const { drive, chat, emit } = setup(context)
  const destination = { latitude: 52, longitude: 13, label: 'Target' }
  emit('voice_channel_joined')
  emit('drive_locations', { locations: [], destination })
  chat.activeMainPanel = { type: 'text', channelId: 'chat' }
  assert.deepEqual(drive.destinations.get('guild:trip'), destination)
  chat.isConnected = false
  assert.equal(drive.destinations.size, 0)
  chat.isConnected = true
  emit('voice_channel_joined')
  emit('drive_locations', { locations: [], destination: null })
  assert.equal(drive.destinations.size, 0)
})

test('room destination updates are authoritative, room-scoped and cleared on leaving', (context) => {
  const { drive, emit, webrtc } = setup(context)
  emit('voice_channel_joined')
  const first = { latitude: 52, longitude: 13, label: 'Shared target' }
  emit('drive_destination_set', { destination: first })
  assert.equal(drive.destinations.size, 0)
  emit('drive_destination_updated', { destination: first })
  assert.deepEqual(drive.destinations.get('guild:trip'), first)
  emit('drive_destination_updated', { channel_id: 'other-room', destination: null })
  assert.deepEqual(drive.destinations.get('guild:trip'), first)
  emit('drive_destination_updated', { destination: { ...first, longitude: 200 } })
  assert.deepEqual(drive.destinations.get('guild:trip'), first)
  emit('drive_destination_updated', { destination: null })
  assert.equal(drive.destinations.size, 0)
  emit('drive_destination_updated', { destination: first })
  webrtc.activeVoiceChannelId = null
  assert.equal(drive.destinations.size, 0)
})

test('setting and clearing a shared destination require private correlated acknowledgements', async () => {
  const { transport, listeners, sent, reply } = navigationTransport()
  const destination = { latitude: 52, longitude: 13, label: 'Shared target' }
  const set = setDriveDestination(transport, 'trip', destination, new AbortController().signal)
  assert.equal(sent.at(-1).type, 'drive_set_destination')
  reply('drive_destination_updated', { channel_id: 'trip', destination })
  assert.equal(listeners.size, 1)
  reply('drive_destination_set', { ...sent.at(-1).payload, destination })
  assert.deepEqual(await set, destination)
  const clear = setDriveDestination(transport, 'trip', null, new AbortController().signal)
  assert.equal(sent.at(-1).payload.destination, null)
  reply('drive_destination_set', { ...sent.at(-1).payload, destination: null })
  assert.equal(await clear, null)
  const denied = setDriveDestination(transport, 'trip', destination, new AbortController().signal)
  reply('drive_destination_set', { ...sent.at(-1).payload, error: 'Join the drive room first.' })
  await assert.rejects(denied, /Join the drive room/)
  await assert.rejects(setDriveDestination(transport, 'trip', { ...destination, latitude: 100 }, new AbortController().signal), /valid room destination/)
  assert.equal(listeners.size, 0)
})

test('driver chips rank and sort closest first, leaving unknown GPS unranked at the end', () => {
  const participants = ['far', 'unknown', 'near', 'middle'].map((id) => ({ id, username: id }))
  const locations = new Map([['far', { latitude: 0, longitude: 0.3 }], ['near', { latitude: 0, longitude: 0.1 }], ['middle', { latitude: 0, longitude: 0.2 }]])
  const entries = rankDriveParticipants(participants, locations, { latitude: 0, longitude: 0 })
  assert.deepEqual(entries.map((entry) => [entry.participant.id, entry.rank]), [['near', 1], ['middle', 2], ['far', 3], ['unknown', null]])
  assert.ok(entries[0].distance_m < entries[1].distance_m)
  assert.deepEqual(participants.map((participant) => participant.id), ['far', 'unknown', 'near', 'middle'])
  locations.set('far', { latitude: 0, longitude: 0.01 })
  assert.equal(rankDriveParticipants(participants, locations, { latitude: 0, longitude: 0 })[0].participant.id, 'far')
  assert.equal(rankDriveParticipants(participants, locations, { latitude: 0, longitude: 0.2 })[0].participant.id, 'middle')
})

test('disabled destinations restore original chip order; equal GPS positions break ties deterministically', () => {
  const participants = ['b', 'a', 'invalid'].map((id) => ({ id }))
  const locations = new Map([['a', { latitude: 0, longitude: -179.9 }], ['b', { latitude: 0, longitude: -179.9 }], ['invalid', { latitude: NaN, longitude: 0 }]])
  const entries = rankDriveParticipants(participants, locations, { latitude: 0, longitude: 179.9 })
  assert.deepEqual(entries.map((entry) => [entry.participant.id, entry.rank]), [['a', 1], ['b', 2], ['invalid', null]])
  assert.ok(entries[0].distance_m < 25000)
  assert.deepEqual(rankDriveParticipants(participants, locations, null).map((entry) => [entry.participant.id, entry.rank]), [['b', null], ['a', null], ['invalid', null]])
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
