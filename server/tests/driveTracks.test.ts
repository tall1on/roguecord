import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceRun,
  computeRunStats,
  displayTrackName,
  DriveTrackError,
  GATE_MAX_RADIUS_M,
  GATE_MIN_RADIUS_M,
  gateRadiusMeters,
  haversineMeters,
  normalizeTrackName,
  parseTrackPayload,
  trackDistanceMeters,
  trackGates,
  trackMaxDurationMs,
  TRACK_CHECKPOINT_MAX,
  TRACK_TIMEOUT_ABSOLUTE_MAX_MS,
  TRACK_TIMEOUT_MAX_MS,
  TRACK_TIMEOUT_MIN_MS,
  type RunProgress
} from '../src/driveTracks';

const payload = (overrides: Record<string, unknown> = {}) => ({
  start: { latitude: 0, longitude: 0 },
  checkpoints: [{ latitude: 0, longitude: 0.001, name: 'A' }],
  end: { latitude: 0, longitude: 0.002 },
  ...overrides
});

test('track names are trimmed, bounded and reject control characters', () => {
  assert.equal(normalizeTrackName('  Mountain   Loop  '), 'Mountain Loop');
  for (const invalid of [undefined, null, 42, '', '   ', 'x'.repeat(81), 'bad\u0000name', 'bad\u001fname']) {
    assert.throws(() => normalizeTrackName(invalid), DriveTrackError);
  }
});

test('track payloads validate coordinates, checkpoint limits and names', () => {
  const parsed = parseTrackPayload(payload());
  assert.deepEqual(parsed.start, { latitude: 0, longitude: 0 });
  assert.equal(parsed.checkpoints.length, 1);
  assert.equal(parsed.checkpoints[0]!.name, 'A');
  assert.deepEqual(parseTrackPayload({ start: { latitude: 1, longitude: 2 }, end: { latitude: 3, longitude: 4 } }).checkpoints, []);
  assert.throws(() => parseTrackPayload(null), DriveTrackError);
  assert.throws(() => parseTrackPayload({ start: { latitude: 200, longitude: 0 }, end: { latitude: 0, longitude: 0 } }), /start/);
  assert.throws(() => parseTrackPayload({ start: { latitude: 0, longitude: 0 }, end: { latitude: 0, longitude: 200 } }), /end/);
  assert.throws(() => parseTrackPayload({ start: { latitude: 0, longitude: 0 }, end: { latitude: 0, longitude: 1 }, checkpoints: [{ latitude: NaN, longitude: 0 }] }), /Checkpoint 1/);
  assert.throws(() => parseTrackPayload({ start: { latitude: 0, longitude: 0 }, end: { latitude: 0, longitude: 1 }, checkpoints: Array.from({ length: TRACK_CHECKPOINT_MAX + 1 }, () => ({ latitude: 0, longitude: 0 })) }), /at most/);
  assert.throws(() => parseTrackPayload({ start: { latitude: 0, longitude: 0 }, end: { latitude: 0, longitude: 1 }, checkpoints: [{ latitude: 0, longitude: 0, name: 'x'.repeat(65) }] }), /Checkpoint name/);
  assert.equal(parseTrackPayload({ start: { latitude: 0, longitude: 0 }, end: { latitude: 0, longitude: 1 }, checkpoints: [{ latitude: 0, longitude: 0, name: '  ' }] }).checkpoints[0]!.name, null);
});

test('gates are ordered start, checkpoints, end and distance sums the segments', () => {
  const gates = trackGates(parseTrackPayload(payload()));
  assert.deepEqual(gates.map((gate) => gate.kind), ['start', 'checkpoint', 'end']);
  assert.deepEqual(gates.map((gate) => gate.index), [0, 1, 2]);
  assert.equal(gates[1]!.name, 'A');
  assert.ok(Math.abs(trackDistanceMeters(gates) - 222) < 2);
  // One degree of latitude is about 111 km.
  assert.ok(Math.abs(haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 }) - 111195) < 100);
  assert.equal(displayTrackName('Loop', 1), 'Loop');
  assert.equal(displayTrackName('Loop', 3), 'Loop V3');
});

test('gate radius grants GPS leeway but is clamped at both ends', () => {
  assert.equal(gateRadiusMeters(0), GATE_MIN_RADIUS_M);
  assert.equal(gateRadiusMeters(5), GATE_MIN_RADIUS_M);
  assert.equal(gateRadiusMeters(30), 45);
  assert.equal(gateRadiusMeters(1000), GATE_MAX_RADIUS_M);
});

test('run timeouts scale with distance but stay within sane bounds', () => {
  // Short tracks keep the floor so a tiny loop is never abandoned instantly.
  assert.equal(trackMaxDurationMs(0), TRACK_TIMEOUT_MIN_MS);
  assert.equal(trackMaxDurationMs(200), TRACK_TIMEOUT_MIN_MS);
  // A ~3 km track finishes in 1.5-3 minutes, so it must not linger for over an hour.
  assert.equal(trackMaxDurationMs(3000), 10 * 60 * 1000);
  assert.ok(trackMaxDurationMs(3000) < TRACK_TIMEOUT_MAX_MS);
  // Very long tracks are capped instead of growing without bound.
  assert.equal(trackMaxDurationMs(100000), TRACK_TIMEOUT_MAX_MS);
  // The estimate stays monotonic between the bounds.
  assert.ok(trackMaxDurationMs(1000) <= trackMaxDurationMs(2000));
  // A recorded finish anchors the window: a slow record raises it up to the absolute cap, while a
  // fast record never drops it below the distance estimate.
  assert.equal(trackMaxDurationMs(3000, 20 * 60 * 1000), TRACK_TIMEOUT_ABSOLUTE_MAX_MS);
  assert.equal(trackMaxDurationMs(3000, 30 * 1000), 10 * 60 * 1000);
  assert.equal(trackMaxDurationMs(3000, 0), 10 * 60 * 1000);
  assert.equal(trackMaxDurationMs(3000, Number.NaN), 10 * 60 * 1000);
});

const progress = (nextGate: number, gateTimes: number[]): RunProgress => ({ nextGate, gateTimes, status: 'active', finishedAt: null });
const gates = trackGates(parseTrackPayload(payload()));

test('checkpoint detection credits the next gate inside the leeway radius', () => {
  const result = advanceRun(progress(0, []), gates, { latitude: 0, longitude: 0, accuracy: 8 }, 1000);
  assert.equal(result?.passedGate, 0);
  assert.deepEqual(result?.progress.gateTimes, [1000]);
  assert.equal(result?.progress.nextGate, 1);
  // A fix slightly off the start, within the accuracy-scaled radius, still counts.
  assert.equal(advanceRun(progress(0, []), gates, { latitude: 0, longitude: 0.0002, accuracy: 8 }, 1000)?.passedGate, 0);
});

test('checkpoint detection rejects out-of-order, distant, low-quality and too-fast gate passes', () => {
  // Outside the leeway radius.
  assert.equal(advanceRun(progress(0, []), gates, { latitude: 0, longitude: 0.01, accuracy: 8 }, 1000), null);
  // Poor accuracy never advances progress.
  assert.equal(advanceRun(progress(0, []), gates, { latitude: 0, longitude: 0, accuracy: 150 }, 1000), null);
  assert.equal(advanceRun(progress(0, []), gates, { latitude: 0, longitude: 0, accuracy: NaN }, 1000), null);
  // The next expected gate is the checkpoint, so landing on the finish does nothing.
  assert.equal(advanceRun(progress(1, [1000]), gates, { latitude: 0, longitude: 0.002, accuracy: 8 }, 2000), null);
  // Two gates cannot be credited inside the minimum interval.
  assert.equal(advanceRun(progress(1, [1000]), gates, { latitude: 0, longitude: 0.001, accuracy: 8 }, 1500), null);
  // A physically impossible jump is rejected even when the fix is exactly on the gate.
  const far = trackGates(parseTrackPayload({ start: { latitude: 0, longitude: 0 }, end: { latitude: 0, longitude: 0.5 } }));
  assert.equal(advanceRun(progress(1, [1000]), far, { latitude: 0, longitude: 0.5, accuracy: 5 }, 2000), null);
});

test('a valid ordered run finishes with timing and average speed', () => {
  const first = advanceRun(progress(0, []), gates, { latitude: 0, longitude: 0, accuracy: 10 }, 1000)!;
  const second = advanceRun(first.progress, gates, { latitude: 0, longitude: 0.001, accuracy: 20 }, 3000)!;
  assert.equal(second.progress.nextGate, 2);
  const third = advanceRun(second.progress, gates, { latitude: 0, longitude: 0.002, accuracy: 10 }, 5000)!;
  assert.equal(third.progress.status, 'finished');
  assert.equal(third.progress.finishedAt, 5000);
  const stats = computeRunStats(trackDistanceMeters(gates), 1000, 5000);
  assert.equal(stats.duration_ms, 4000);
  assert.ok(stats.avg_speed_mps! > 0 && stats.avg_speed_mps! < 60);
  assert.deepEqual(computeRunStats(100, 1000, null), { duration_ms: null, avg_speed_mps: null });
  assert.equal(computeRunStats(100, 5000, 5000).duration_ms, 0);
});
