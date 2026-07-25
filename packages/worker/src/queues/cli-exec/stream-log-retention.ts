import { and, isNotNull, lt } from 'drizzle-orm';
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

export interface CliStreamLogReaperOptions {
  db: Database;
  intervalMs?: number;
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
    // ended_at NOT NULL keeps a live invocation's transcript out of reach; stream_log
    // NOT NULL makes a repeat sweep a no-op rather than a rewrite of rows it cleared.
    const rows = await this.db
      .update(schema.cliInvocations)
      .set({ streamLog: null })
      .where(
        and(
          isNotNull(schema.cliInvocations.endedAt),
          lt(schema.cliInvocations.endedAt, cutoff),
          isNotNull(schema.cliInvocations.streamLog),
        ),
      )
      .returning({ id: schema.cliInvocations.id });

    if (rows.length > 0) {
      log.info({ purged: rows.length, retentionDays: days }, 'purged expired CLI stream logs');
    }
    return { purged: rows.length };
  }
}
