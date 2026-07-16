import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { APP_RUNNER_LABEL, CONFIG_KEYS, configService, logger } from '@haive/shared';

const exec = promisify(execFile);
const log = logger.child({ module: 'runtime-runner-reaper' });

/** Sweep interval. A leaked runner is reclaimed at most this long after it becomes
 *  eligible (its task reaching a terminal state, or the failed-grace elapsing). */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Task statuses at which a runtime runner serves no one and is safe to reap. `failed`
 *  is handled separately (kept for retry until the grace elapses). */
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);

type ReapReason = 'exited' | 'orphan' | 'terminal' | 'failed-grace';

interface RunnerContainer {
  id: string;
  taskId: string | null;
  running: boolean;
  startedAtMs: number | null;
}

export interface RuntimeRunnerReaperOptions {
  db: Database;
  intervalMs?: number;
}

/** Periodic sweep that reclaims leaked per-task DDEV/app runtime runners. A task that
 *  ends in `failed` deliberately keeps its runner alive for retry, and the worker-boot
 *  reaper preserves runners — so a runner whose task was abandoned (never retried /
 *  resumed / cancelled), or whose worker crashed, otherwise lives forever (a live
 *  dockerd + Chromium + a 1-2 GB anon volume). No runner-activity timestamp exists in
 *  the system, so this keys on task STATUS + container age, never on "is anyone watching
 *  the VNC": it reaps runners whose task is completed/cancelled/missing, whose container
 *  has exited, or whose task has been `failed` longer than the grace — and never touches
 *  a running/paused/waiting task's runner. Task-end cleanup still owns the normal path;
 *  this is the backstop for the leak.
 */
export class RuntimeRunnerReaper {
  private readonly db: Database;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(opts: RuntimeRunnerReaperOptions) {
    this.db = opts.db;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.sweep()
        .catch((err) => log.warn({ err }, 'runtime runner reaper sweep failed'))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info({ intervalMs: this.intervalMs }, 'runtime runner reaper started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Single sweep pass. Exposed for tests so they can drive it deterministically. */
  async sweep(): Promise<{ scanned: number; reaped: number }> {
    const containers = await this.listRunnerContainers();
    const failedGraceMs = await this.failedGraceMs();
    let reaped = 0;
    for (const c of containers) {
      const reason = await this.reapReason(c, failedGraceMs).catch((err) => {
        log.warn({ err, id: c.id }, 'runtime reap decision failed');
        return null;
      });
      if (!reason) continue;
      await this.reap(c.id);
      log.info({ id: c.id, taskId: c.taskId, reason }, 'reaped leaked runtime runner');
      reaped += 1;
    }
    return { scanned: containers.length, reaped };
  }

  /** Grace (ms) before a `failed` task's runner is reclaimed; 0 disables that path. */
  private async failedGraceMs(): Promise<number> {
    try {
      const minutes = await configService.getNumber(CONFIG_KEYS.RUNTIME_IDLE_REAP_MINUTES, 180);
      return Math.max(0, minutes) * 60_000;
    } catch {
      return 180 * 60_000;
    }
  }

  /** Why this runner should be reaped, or null to keep it. Fail-safe: a DB error keeps
   *  the runner (null) rather than risk reaping a live task's runtime. */
  private async reapReason(c: RunnerContainer, failedGraceMs: number): Promise<ReapReason | null> {
    // An exited/created (non-running) runner serves nothing — reclaim it and its anon
    // volume regardless of task status (a retry cold-boots a fresh one).
    if (!c.running) return 'exited';
    // A running runner with no task label can't belong to a live task's runtime.
    if (!c.taskId) return 'orphan';
    let task: { status: string } | undefined;
    try {
      task = await this.db.query.tasks.findFirst({
        where: eq(schema.tasks.id, c.taskId),
        columns: { status: true },
      });
    } catch (err) {
      log.warn({ err, taskId: c.taskId }, 'runtime reaper task lookup failed; keeping runner');
      return null;
    }
    if (!task) return 'orphan'; // task row gone — the runner is a leftover
    if (TERMINAL_STATUSES.has(task.status)) return 'terminal';
    if (task.status === 'failed') {
      if (failedGraceMs <= 0) return null; // grace disabled — keep for manual retry
      if (c.startedAtMs != null && Date.now() - c.startedAtMs >= failedGraceMs) {
        return 'failed-grace';
      }
      return null;
    }
    // running / paused / waiting_* / created / queued — in use, keep.
    return null;
  }

  private async listRunnerContainers(): Promise<RunnerContainer[]> {
    const [ddev, app] = await Promise.all([this.psIds('haive.ddev'), this.psIds(APP_RUNNER_LABEL)]);
    const ids = Array.from(new Set([...ddev, ...app]));
    const infos = await Promise.all(ids.map((id) => this.inspect(id)));
    return infos.filter((i): i is RunnerContainer => i !== null);
  }

  private psIds(label: string): Promise<string[]> {
    return exec('docker', ['ps', '-aq', '--filter', `label=${label}`], { timeout: 10_000 })
      .then(({ stdout }) => stdout.split(/\s+/).filter((s) => s.length > 0))
      .catch(() => []);
  }

  private async inspect(id: string): Promise<RunnerContainer | null> {
    try {
      const { stdout } = await exec(
        'docker',
        [
          'inspect',
          '-f',
          '{{.State.Running}}|{{.State.StartedAt}}|{{index .Config.Labels "haive.task.id"}}',
          id,
        ],
        { timeout: 8_000 },
      );
      const [running, startedAt, taskId] = stdout.trim().split('|');
      const ms = Date.parse(startedAt ?? '');
      return {
        id,
        running: running === 'true',
        startedAtMs: Number.isNaN(ms) ? null : ms,
        taskId: taskId && taskId !== '<no value>' ? taskId : null,
      };
    } catch {
      return null;
    }
  }

  private async reap(id: string): Promise<void> {
    // -v drops the runner's anon /var/lib/docker volume (1-2 GB of nested DDEV images).
    await exec('docker', ['rm', '-f', '-v', id], { timeout: 60_000 }).catch((err) => {
      log.warn(
        { id, err: err instanceof Error ? err.message : String(err) },
        'runtime reap rm failed',
      );
    });
  }
}
