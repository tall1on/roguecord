import assert from 'node:assert/strict';
import test from 'node:test';
import type { DriveTrackRun } from '../src/driveTracks';
import { TrackRecordingManager } from '../src/ws/driveTrackRecordings';

type Sent = { userId: string; type: string; payload: Record<string, unknown> };

const run = (overrides: Partial<DriveTrackRun> = {}): DriveTrackRun => ({
  id: 'r1',
  track_id: 't1',
  user_id: 'driver',
  channel_id: 'room',
  started_at: 1000,
  finished_at: null,
  next_gate: 1,
  gates_total: 3,
  gate_times: [1000],
  distance_m: 100,
  duration_ms: null,
  avg_speed_mps: null,
  max_speed_mps: null,
  status: 'active',
  updated_at: 1000,
  ...overrides
});

const setup = () => {
  const sent: Sent[] = [];
  const camera = { on: true };
  const manager = new TrackRecordingManager(60000, {
    hasCameraProducer: () => camera.on,
    sendToUser: (userId, message) => {
      const typed = message as { type: string; payload: Record<string, unknown> };
      sent.push({ userId, type: typed.type, payload: typed.payload });
    }
  });
  return { manager, sent, camera };
};

test('records every overlapping run concurrently and stops each session independently', () => {
  const { manager, sent, camera } = setup();

  // Two overlapping active runs each get their own session.
  const forward = run({ id: 'fwd', track_id: 'fwd-track', next_gate: 2 });
  const reverse = run({ id: 'rev', track_id: 'rev-track', next_gate: 1, started_at: 2000, gate_times: [2000] });
  manager.sync('room', 'driver', [forward, reverse]);

  assert.deepEqual(sent.map((entry) => entry.type), ['drive_recording_start', 'drive_recording_start']);
  assert.deepEqual(sent.map((entry) => entry.payload.run_id), ['fwd', 'rev']);

  // A duplicate sync does not start extra sessions.
  manager.sync('room', 'driver', [forward, reverse]);
  assert.equal(sent.length, 2);

  // A newly eligible overlapping run starts a third session without disturbing the others.
  const extra = run({ id: 'extra', track_id: 'extra-track', started_at: 2500, gate_times: [2500] });
  manager.sync('room', 'driver', [forward, reverse, extra]);
  assert.equal(sent.length, 3);
  assert.equal(sent[2]!.payload.run_id, 'extra');

  // One run finishing stops only its own session; the others keep recording.
  manager.sync('room', 'driver', [
    run({ id: 'fwd', track_id: 'fwd-track', next_gate: 3, status: 'finished', finished_at: 5000 }),
    reverse,
    extra
  ]);
  const afterFinish = sent.slice(3);
  assert.deepEqual(afterFinish.map((entry) => entry.type), ['drive_recording_stop']);
  assert.equal(afterFinish[0]!.payload.run_id, 'fwd');
  assert.equal(afterFinish[0]!.payload.reason, 'track_finished');

  // Turning the camera off stops every remaining session for the driver.
  camera.on = false;
  manager.sync('room', 'driver', [reverse, extra]);
  const afterCameraOff = sent.slice(4);
  assert.deepEqual(afterCameraOff.map((entry) => entry.type), ['drive_recording_stop', 'drive_recording_stop']);
  assert.deepEqual(afterCameraOff.map((entry) => entry.payload.run_id), ['rev', 'extra']);
  assert.ok(afterCameraOff.every((entry) => entry.payload.reason === 'camera_off'));
});

test('reconcile stops a run that is no longer active without starting a replacement', () => {
  const { manager, sent } = setup();
  manager.sync('room', 'driver', [run({ id: 'r1' })]);
  assert.equal(sent[0]!.type, 'drive_recording_start');

  manager.reconcile('room', 'driver', [run({ id: 'r1', status: 'abandoned', finished_at: 2000 })]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.type, 'drive_recording_stop');
  assert.equal(sent[1]!.payload.reason, 'track_abandoned');
});

test('each driver keeps an independent session', () => {
  const { manager, sent } = setup();
  manager.sync('room', 'alice', [run({ id: 'alice-run', user_id: 'alice' })]);
  manager.sync('room', 'bob', [run({ id: 'bob-run', user_id: 'bob' })]);

  assert.deepEqual(sent.map((entry) => entry.userId), ['alice', 'bob']);
  assert.deepEqual(sent.map((entry) => entry.payload.run_id), ['alice-run', 'bob-run']);

  // Bob leaving only stops Bob's session.
  manager.shutdownDriver('room', 'bob');
  assert.equal(sent.length, 3);
  assert.equal(sent[2]!.userId, 'bob');
  assert.equal(sent[2]!.type, 'drive_recording_stop');
});
