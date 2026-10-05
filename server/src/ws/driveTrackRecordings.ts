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
 * run has a camera producer in the drive room, and it is stopped when the run ends, the
 * camera is turned off, the driver leaves, or the hard three-minute cap is reached. The
 * driver client performs the actual MediaRecorder capture and uploads the result.
 *
 * A driver can only ever produce one camera stream, and the client can only run one
 * MediaRecorder, so at most one session is tracked per driver. When several runs are
 * active at once (for example a forward and its reversed layout, whose start gate is the
 * other track's finish), the chosen run is recorded and the session rolls over to the next
 * eligible run as soon as the recorded one finishes. This keeps every start command
 * correlated with a matching stop, so a finish is never mistaken for a restart and the
 * client never strands a recording until the hard cap.
 */
export class TrackRecordingManager {
  private sessions = new Map<string, RecordingSession>();
  private stopped = new Set<string>();

  constructor(private maxDurationMs: number, private deps: RecordingManagerDeps) {}

  private isActiveTimedRun(run: DriveTrackRun): boolean {
    return run.status === 'active' && run.gate_times.length > 0;
  }

  private sessionForDriver(channelId: string, userId: string): RecordingSession | null {
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId && session.userId === userId) return session;
    }
    return null;
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

  /** Picks the run to record when a driver has more than one active timed run. */
  private pickCandidate(eligible: Iterable<DriveTrackRun>): DriveTrackRun | null {
    let candidate: DriveTrackRun | null = null;
    for (const run of eligible) {
      if (this.stopped.has(run.id)) continue;
      if (!candidate) { candidate = run; continue; }
      // Prefer the run that is furthest along, then the one that started earliest. This keeps a
      // finishing forward run recorded until it completes instead of switching to a freshly
      // started reversed run that merely shares the same physical start/finish point.
      if (run.next_gate > candidate.next_gate) { candidate = run; continue; }
      if (run.next_gate === candidate.next_gate && run.started_at < candidate.started_at) candidate = run;
    }
    return candidate;
  }

  /**
   * Reconciles recording sessions for one driver against the latest run list and camera state.
   * At most one session per driver is kept: the current one while its run stays eligible, then
   * the best remaining eligible run once it ends.
   */
  sync(channelId: string, userId: string, runs: readonly DriveTrackRun[]): void {
    const eligible = new Map<string, DriveTrackRun>();
    for (const run of runs) {
      if (run.channel_id === channelId && run.user_id === userId && this.isActiveTimedRun(run)) eligible.set(run.id, run);
    }
    const cameraOn = this.deps.hasCameraProducer(channelId, userId);

    const current = this.sessionForDriver(channelId, userId);
    if (current && (!cameraOn || !eligible.has(current.runId))) {
      const ended = runs.find((entry) => entry.id === current.runId);
      const reason: RecordingStopReason = !cameraOn
        ? 'camera_off'
        : ended?.status === 'finished'
          ? 'track_finished'
          : ended?.status === 'abandoned'
            ? 'track_abandoned'
            : 'run_ended';
      this.stop(current.runId, reason);
    }

    if (!cameraOn) return;
    // A session is already running; never start a second one for the same driver.
    if (this.sessionForDriver(channelId, userId)) return;

    const candidate = this.pickCandidate(eligible.values());
    if (candidate) this.start(candidate);
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
    const current = this.sessionForDriver(channelId, userId);
    if (!current || eligible.has(current.runId)) return;
    const run = runs.find((entry) => entry.id === current.runId);
    const reason: RecordingStopReason = run?.status === 'finished'
      ? 'track_finished'
      : run?.status === 'abandoned'
        ? 'track_abandoned'
        : 'run_ended';
    this.stop(current.runId, reason);
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
