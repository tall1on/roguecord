import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { createPinia, defineStore, disposePinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

let server
let useDriveStore
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
  ;({ useDriveStore } = await server.ssrLoadModule('/src/stores/drive.ts'))
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
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 })
  const { drive, emit, watches, sent, cleared } = setup(context)
  emit('voice_channel_joined')
  watches[0].success({ coords: { latitude: 10, longitude: 20, accuracy: 5 } })
  watches[0].success({ coords: { latitude: 11, longitude: 21, accuracy: 6 } })
  watches[0].success({ coords: { latitude: 12, longitude: 22, accuracy: 7 } })
  assert.equal(sent.length, 1)
  context.mock.timers.tick(2000)
  assert.deepEqual(sent[1].payload.location, { latitude: 12, longitude: 22, accuracy: 7 })
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
