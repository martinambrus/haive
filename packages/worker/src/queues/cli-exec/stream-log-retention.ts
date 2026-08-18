import { and, inArray, isNotNull, lt, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CONFIG_KEYS,
  DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS,
  configService,
  logger,
} from '@haive/shared';

const log = logger.child({ module: 'cli-stream-log-reaper' });

/** Sweep interval. The window is measured in days, so hourly is ample — it only needs
 *  to be short enough that lowering the setting takes effect the same session. */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** A transcript ages from its TASK's exit, so the sweep only ever reaches a task that has
 *  one. Same set the env-template reaper treats as exited. `failed` is included even though
 *  it is revivable: a retry or an allowance auto-resume clears completed_at (task-queue.ts),
 *  which drops the task back out of the sweep on its own. */
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export interface CliStreamLogReaperOptions {
  db: Database;
  intervalMs?: number;
}

/** The rows whose transcript may be dropped for `cutoff`. Exported so the unit test can
 *  render it without a database.
 *
 *  BOTH clocks have to be past the cutoff, and neither is redundant:
 *
 *  - The invocation's `ended_at` keeps a LIVE invocation out of reach, and is still needed
 *    once the task gate exists because 96 invocations on this instance ended AFTER their
 *    task's completed_at (max +57m): cancel stamps the task terminal immediately while
 *    in-flight sandboxes drain behind it.
 *  - The task's `completed_at` is what makes the window mean "since the work finished".
 *    Keying on the invocation alone evicted a STILL-RUNNING task's early rounds: a task
 *    parked on a form, a PR wait or a rate-limit hold outlives any day-scale window
 *    (measured here: 28d between one task's first and last invocation, p95 12d for
 *    completed tasks), and the later rounds are diagnosed against those transcripts. It
 *    costs almost no reclaim — 99.6% of ended invocations holding a transcript belong to
 *    a task that has already exited.
 *
 *  A terminal task with a NULL completed_at is never swept. That is deliberate rather than
 *  incidental: the Stop path (api tasks route) sets status=failed without stamping an exit
 *  time, and aging such a row off some other clock would be a guess. Not aging it loses
 *  disk, not history. */
export function expiredStreamLogFilter(db: Database, cutoff: Date): SQL | undefined {
  return and(
    // stream_log NOT NULL makes a repeat sweep a no-op rather than a rewrite of rows it
    // already cleared.
    isNotNull(schema.cliInvocations.endedAt),
    lt(schema.cliInvocations.endedAt, cutoff),
    isNotNull(schema.cliInvocations.streamLog),
    inArray(
      schema.cliInvocations.taskId,
      db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(
          and(
            inArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES]),
            isNotNull(schema.tasks.completedAt),
            lt(schema.tasks.completedAt, cutoff),
          ),
        ),
    ),
  );
}

/** Periodic sweep that drops `cli_invocations.stream_log` — the full CLI transcript
 *  behind the terminal's Raw tab — once an invocation is older than the configured
 *  retention window.
 *
 *  Nothing else in the system ever deletes it. There is no task-delete route, so the
 *  column only accrues: measured on a working instance at ~250 MB/day, 2.4 GB across
 *  5.8k rows, two thirds of it in the 256 KB - 4 MB range (so capping per-row size
 *  alone does not reclaim it — the long tail dominates).
 *
 *  Only the transcript goes. The row keeps its parsed output, token usage and timings,
 *  which task-time estimation and cost telemetry read. The replay endpoint already
 *  falls back to rawOutput when stream_log is null, so a swept invocation degrades to
 *  its parsed result rather than breaking.
 *
 *  The window is measured from the TASK's exit, not the invocation's — see
 *  `expiredStreamLogFilter` for why, and for what a task with no exit time does.
 *
 *  retentionDays <= 0 keeps transcripts forever, and that is the default: nulling the
 *  column cannot be undone, so the sweep stays opt-in.
 */
export class CliStreamLogReaper {
  private readonly db: Database;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(opts: CliStreamLogReaperOptions) {
    this.db = opts.db;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    // Sweep once on boot too: a dev stack that restarts more often than the interval
    // would otherwise never reach a sweep.
    this.tick();
    log.info({ intervalMs: this.intervalMs }, 'cli stream-log reaper started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    this.sweep()
      .catch((err) => log.warn({ err }, 'cli stream-log sweep failed'))
      .finally(() => {
        this.inFlight = false;
      });
  }

  /** Single sweep pass. Exposed for tests so they can drive it deterministically. */
  async sweep(): Promise<{ purged: number }> {
    const days = await configService.getNumber(
      CONFIG_KEYS.CLI_STREAM_LOG_RETENTION_DAYS,
      DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS,
    );
    if (!Number.isFinite(days) || days <= 0) return { purged: 0 };

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .update(schema.cliInvocations)
      .set({ streamLog: null })
      .where(expiredStreamLogFilter(this.db, cutoff))
      .returning({ id: schema.cliInvocations.id });

    if (rows.length > 0) {
      log.info({ purged: rows.length, retentionDays: days }, 'purged expired CLI stream logs');
    }
    return { purged: rows.length };
  }
}
