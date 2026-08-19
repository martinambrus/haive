import type { Job, JobType } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CLI_EXEC_JOB_NAMES, logger, type CliExecJobPayload } from '@haive/shared';
import { fairPriority } from '@haive/shared/fair-priority';
import { getCliExecQueue } from './_shared.js';

/**
 * Rank decay for queued cli-exec jobs.
 *
 * `enqueueCliInvocation` prices a job as `band = VOTE_BASE + rank - score`, where `rank` is the
 * task's in-flight agent count AT THAT MOMENT, and BullMQ then freezes the number at
 * `queue.add`. Rank is the round-robin term — a task's Nth pending agent shares a band with
 * every other task's Nth — and freezing it is correct only while the count holds. It does not.
 *
 * MEASURED on the dev host: `onboard_glm_53_max` (vote +1, ZERO agents in flight) had a job
 * queued at priority 9012, i.e. band 9, i.e. rank 5 — the load it carried during its `09_5`
 * mining fan-out, long since drained. A neutral `Add DDEV` task with TWO agents running had a
 * job at 6007 (band 6, rank 1) because it happened to enqueue later, and sat at the head of the
 * queue ahead of every upvoted job. The upvoted, idle task lost to the neutral, busy one purely
 * on when each job was enqueued. A vote moves at most 5 bands; a 5-wide fan-out moves 4, and
 * never gives them back, so the vote could not win.
 *
 * The fix is not to drop rank — round-robin is what stops one task's fan-out eating the pool —
 * but to make it LIVE. For a task with `r` started agents and `k` queued jobs in their current
 * order, the ranks are `r+1 .. r+k`: exactly what an incremental enqueue would have produced
 * right now. A drained fan-out therefore decays back to rank 1 instead of serving a life
 * sentence, and the relative order inside a task never changes.
 *
 * A sweeper rather than a hook on invocation-end: the count also drops on paths that never run
 * that code — a worker restart's orphan sweep, a preemption, a cancel — and a periodic
 * recompute is idempotent, so a missed tick costs latency and nothing else.
 *
 * Rides `FAIR_SCHEDULING_ENABLED` with no switch of its own: with fair scheduling off, jobs are
 * enqueued without a priority, `job.priority` is 0, and every one of them is skipped below.
 */

const log = logger.child({ module: 'cli-priority-decay' });

/** Matches `repriceTaskCliJobs` (api): a vote and a decay must reach the same three states, or
 *  a job parked by a pickup gate keeps a stale band until it promotes. */
export const DECAY_STATES: readonly JobType[] = ['waiting', 'prioritized', 'delayed'];

/** Deep enough for any realistic queue; a deeper scan cannot change the outcome, only its cost. */
const SCAN_LIMIT = 1000;

/** Matched to the other sweepers. The thing being waited on is a slot freeing, which happens on
 *  the scale of minutes, so a tighter loop would only add queue writes. */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/** One queued cli-exec job as the rule sees it. */
export interface QueuedJobView {
  jobId: string;
  taskId: string;
  /** LIVE priority — `job.priority`, never `job.opts.priority`, which changePriority never
   *  rewrites. 0 (or NaN on a pre-field hash) means the job was enqueued with fair scheduling
   *  off: it lives in `waiting` and is deliberately unordered, so it is never touched. */
  priority: number;
}

/** Live per-task inputs the band is rebuilt from. */
export interface TaskLoad {
  /** Agents this task has already STARTED — the base the queue positions count up from.
   *  Started-only on purpose: the queued rows are the very jobs being priced here, so counting
   *  them again would price each job as if the whole backlog were already running. */
  runningCount: number;
  /** This USER's in-flight invocations across all their tasks: the within-band tiebreak, which
   *  drifts for exactly the same reason rank does. */
  userTiebreak: number;
  voteScore: number;
}

export interface Reprice {
  jobId: string;
  taskId: string;
  from: number;
  to: number;
}

/** Numeric-aware order for BullMQ's string job ids, so "9" sorts before "10". Falls back to a
 *  string compare for any id that is not numeric. */
function byJobId(a: QueuedJobView, b: QueuedJobView): number {
  const na = Number(a.jobId);
  const nb = Number(b.jobId);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
}

/**
 * The jobs whose band no longer matches the live load, and what it should be.
 *
 * Pure, so the rule is testable without a queue or a database — the same split as
 * `agentReserveDecision` / `preemptionDecision` / `reapDecision`.
 *
 * Returns ONLY actual changes: a settled queue produces an empty list and therefore zero writes,
 * which is what makes running this every 30s free.
 */
export function decayedPriorities(
  queued: readonly QueuedJobView[],
  loads: ReadonlyMap<string, TaskLoad>,
): Reprice[] {
  const byTask = new Map<string, QueuedJobView[]>();
  for (const j of queued) {
    if (!j.priority) continue; // FIFO job — see QueuedJobView.priority
    if (!loads.has(j.taskId)) continue; // task not resolvable: leave it exactly as it is
    const list = byTask.get(j.taskId);
    if (list) list.push(j);
    else byTask.set(j.taskId, [j]);
  }

  const out: Reprice[] = [];
  for (const [taskId, jobs] of byTask) {
    const load = loads.get(taskId)!;
    // Current queue order, kept: this rule re-prices a task's backlog, it never reshuffles it.
    // Priority first (that IS the order BullMQ will serve them in), job id to break a tie
    // deterministically so a sweep cannot oscillate between two equal-priority jobs.
    jobs.sort((a, b) => a.priority - b.priority || byJobId(a, b));
    jobs.forEach((job, i) => {
      const to = fairPriority({
        rank: load.runningCount + i + 1,
        tiebreak: load.userTiebreak,
        score: load.voteScore,
      });
      if (to !== job.priority) out.push({ jobId: job.jobId, taskId, from: job.priority, to });
    });
  }
  return out;
}

export interface CliPriorityDecaySweeperOptions {
  db: Database;
  intervalMs?: number;
}

/** Periodically rebuilds queued cli-exec priorities from live load. See the module comment. */
export class CliPriorityDecaySweeper {
  private readonly db: Database;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(opts: CliPriorityDecaySweeperOptions) {
    this.db = opts.db;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.sweep()
        .catch((err) => log.warn({ err }, 'cli priority decay sweep failed'))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info({ intervalMs: this.intervalMs }, 'cli priority decay sweeper started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Single pass. Exposed so tests and a live check can drive it deterministically. */
  async sweep(): Promise<{ repriced: number }> {
    const jobs = (await getCliExecQueue().getJobs(
      [...DECAY_STATES],
      0,
      SCAN_LIMIT - 1,
    )) as Job<CliExecJobPayload>[];

    const handles = new Map<string, Job<CliExecJobPayload>>();
    const views: QueuedJobView[] = [];
    for (const job of jobs) {
      if (job.name !== CLI_EXEC_JOB_NAMES.INVOKE) continue;
      const taskId = job.data?.taskId;
      const jobId = job.id;
      if (!taskId || !jobId) continue;
      handles.set(jobId, job);
      views.push({ jobId, taskId, priority: job.priority });
    }
    if (views.length === 0) return { repriced: 0 };

    const loads = await this.loads([...new Set(views.map((v) => v.taskId))]);
    const changes = decayedPriorities(views, loads);
    if (changes.length === 0) return { repriced: 0 };

    let repriced = 0;
    for (const change of changes) {
      try {
        await handles.get(change.jobId)?.changePriority({ priority: change.to });
        repriced++;
      } catch (err) {
        // A job that started, finished or was removed mid-sweep simply misses this pass. The
        // next one recomputes from scratch, so a miss costs latency and never correctness.
        log.debug({ err, jobId: change.jobId }, 'decay reprice skipped');
      }
    }
    log.info({ repriced, considered: views.length }, 'cli priority decay repriced queued jobs');
    return { repriced };
  }

  /** Live load for the tasks that have something queued. */
  private async loads(taskIds: string[]): Promise<Map<string, TaskLoad>> {
    const [tasks, running] = await Promise.all([
      this.db
        .select({
          id: schema.tasks.id,
          userId: schema.tasks.userId,
          voteScore: schema.tasks.voteScore,
        })
        .from(schema.tasks)
        .where(inArray(schema.tasks.id, taskIds)),
      this.db
        .select({
          taskId: schema.cliInvocations.taskId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.cliInvocations)
        .where(
          and(
            inArray(schema.cliInvocations.taskId, taskIds),
            isNotNull(schema.cliInvocations.startedAt),
            isNull(schema.cliInvocations.endedAt),
            isNull(schema.cliInvocations.supersededAt),
          ),
        )
        .groupBy(schema.cliInvocations.taskId),
    ]);

    const userIds = [...new Set(tasks.map((t) => t.userId))];
    // Same definition as cliBacklogCounts' user term: EVERY in-flight invocation of that user,
    // queued ones included. Only the task-level rank counts started-only, and only because the
    // queued rows there are the jobs being priced.
    const perUser = userIds.length
      ? await this.db
          .select({ userId: schema.tasks.userId, n: sql<number>`count(*)::int` })
          .from(schema.cliInvocations)
          .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
          .where(
            and(
              inArray(schema.tasks.userId, userIds),
              isNull(schema.cliInvocations.endedAt),
              isNull(schema.cliInvocations.supersededAt),
            ),
          )
          .groupBy(schema.tasks.userId)
      : [];

    const runningByTask = new Map(running.map((r) => [r.taskId, r.n]));
    const backlogByUser = new Map(perUser.map((r) => [r.userId, r.n]));
    const out = new Map<string, TaskLoad>();
    for (const t of tasks) {
      out.set(t.id, {
        runningCount: runningByTask.get(t.id) ?? 0,
        userTiebreak: backlogByUser.get(t.userId) ?? 0,
        voteScore: t.voteScore,
      });
    }
    return out;
  }
}
