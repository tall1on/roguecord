import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { reactive } from 'vue'

let driveTracks
let driveNavigation
before(async () => {
  const server = await createServer({
    configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom',
  })
  after(() => server?.close())
  driveTracks = await server.ssrLoadModule('/src/utils/driveTracks.ts')
  driveNavigation = await server.ssrLoadModule('/src/utils/driveNavigation.ts')
})

const track = (overrides = {}) => ({
  id: 't1', family_id: 't1', name: 'Loop', version: 1, owner_id: 'u1',
  payload: { start: { latitude: 0, longitude: 0 }, checkpoints: [{ latitude: 0, longitude: 0.001, name: 'A' }], end: { latitude: 0, longitude: 0.002 } },
  distance_m: 222, up: 0, down: 0, mine: 0, created_at: 1, updated_at: 1,
  ...overrides,
})
const run = (overrides = {}) => ({
  id: 'r1', track_id: 't1', user_id: 'me', channel_id: 'ch1', started_at: 1000, finished_at: null,
  next_gate: 0, gates_total: 3, gate_times: [], distance_m: 222, duration_ms: null, avg_speed_mps: null,
  status: 'active', updated_at: 1000,
  ...overrides,
})

const makeTransport = () => {
  const listeners = new Set()
  const sent = []
  const transport = reactive({
    isConnected: true, activeConnectionId: 'server-a', currentUser: { id: 'me' },
    addMessageListener: (listener) => listeners.add(listener),
    removeMessageListener: (listener) => listeners.delete(listener),
    send: (type, payload) => { sent.push({ type, payload }) },
  })
  const reply = (type, payload) => { for (const listener of [...listeners]) listener({ type, payload }) }
  return { transport, sent, reply }
}
const signal = () => new AbortController().signal
const flush = async () => { for (let index = 0; index < 4; index++) await Promise.resolve() }

const answer = async (state, type, build = () => ({})) => {
  await flush()
  const request = state.sent.at(-1)
  assert.ok(request, `expected a ${type} message to be sent`)
  state.reply(type, { request_id: request.payload.request_id, ...build(request.payload) })
  return request
}

test('track validation accepts server tracks and rejects malformed payloads', () => {
  assert.equal(driveTracks.isDriveTrack(track()), true)
  assert.equal(driveTracks.isDriveTrack(track({ payload: { start: { latitude: 0, longitude: 0 } } })), false)
  assert.equal(driveTracks.isDriveTrack(track({ mine: 2 })), false)
  assert.equal(driveTracks.isDriveTrack(track({ payload: { ...track().payload, checkpoints: 'nope' } })), false)
  assert.equal(driveTracks.isDriveTrackRun(run()), true)
  assert.equal(driveTracks.isDriveTrackRun(run({ gates_total: 1 })), false)
  assert.equal(driveTracks.isDriveTrackRun(run({ status: 'paused' })), false)
})

test('gates preserve start, checkpoint and finish order with defaults', () => {
  const gates = driveTracks.trackGates(track().payload)
  assert.deepEqual(gates.map((gate) => gate.kind), ['start', 'checkpoint', 'end'])
  assert.deepEqual(gates.map((gate) => gate.name), ['Start', 'A', 'Finish'])
  assert.equal(driveTracks.displayTrackBaseName('Loop V4'), 'Loop')
  assert.equal(driveTracks.displayTrackBaseName('Loop'), 'Loop')
})

test('track heading follows the planned line and drops out far away from it', () => {
  const gates = driveTracks.trackGates(track().payload)
  const heading = driveTracks.getTrackHeading({ latitude: 0, longitude: 0.0002 }, gates)
  assert.ok(heading !== null && heading > 80 && heading < 100)
  const far = driveTracks.getTrackHeading({ latitude: 4, longitude: 4 }, gates)
  assert.equal(far, null)
  assert.ok(Math.abs(driveTracks.distanceToGate({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.001 }) - 111) < 2)
})

test('listing tracks validates the response shape', async () => {
  const state = makeTransport()
  const pending = driveTracks.listDriveTracks(state.transport, signal())
  const request = await answer(state, 'drive_tracks', () => ({ tracks: [track()] }))
  assert.equal(request.type, 'drive_tracks_list')
  assert.equal(request.payload.channel_id, undefined)
  assert.deepEqual((await pending).map((entry) => entry.id), ['t1'])

  const bad = makeTransport()
  const rejected = driveTracks.listDriveTracks(bad.transport, signal())
  await answer(bad, 'drive_tracks', () => ({ tracks: [{ id: 'x' }] }))
  await assert.rejects(rejected, /invalid track list/)
})

test('creating a track sends no channel and cloning sends the source id', async () => {
  const createState = makeTransport()
  const creating = driveTracks.saveDriveTrack(createState.transport, {
    name: '  Mountain   Loop  ', start: { latitude: 1, longitude: 2 }, checkpoints: [], end: { latitude: 3, longitude: 4 },
  }, null, signal())
  const createRequest = await answer(createState, 'drive_track_saved', () => ({ track: track({ id: 'new', name: 'Mountain Loop' }) }))
  assert.equal(createRequest.type, 'drive_track_create')
  assert.equal(createRequest.payload.name, 'Mountain Loop')
  assert.equal(createRequest.payload.channel_id, undefined)
  assert.equal((await creating).id, 'new')

  const cloneState = makeTransport()
  const cloning = driveTracks.saveDriveTrack(cloneState.transport, {
    name: 'Mountain Loop', start: { latitude: 1, longitude: 2 }, checkpoints: [], end: { latitude: 3, longitude: 4 },
  }, 't1', signal())
  const cloneRequest = await answer(cloneState, 'drive_track_saved', () => ({ track: track({ id: 't2', name: 'Mountain Loop V2', version: 2 }) }))
  assert.equal(cloneRequest.type, 'drive_track_update')
  assert.equal(cloneRequest.payload.track_id, 't1')
  assert.equal((await cloning).version, 2)
})

test('saving rejects incomplete geometry before contacting the server', async () => {
  const state = makeTransport()
  await assert.rejects(driveTracks.saveDriveTrack(state.transport, {
    name: '', start: { latitude: 1, longitude: 2 }, checkpoints: [], end: { latitude: 3, longitude: 4 },
  }, null, signal()), /name/)
  await assert.rejects(driveTracks.saveDriveTrack(state.transport, {
    name: 'x', start: null, checkpoints: [], end: { latitude: 3, longitude: 4 },
  }, null, signal()), /start/)
  await assert.rejects(driveTracks.saveDriveTrack(state.transport, {
    name: 'x', start: { latitude: 1, longitude: 2 }, checkpoints: [], end: null,
  }, null, signal()), /end/)
  assert.equal(state.sent.length, 0)
})

test('voting, deleting and activation round-trip through the protocol', async () => {
  const voteState = makeTransport()
  const voting = driveTracks.voteDriveTrack(voteState.transport, 't1', 1, signal())
  const voteRequest = await answer(voteState, 'drive_track_vote', () => ({ up: 1, down: 0, mine: 1 }))
  assert.equal(voteRequest.payload.value, 1)
  assert.deepEqual(await voting, { up: 1, down: 0, mine: 1 })

  const deleteState = makeTransport()
  const deleting = driveTracks.deleteDriveTrack(deleteState.transport, 't1', signal())
  const deleteRequest = await answer(deleteState, 'drive_track_deleted', () => ({ track_id: 't1', deleted: true }))
  assert.equal(deleteRequest.payload.track_id, 't1')
  await deleting

  const activateState = makeTransport()
  const activating = driveTracks.activateDriveTrack(activateState.transport, 'ch1', 't1', signal())
  const activateRequest = await answer(activateState, 'drive_track_run', () => ({ channel_id: 'ch1', run: run() }))
  assert.equal(activateRequest.type, 'drive_track_activate')
  assert.equal(activateRequest.payload.channel_id, 'ch1')
  assert.equal((await activating).channel_id, 'ch1')

  const deactivateState = makeTransport()
  const deactivating = driveTracks.deactivateDriveTrack(deactivateState.transport, 'ch1', signal())
  const deactivateRequest = await answer(deactivateState, 'drive_track_run', () => ({ channel_id: 'ch1', run: null }))
  assert.equal(deactivateRequest.type, 'drive_track_deactivate')
  await deactivating
})

test('the generic navigation request helper still gates responses by channel', async () => {
  const state = makeTransport()
  const pending = driveNavigation.requestDriveMessage(state.transport, 'drive_get_route', 'drive_route', 'ch1', {}, signal(), 5000)
  await flush()
  const request = state.sent.at(-1)
  // A reply for a different channel must be ignored.
  state.reply('drive_route', { request_id: request.payload.request_id, channel_id: 'other', coordinates: [] })
  await flush()
  state.reply('drive_route', { request_id: request.payload.request_id, channel_id: 'ch1', coordinates: [[0, 0], [1, 1]] })
  assert.equal((await pending).channel_id, 'ch1')
})

test('leaderboard pages validate, paginate and allow unbounded all-times', async () => {
  const entry = (index) => ({
    user_id: 'u1', run_id: `r${index}`, duration_ms: 4000 + index, avg_speed_mps: 12.5, distance_m: 222, finished_at: 1000 + index,
  })

  const state = makeTransport()
  const pending = driveTracks.getDriveTrackLeaderboard(state.transport, 't1', signal())
  const request = await answer(state, 'drive_track_leaderboard', () => ({
    track_id: 't1', offset: 0, total: 3, has_more: true, entries: [entry(0)],
  }))
  assert.equal(request.type, 'drive_track_leaderboard')
  assert.equal(request.payload.track_id, 't1')
  assert.equal(request.payload.all_times, false)
  assert.equal(request.payload.offset, 0)
  assert.equal(request.payload.channel_id, undefined)
  const page = await pending
  assert.equal(page.entries[0].duration_ms, 4000)
  assert.equal(page.total, 3)
  assert.equal(page.hasMore, true)

  const bad = makeTransport()
  const rejected = driveTracks.getDriveTrackLeaderboard(bad.transport, 't1', signal())
  await answer(bad, 'drive_track_leaderboard', () => ({ total: 1, has_more: false, entries: [{ user_id: 'u1' }] }))
  await assert.rejects(rejected, /invalid leaderboard/)

  // A page cannot exceed the protocol page size, and pagination metadata is required.
  const oversized = makeTransport()
  const tooMany = driveTracks.getDriveTrackLeaderboard(oversized.transport, 't1', signal())
  await answer(oversized, 'drive_track_leaderboard', () => ({
    total: 51, has_more: true, entries: Array.from({ length: driveTracks.DRIVE_TRACK_LEADERBOARD_PAGE_SIZE + 1 }, (_, index) => entry(index)),
  }))
  await assert.rejects(tooMany, /invalid leaderboard/)

  const missingMeta = makeTransport()
  const noMeta = driveTracks.getDriveTrackLeaderboard(missingMeta.transport, 't1', signal())
  await answer(missingMeta, 'drive_track_leaderboard', () => ({ entries: [entry(0)] }))
  await assert.rejects(noMeta, /invalid leaderboard/)

  const allState = makeTransport()
  const allTimes = driveTracks.getDriveTrackLeaderboard(allState.transport, 't1', signal(), { allTimes: true, offset: 50 })
  const allRequest = await answer(allState, 'drive_track_leaderboard', () => ({
    total: 51, has_more: false, entries: [entry(50)],
  }))
  assert.equal(allRequest.payload.all_times, true)
  assert.equal(allRequest.payload.offset, 50)
  const lastPage = await allTimes
  assert.equal(lastPage.entries.length, 1)
  assert.equal(lastPage.hasMore, false)
})

test('personal route requests carry the personal flag while shared routes do not', async () => {
  const target = { latitude: 1, longitude: 2 }
  const personalState = makeTransport()
  const personal = driveNavigation.getDriveRoute(personalState.transport, 'ch1', 'me', target, signal(), true)
  await flush()
  const personalRequest = personalState.sent.at(-1)
  assert.equal(personalRequest.type, 'drive_get_route')
  assert.equal(personalRequest.payload.personal, true)
  assert.deepEqual(personalRequest.payload.destination, target)
  personalState.reply('drive_route', {
    request_id: personalRequest.payload.request_id, channel_id: 'ch1', user_id: 'me',
    route: { coordinates: [[2, 1], [3, 1]], distance_m: 10, duration_s: 5, origin: target, destination: target, provider: 'osrm', updated_at: 1 },
  })
  assert.equal((await personal).distance_m, 10)

  const sharedState = makeTransport()
  const shared = driveNavigation.getDriveRoute(sharedState.transport, 'ch1', 'me', target, signal())
  await flush()
  const sharedRequest = sharedState.sent.at(-1)
  assert.equal(sharedRequest.payload.personal, undefined)
  sharedState.reply('drive_route', { request_id: sharedRequest.payload.request_id, channel_id: 'ch1', error: 'nope' })
  await assert.rejects(shared, /nope/)
})
