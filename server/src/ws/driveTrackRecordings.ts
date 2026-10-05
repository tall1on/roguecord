import { connectionManager } from './connectionManager';
import { rooms } from '../mediasoup';
import type { DriveTrackRun } from '../driveTracks';
import { TRACK_RECORDING_MAX_DURATION_MS } from '../storage/trackRecordingStorage';

type RecordingSession = {
  runId: string;
  trackId: string;
  channelId: string;
  userId: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type StopReason = 'track_finished' | 'track_abandoned' | 'camera_off' | 'timeout' | 'driver_left' | 'run_ended';

/**
 * Starts and stops server-driven camera recordings for timed track runs.
 *
 * The server owns the lifecycle: a recording begins once a driver with an active (timed)
 * run has a camera producer in the drive room, and it is stopped when the run ends, the
 * camera is turned off, the driver leaves, or the hard three-minute cap is reached. The
 * driver client performs the actual MediaRecorder capture and uploads the result.
 */
export class TrackRecordingManager {
  private sessions = new Map<string, RecordingSession>();
  private stopped = new Set<string>();
  private readonly maxDurationMs: number;

  constructor(maxDurationMs: number = TRACK_RECORDING_MAX_DURATION_MS) {
    this.maxDurationMs = maxDurationMs;
  }

  private isActiveTimedRun(run: DriveTrackRun): boolean {
    return run.status === 'active' && run.gate_times.length > 0;
  }

  private hasCameraProducer(channelId: string, userId: string): boolean {
    const peer = rooms.get(channelId)?.peers.get(userId);
    if (!peer) return false;
    for (const producer of peer.producers.values()) {
      if ((producer.appData as { source?: unknown } | undefined)?.source === 'camera') return true;
    }
    return false;
  }

  private forgetStopped(runId: string): void {
    this.stopped.add(runId);
    if (this.stopped.size > 2048) {
      for (const id of this.stopped) {
        if (!this.sessions.has(id)) {
          this.stopped.delete(id);
          if (this.stopped.size <= 1024) break;
        }
      }
    }
  }

  /** Reconciles recording sessions for one driver against the latest run list and camera state. */
  sync(channelId: string, userId: string, runs: readonly DriveTrackRun[]): void {
    const eligible = new Map<string, DriveTrackRun>();
    for (const run of runs) {
      if (run.channel_id === channelId && run.user_id === userId && this.isActiveTimedRun(run)) eligible.set(run.id, run);
    }
    const cameraOn = this.hasCameraProducer(channelId, userId);

    for (const [runId, session] of [...this.sessions]) {
      if (session.channelId !== channelId || session.userId !== userId) continue;
      if (!cameraOn || !eligible.has(runId)) {
        const run = runs.find((entry) => entry.id === runId);
        const reason: StopReason = !cameraOn
          ? 'camera_off'
          : run?.status === 'finished'
            ? 'track_finished'
            : run?.status === 'abandoned'
              ? 'track_abandoned'
              : 'run_ended';
        this.stop(runId, reason);
      }
    }

    if (!cameraOn) return;
    for (const run of eligible.values()) {
      if (this.sessions.has(run.id) || this.stopped.has(run.id)) continue;
      this.start(run);
    }
  }

  /**
   * Stops sessions for runs that are no longer active/timed without treating an absent camera as a
   * stop signal. Used on reconnect, where the camera producer is recreated shortly after joining.
   */
  reconcile(channelId: string, userId: string, runs: readonly DriveTrackRun[]): void {
    const eligible = new Set<string>();
    for (const run of runs) {
      if (run.channel_id === channelId && run.user_id === userId && this.isActiveTimedRun(run)) eligible.add(run.id);
    }
    for (const [runId, session] of [...this.sessions]) {
      if (session.channelId !== channelId || session.userId !== userId) continue;
      if (eligible.has(runId)) continue;
      const run = runs.find((entry) => entry.id === runId);
      const reason: StopReason = run?.status === 'finished'
        ? 'track_finished'
        : run?.status === 'abandoned'
          ? 'track_abandoned'
          : 'run_ended';
      this.stop(runId, reason);
    }
  }

  private start(run: DriveTrackRun): void {
    const timer = setTimeout(() => this.stop(run.id, 'timeout'), this.maxDurationMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.sessions.set(run.id, {
      runId: run.id,
      trackId: run.track_id,
      channelId: run.channel_id,
      userId: run.user_id,
      startedAt: Date.now(),
      timer
    });
    connectionManager.sendToUser(run.user_id, {
      type: 'drive_recording_start',
      payload: {
        channel_id: run.channel_id,
        run_id: run.id,
        track_id: run.track_id,
        max_duration_ms: this.maxDurationMs
      }
    });
  }

  private stop(runId: string, reason: StopReason): void {
    const session = this.sessions.get(runId);
    if (!session) return;
    clearTimeout(session.timer);
    this.sessions.delete(runId);
    this.forgetStopped(runId);
    connectionManager.sendToUser(session.userId, {
      type: 'drive_recording_stop',
      payload: { channel_id: session.channelId, run_id: runId, reason }
    });
  }

  /** Marks a run as completed so a late sync cannot restart its session. */
  complete(runId: string): void {
    this.forgetStopped(runId);
  }

  shutdownUser(userId: string): void {
    for (const [runId, session] of [...this.sessions]) {
      if (session.userId === userId) this.stop(runId, 'driver_left');
    }
  }

  shutdownDriver(channelId: string, userId: string): void {
    for (const [runId, session] of [...this.sessions]) {
      if (session.channelId === channelId && session.userId === userId) this.stop(runId, 'driver_left');
    }
  }

  shutdownChannel(channelId: string): void {
    for (const [runId, session] of [...this.sessions]) {
      if (session.channelId === channelId) this.stop(runId, 'driver_left');
    }
  }
}

export const trackRecordings = new TrackRecordingManager();
