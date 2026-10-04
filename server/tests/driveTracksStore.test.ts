import assert from 'node:assert/strict';
import test from 'node:test';
import sqlite3 from 'sqlite3';
import { migrateDriveTracks } from '../src/driveTracksMigration';
import { DriveTracksStore } from '../src/ws/driveTracksStore';

const openDb = () => new Promise<sqlite3.Database>((resolve, reject) => {
  const db = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(db)));
});
const run = (db: sqlite3.Database, sql: string) => new Promise<void>((resolve, reject) => {
  db.run(sql, (error) => (error ? reject(error) : resolve()));
});

const setup = async () => {
  const db = await openDb();
  await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
  await run(db, 'CREATE TABLE channels (id TEXT PRIMARY KEY)');
  await migrateDriveTracks(db);
  let clock = 1000;
  const store = new DriveTracksStore(db, () => clock);
  return { db, store, setClock: (value: number) => { clock = value; } };
};

const input = (name = 'Mountain Loop') => ({
  name,
  start: { latitude: 0, longitude: 0 },
  checkpoints: [{ latitude: 0, longitude: 0.001, name: 'A' }],
  end: { latitude: 0, longitude: 0.002 }
});

test('creating and editing a track appends same-name versions in one family', async (t) => {
  const { db, store } = await setup();
  t.after(() => db.close());
  const first = await store.createTrack('owner', input());
  assert.equal(first.name, 'Mountain Loop');
  assert.equal(first.version, 1);
  assert.equal(first.family_id, first.id);
  assert.equal(first.owner_id, 'owner');
  assert.ok(first.distance_m > 200 && first.distance_m < 240);
  assert.deepEqual(first.payload.checkpoints[0], { latitude: 0, longitude: 0.001, name: 'A' });

  const second = await store.cloneTrack(first.id, 'editor', input('Renamed'));
  assert.equal(second.name, 'Mountain Loop V2');
  assert.equal(second.version, 2);
  assert.equal(second.family_id, first.family_id);
  assert.equal(second.owner_id, 'editor');
  assert.notEqual(second.id, first.id);

  const third = await store.cloneTrack(second.id, 'editor', input());
  assert.equal(third.name, 'Mountain Loop V3');
  assert.equal(third.version, 3);

  // The original remains untouched and all versions are listed newest-family aware.
  const tracks = await store.list('owner');
  assert.equal(tracks.length, 3);
  assert.deepEqual(new Set(tracks.map((track) => track.family_id)), new Set([first.family_id]));
  await assert.rejects(store.cloneTrack('missing', 'editor', input()));
});

test('votes aggregate per user and can be changed or cleared', async (t) => {
  const { db, store } = await setup();
  t.after(() => db.close());
  const track = await store.createTrack('owner', input());
  await store.setVote(track.id, 'alice', 1);
  await store.setVote(track.id, 'bob', -1);
  await store.setVote(track.id, 'carol', 1);
  const listed = await store.list('alice');
  assert.equal(listed[0]!.up, 2);
  assert.equal(listed[0]!.down, 1);
  assert.equal(listed[0]!.mine, 1);
  const bobView = await store.list('bob');
  assert.equal(bobView[0]!.mine, -1);
  // Switching a vote replaces it, clearing removes it.
  await store.setVote(track.id, 'alice', -1);
  assert.equal((await store.list('alice'))[0]!.up, 1);
  assert.equal((await store.list('alice'))[0]!.down, 2);
  await store.setVote(track.id, 'alice', 0);
  const cleared = await store.list('alice');
  assert.equal(cleared[0]!.mine, 0);
  assert.equal(cleared[0]!.down, 1);
  assert.equal(await store.setVote('missing', 'alice', 1), null);
});

test('deleting a track removes its votes and cached gates', async (t) => {
  const { db, store } = await setup();
  t.after(() => db.close());
  const track = await store.createTrack('owner', input());
  await store.setVote(track.id, 'alice', 1);
  assert.equal(await store.deleteTrack(track.id), true);
  assert.equal(await store.deleteTrack(track.id), false);
  assert.equal(await store.get(track.id, 'alice'), null);
  assert.equal(await store.gatesFor(track.id), null);
});

test('runs credit gates in order and record finish time and average speed', async (t) => {
  const { db, store, setClock } = await setup();
  t.after(() => db.close());
  const track = await store.createTrack('owner', input());
  setClock(1000);
  const started = await store.startRun('room', track.id, 'driver');
  assert.equal(started.status, 'active');
  assert.equal(started.next_gate, 0);
  assert.equal(started.gates_total, 3);
  assert.equal(started.started_at, 1000);
  // Activation alone does not start the clock; the start gate must be passed first.
  assert.deepEqual(started.gate_times, []);
  assert.equal(started.duration_ms, null);

  // The fix is exactly on the start gate.
  setClock(2000);
  const afterStart = await store.observeRun('room', 'driver', { latitude: 0, longitude: 0, accuracy: 10 });
  assert.equal(afterStart?.next_gate, 1);
  assert.deepEqual(afterStart?.gate_times, [2000]);

  // A poor-accuracy fix and an out-of-order fix never advance.
  setClock(2500);
  assert.equal(await store.observeRun('room', 'driver', { latitude: 0, longitude: 0.001, accuracy: 150 }), null);
  assert.equal(await store.observeRun('room', 'driver', { latitude: 0, longitude: 0.002, accuracy: 5 }), null);

  setClock(4000);
  const afterCheckpoint = await store.observeRun('room', 'driver', { latitude: 0, longitude: 0.001, accuracy: 20 });
  assert.equal(afterCheckpoint?.next_gate, 2);
  setClock(6000);
  const finished = await store.observeRun('room', 'driver', { latitude: 0, longitude: 0.002, accuracy: 10 });
  assert.equal(finished?.status, 'finished');
  assert.equal(finished?.finished_at, 6000);
  // Duration is measured from the start gate pass (2000), not from activation (1000).
  assert.equal(finished?.duration_ms, 4000);
  assert.ok(finished?.avg_speed_mps && finished.avg_speed_mps > 0);
  assert.equal(await store.getActiveRun('room', 'driver'), null);
  assert.equal(await store.observeRun('room', 'driver', { latitude: 0, longitude: 0.002, accuracy: 10 }), null);
});

test('abandoning after the start gate records time from the start gate', async (t) => {
  const { db, store, setClock } = await setup();
  t.after(() => db.close());
  const track = await store.createTrack('owner', input());
  setClock(1000);
  await store.startRun('room', track.id, 'driver');
  setClock(5000);
  await store.observeRun('room', 'driver', { latitude: 0, longitude: 0, accuracy: 10 });
  setClock(9000);
  const ended = await store.endRun('room', 'driver');
  assert.equal(ended?.status, 'abandoned');
  assert.equal(ended?.duration_ms, 4000);
});

test('leaderboard paginates each driver\'s best time and every finished run', async (t) => {
  const { db, store, setClock } = await setup();
  t.after(() => db.close());
  const track = await store.createTrack('owner', input());
  const finish = async (userId: string, times: [number, number, number, number]) => {
    setClock(times[0]);
    await store.startRun('room', track.id, userId);
    setClock(times[1]);
    await store.observeRun('room', userId, { latitude: 0, longitude: 0, accuracy: 10 });
    setClock(times[2]);
    await store.observeRun('room', userId, { latitude: 0, longitude: 0.001, accuracy: 10 });
    setClock(times[3]);
    const result = await store.observeRun('room', userId, { latitude: 0, longitude: 0.002, accuracy: 10 });
    assert.equal(result?.status, 'finished');
  };
  // Two finished runs for alice prove runs are appended, not overwritten.
  await finish('alice', [1000, 2000, 4000, 8000]);
  await finish('bob', [10000, 11000, 13000, 17000]);
  await finish('alice', [20000, 21000, 23000, 25000]);
  setClock(30000);
  await store.startRun('room', track.id, 'carol');

  const board = await store.leaderboard(track.id);
  assert.deepEqual(board.entries.map((entry) => entry.user_id), ['alice', 'bob']);
  assert.equal(board.total, 2);
  assert.equal(board.has_more, false);
  // Alice's 4s run beats her earlier 6s run; carol never finished and is excluded.
  assert.equal(board.entries[0]!.duration_ms, 4000);
  assert.equal(board.entries[1]!.duration_ms, 6000);
  assert.ok(board.entries.every((entry) => entry.avg_speed_mps !== null && entry.avg_speed_mps > 0));
  assert.equal((await store.leaderboard('missing')).entries.length, 0);

  const allTimes = await store.leaderboard(track.id, { allTimes: true });
  assert.deepEqual(allTimes.entries.map((entry) => entry.user_id), ['alice', 'alice', 'bob']);
  assert.equal(new Set(allTimes.entries.map((entry) => entry.run_id)).size, 3);
  assert.equal(allTimes.total, 3);
  assert.equal(allTimes.has_more, false);

  const extraRuns = Array.from({ length: 501 }, (_, index) =>
    `('bulk-${index}', '${track.id}', 'bulk-driver', 'room', 1000, ${20000 + index}, 3, 3, '[]', 222, ${10000 + index}, 22.2, 'finished', ${20000 + index})`
  ).join(',');
  await run(db, `INSERT INTO drive_track_runs (id, track_id, user_id, channel_id, started_at, finished_at, next_gate, gates_total, gate_times_json, distance_m, duration_ms, avg_speed_mps, status, updated_at) VALUES ${extraRuns}`);
  const firstPage = await store.leaderboard(track.id, { allTimes: true });
  assert.equal(firstPage.entries.length, 50);
  assert.equal(firstPage.total, 504);
  assert.equal(firstPage.has_more, true);
  const lastPage = await store.leaderboard(track.id, { allTimes: true, offset: 500 });
  assert.equal(lastPage.entries.length, 4);
  assert.equal(lastPage.has_more, false);
  assert.equal((await store.leaderboard(track.id, { allTimes: true, offset: 501 })).entries.length, 3);

  // Best-per-driver mode also paginates when there are more drivers than one page.
  const second = await store.createTrack('owner', input('Paginated'));
  const pagedRuns = Array.from({ length: 60 }, (_, index) =>
    `('page-${index}', '${second.id}', 'driver-${index}', 'room', 1000, ${30000 + index}, 3, 3, '[]', 222, ${20000 + index}, 22.2, 'finished', ${30000 + index})`
  ).join(',');
  await run(db, `INSERT INTO drive_track_runs (id, track_id, user_id, channel_id, started_at, finished_at, next_gate, gates_total, gate_times_json, distance_m, duration_ms, avg_speed_mps, status, updated_at) VALUES ${pagedRuns}`);
  const driversFirstPage = await store.leaderboard(second.id);
  assert.equal(driversFirstPage.entries.length, 50);
  assert.equal(driversFirstPage.total, 60);
  assert.equal(driversFirstPage.has_more, true);
  const driversSecondPage = await store.leaderboard(second.id, { offset: 50 });
  assert.equal(driversSecondPage.entries.length, 10);
  assert.equal(driversSecondPage.has_more, false);
});

test('starting a new run abandons the previous one and leaving closes active runs', async (t) => {
  const { db, store, setClock } = await setup();
  t.after(() => db.close());
  const first = await store.createTrack('owner', input());
  const second = await store.createTrack('owner', input('Second'));
  setClock(1000);
  await store.startRun('room', first.id, 'driver');
  setClock(5000);
  const restarted = await store.startRun('room', second.id, 'driver');
  assert.equal(restarted.track_id, second.id);
  assert.equal(restarted.next_gate, 0);

  setClock(8000);
  const ended = await store.endRun('room', 'driver');
  assert.equal(ended?.status, 'abandoned');
  // The run never reached the start gate, so no time is recorded.
  assert.equal(ended?.duration_ms, null);
  assert.equal(ended?.avg_speed_mps, null);

  setClock(9000);
  await store.startRun('room', first.id, 'driver');
  await store.abandonRunsForChannel('room');
  assert.equal(await store.getActiveRun('room', 'driver'), null);
});
