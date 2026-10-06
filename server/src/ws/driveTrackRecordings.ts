import type { DriveTrackRun } from '../driveTracks';

type RecordingSession = {
  runId: string;
  trackId: string;
  channelId: string;
  userId: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export type RecordingStopReason = 'track_finished' | 'track_abandoned' | 'camera_off' | 'timeout' | 'driver_left' | 'run_ended';

export type RecordingManagerDeps = {
  /** Whether the driver currently has a live camera producer in the drive room. */
  hasCameraProducer: (channelId: string, userId: string) => boolean;
  /** Delivers a recording lifecycle message to one specific driver. */
  sendToUser: (userId: string, message: unknown) => void;
};

/**
 * Starts and stops server-driven camera recordings for timed track runs.
 *
 * The server owns the lifecycle: a recording begins once a driver with an active (timed)
 * run has a camera producer in the drive room, and it is stopped when its run ends, the
 * camera is turned off, the driver leaves, or the hard three-minute cap is reached. The
 * driver client performs the actual MediaRecorder capture and uploads the result.
 *
 * A driver may be timing several overlapping tracks at once (for example two tracks that
 * share part of their route), so every active timed run gets its own concurrent session and
 * its own clip. Sessions are keyed by run id, and each start command is paired with exactly
 * one stop. A run that has already been recorded (or explicitly stopped) is not restarted
 * until it is abandoned and started again as a fresh run.
 */
export class TrackRecordingManager {
  private sessions = new Map<string, RecordingSession>();
  private stopped = new Set<string>();

  constructor(private maxDurationMs: number, private deps: RecordingManagerDeps) {}

  private isActiveTimedRun(run: DriveTrackRun): boolean {
    return run.status === 'active' && run.gate_times.length > 0;
  }

  private sessionsForDriver(channelId: string, userId: string): RecordingSession[] {
    const matches: RecordingSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId && session.userId === userId) matches.push(session);
    }
    return matches;
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

  /**
   * Reconciles recording sessions for one driver against the latest run list and camera state.
   * Every active timed run is recorded concurrently: a session is stopped once its run leaves the
   * active set or the camera disappears, and a session is started for each eligible run that does
   * not have one yet.
   */
  sync(channelId: string, userId: string, runs: readonly DriveTrackRun[]): void {
    const eligible = new Map<string, DriveTrackRun>();
    for (const run of runs) {
      if (run.channel_id === channelId && run.user_id === userId && this.isActiveTimedRun(run)) eligible.set(run.id, run);
    }
    const cameraOn = this.deps.hasCameraProducer(channelId, userId);

    for (const session of this.sessionsForDriver(channelId, userId)) {
      if (!cameraOn || !eligible.has(session.runId)) {
        const ended = runs.find((entry) => entry.id === session.runId);
        const reason: RecordingStopReason = !cameraOn
          ? 'camera_off'
          : ended?.status === 'finished'
            ? 'track_finished'
            : ended?.status === 'abandoned'
              ? 'track_abandoned'
              : 'run_ended';
        this.stop(session.runId, reason);
      }
    }

    if (!cameraOn) return;
    // Overlapping active runs are recorded side by side, one session per run.
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
    for (const session of this.sessionsForDriver(channelId, userId)) {
      if (eligible.has(session.runId)) continue;
      const run = runs.find((entry) => entry.id === session.runId);
      const reason: RecordingStopReason = run?.status === 'finished'
        ? 'track_finished'
        : run?.status === 'abandoned'
          ? 'track_abandoned'
          : 'run_ended';
      this.stop(session.runId, reason);
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
    this.deps.sendToUser(run.user_id, {
      type: 'drive_recording_start',
      payload: {
        channel_id: run.channel_id,
        run_id: run.id,
        track_id: run.track_id,
        max_duration_ms: this.maxDurationMs
      }
    });
  }

  private stop(runId: string, reason: RecordingStopReason): void {
    const session = this.sessions.get(runId);
    if (!session) return;
    clearTimeout(session.timer);
    this.sessions.delete(runId);
    this.forgetStopped(runId);
    this.deps.sendToUser(session.userId, {
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
