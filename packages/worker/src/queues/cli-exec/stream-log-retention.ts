import { and, inArray, isNotNull, lt, ne, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CONFIG_KEYS,
  DEFAULT_CLI_PROMPT_RETENTION_DAYS,
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
 *  A terminal task with a NULL completed_at is never swept. Every task-level terminal write
 *  stamps an exit time, so this should not arise — but a row that reads terminal while
 *  carrying none has no clock to age from, and falling back to created_at or updated_at would
 *  age it off something unrelated to the work. Not aging it loses disk, not history. */
export function expiredStreamLogFilter(db: Database, cutoff: Date): SQL | undefined {
  // stream_log NOT NULL makes a repeat sweep a no-op rather than a rewrite of rows it
  // already cleared.
  return agedInvocationFilter(db, cutoff, isNotNull(schema.cliInvocations.streamLog));
}

/** The same gate for `prompt`, which is NOT NULL — so the sweep blanks it to '' and the
 *  self-narrowing guard is `<> ''` rather than an IS NOT NULL. Its only reader
 *  (step-runner's mining-retry recovery for wave agents) already skips a falsy prompt,
 *  so a blanked row means "this agent cannot be re-dispatched", never "dispatch nothing".
 *
 *  Its own function rather than a column parameter on one filter: the two guards are the
 *  only difference, and a single filter taking a column would let a caller pair the
 *  stream-log window with the prompt column by accident. */
export function expiredPromptFilter(db: Database, cutoff: Date): SQL | undefined {
  return agedInvocationFilter(db, cutoff, ne(schema.cliInvocations.prompt, ''));
}

/** The task-exit gate both sweeps share, parameterised only by the guard that makes a
 *  repeat pass a no-op. `unswept` is required, not optional: `and()` over an undefined
 *  term still returns a filter, so a missing guard would rewrite every row it had already
 *  cleared on every hourly tick. */
function agedInvocationFilter(db: Database, cutoff: Date, unswept: SQL): SQL | undefined {
  return and(
    isNotNull(schema.cliInvocations.endedAt),
    lt(schema.cliInvocations.endedAt, cutoff),
    unswept,
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

/** Periodic sweep that drops the two large text columns on `cli_invocations` once an
 *  invocation is older than their configured retention window: `stream_log` — the full CLI
 *  transcript behind the terminal's Raw tab — and `prompt`.
 *
 *  TWO windows, not one, and they are deliberately independent. Sharing a number would mean
 *  "keep transcripts 30 days" silently also stood down wave-agent retry recovery, which is a
 *  different consequence for a different reader. Each defaults to 0 (keep forever).
 *
 *  `raw_output` is NOT swept and must not be added here: `clean-output.ts` reasons that
 *  emptying it "loses nothing" precisely BECAUSE stream_log survives, and the replay endpoint
 *  falls back to it when stream_log is gone. Evicting both would empty the Raw tab outright,
 *  and unlike the other two it is read all over the step engine. It is also the smallest of
 *  the three by an order of magnitude (measured here: 7.7 MB against 255 and 168).
 *
 *  Nothing else in the system ever deletes it. There is no task-delete route, so the
 *  column only accrues: measured on a working instance at ~250 MB/day, 2.4 GB across
 *  5.8k rows, two thirds of it in the 256 KB - 4 MB range (so capping per-row size
 *  alone does not reclaim it — the long tail dominates).
 *
 *  Only the text goes. The row keeps its parsed output, token usage, cost, model identity
 *  and timings — everything the task pages, cost telemetry, task-time estimation and the
 *  statistics endpoints read, which is why a swept row still counts in every aggregate.
 *  The replay endpoint already falls back to rawOutput when stream_log is null, so a swept
 *  invocation degrades to its parsed result rather than breaking.
 *
 *  What a swept PROMPT costs, stated plainly because it is the one behaviour change: a task
 *  that is terminal past the window and is later revived (retry / allowance auto-resume)
 *  cannot re-dispatch the wave agents of its pre-eviction invocations. Reviving clears
 *  completed_at, so the task drops out of the sweep from then on — but rows already blanked
 *  stay blanked.
 *
 *  The window is measured from the TASK's exit, not the invocation's — see
 *  `expiredStreamLogFilter` for why, and for what a task with no exit time does.
 *
 *  retentionDays <= 0 keeps the column forever, and that is the default for both: the sweep
 *  cannot be undone, so it stays opt-in. The admin card shows what each column currently
 *  occupies, which is what makes that choice an informed one rather than a guess.
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

  /** Single sweep pass. Exposed for tests so they can drive it deterministically.
   *
   *  The two columns are swept independently, each against its own window, and a failure in
   *  one must not skip the other — so they run in sequence and both results are returned
   *  even when one window is off. */
  async sweep(): Promise<{ purged: number; promptsPurged: number }> {
    const [logDays, promptDays] = await Promise.all([
      configService.getNumber(
        CONFIG_KEYS.CLI_STREAM_LOG_RETENTION_DAYS,
        DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS,
      ),
      configService.getNumber(
        CONFIG_KEYS.CLI_PROMPT_RETENTION_DAYS,
        DEFAULT_CLI_PROMPT_RETENTION_DAYS,
      ),
    ]);

    const purged = await this.sweepStreamLogs(logDays);
    const promptsPurged = await this.sweepPrompts(promptDays);
    return { purged, promptsPurged };
  }

  private async sweepStreamLogs(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .update(schema.cliInvocations)
      .set({ streamLog: null })
      .where(expiredStreamLogFilter(this.db, cutoff))
      .returning({ id: schema.cliInvocations.id });

    if (rows.length > 0) {
      log.info({ purged: rows.length, retentionDays: days }, 'purged expired CLI stream logs');
    }
    return rows.length;
  }

  /** Blanked to '' rather than NULL — the column is NOT NULL, so this needs no schema
   *  change, and the one reader already treats a falsy prompt as "no prior run to repeat". */
  private async sweepPrompts(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .update(schema.cliInvocations)
      .set({ prompt: '' })
      .where(expiredPromptFilter(this.db, cutoff))
      .returning({ id: schema.cliInvocations.id });

    if (rows.length > 0) {
      log.info({ purged: rows.length, retentionDays: days }, 'purged expired CLI prompts');
    }
    return rows.length;
  }
}
