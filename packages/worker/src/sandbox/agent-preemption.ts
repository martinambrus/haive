import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  CONFIG_KEYS,
  configService,
  logger,
  type CliExecJobPayload,
} from '@haive/shared';
import { getCliExecQueue } from '../queues/cli-exec/_shared.js';
import { countWaitingHolderJobs, QUEUED_STATES } from '../queues/cli-exec/agent-reserve.js';
import { markPreempted } from '../queues/cli-exec/preempt-mark.js';
import { runnerHoldingTaskIds } from './runtime-admission.js';

const exec = promisify(execFile);
const log = logger.child({ module: 'agent-preemption' });

/** Sweep interval. A boosted task waits at most this long past the guard before it takes a slot.
 *  Matched to the reaper's cadence rather than something tighter: preemption destroys work, so
 *  reacting a few seconds later is strictly cheaper than reacting a few seconds too eagerly. */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/** Deep enough to see every task with queued demand on a real queue. */
const QUEUE_SCAN_LIMIT = 200;

/** A task that currently occupies an agent slot. */
export interface RunningAgent {
  invocationId: string;
  taskId: string;
  voteScore: number;
  startedAtMs: number;
}

export interface PreemptionInput {
  enabled: boolean;
  /** Vote scores of tasks with cli-exec work QUEUED (waiting/prioritized), i.e. real demand. */
  queuedScores: readonly number[];
  running: readonly RunningAgent[];
  minRunAgeMs: number;
  nowMs: number;
}

/** Pure pick of ONE running agent to evict, or null. Split from the queue/docker/db I/O so the
 *  rule is directly testable — same split as `agentReserveDecision` and `pickPreemptibleRunner`.
 *
 *  Rules, in order:
 *   - the switch is off, nothing is queued, or nothing is running -> no eviction
 *   - a victim must be outscored STRICTLY. Equal scores are first-come, which is what stops a
 *     fleet of equally-voted tasks from evicting each other in circles
 *   - a victim must have been running at least `minRunAgeMs`, so a just-restarted run cannot be
 *     killed again before it achieves anything
 *   - among eligible victims: LOWEST score first, then the YOUNGEST run. Youngest is deliberate —
 *     every eviction destroys the work done so far, so the cheapest victim is the one that has
 *     done the least. (The reaper picks oldest-first for the opposite reason: there it is picking
 *     the most-dead thing, not the least-costly one.) */
export function preemptionDecision(input: PreemptionInput): RunningAgent | null {
  if (!input.enabled) return null;
  if (input.queuedScores.length === 0 || input.running.length === 0) return null;
  const bestQueued = Math.max(...input.queuedScores);
  const eligible = input.running.filter(
    (r) =>
      r.voteScore < bestQueued && input.nowMs - r.startedAtMs >= Math.max(0, input.minRunAgeMs),
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, r) => {
    if (r.voteScore !== best.voteScore) return r.voteScore < best.voteScore ? r : best;
    return r.startedAtMs > best.startedAtMs ? r : best;
  });
}

export interface AgentPreemptionSweeperOptions {
  db: Database;
  intervalMs?: number;
}

/**
 * Evicts one running CLI agent per pass when a higher-voted task has queued work and cannot get a
 * slot.
 *
 * Vote scoring alone only orders the QUEUE, so a boosted task still waited behind whatever
 * happened to be enqueued first — observed live: a +2 task held the queue's lowest priority number
 * and could not run because both slots were taken first-come. This is the only mechanism that
 * changes that, because BullMQ priority cannot move a job that has already started.
 *
 * Deliberately NOT a gate at job pickup: a pickup gate only runs when a slot is already free,
 * which is exactly the case that needs no help. It has to be a sweep.
 *
 * Environments are never touched — only `haive-cli-*` agent containers. A preempted step
 * re-dispatches through the existing transient-recovery path and, thanks to
 * `isCliPreemptionFailure`, spends none of its retry budgets doing so.
 */
export class AgentPreemptionSweeper {
  private readonly db: Database;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(opts: AgentPreemptionSweeperOptions) {
    this.db = opts.db;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.sweep()
        .catch((err) => log.warn({ err }, 'agent preemption sweep failed'))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info({ intervalMs: this.intervalMs }, 'agent preemption sweeper started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Single pass. Exposed so tests (and a live check) can drive it deterministically. */
  async sweep(): Promise<{ preempted: string | null }> {
    const [enabled, minRunMinutes] = await Promise.all([
      configService.getBoolean(CONFIG_KEYS.AGENT_PREEMPTION_ENABLED, true),
      configService.getNumber(CONFIG_KEYS.AGENT_PREEMPTION_MIN_RUN_MINUTES, 5),
    ]);
    if (!enabled) return { preempted: null };

    const queuedTaskIds = await this.queuedTaskIds();
    if (queuedTaskIds.size === 0) return { preempted: null };

    const running = await this.runningAgents();
    if (running.length === 0) return { preempted: null };

    const scores = await this.voteScores([...queuedTaskIds]);
    const victim = preemptionDecision({
      enabled,
      queuedScores: [...queuedTaskIds].map((id) => scores.get(id) ?? 0),
      running,
      minRunAgeMs: Math.max(0, minRunMinutes) * 60_000,
      nowMs: Date.now(),
    });
    if (!victim) return { preempted: null };

    // Would the freed slot actually reach a booster? The runtime-holder reserve defers a
    // runner-less task's job at pickup, so evicting for one would destroy work and hand the slot
    // to somebody else entirely. Only the boosters that outscore this victim matter.
    if (!(await this.aBoosterCanRun(queuedTaskIds, scores, victim.voteScore))) {
      log.debug(
        { victim: victim.invocationId },
        'preemption skipped: every higher-voted task would be deferred by the runtime reserve',
      );
      return { preempted: null };
    }

    await markPreempted(victim.invocationId);
    const killed = await this.killAgentContainer(victim.invocationId);
    if (!killed) {
      log.warn(
        { invocationId: victim.invocationId, taskId: victim.taskId },
        'preemption found no container to kill; leaving the run alone',
      );
      return { preempted: null };
    }
    await this.recordEvent(victim);
    log.info(
      {
        invocationId: victim.invocationId,
        taskId: victim.taskId,
        victimScore: victim.voteScore,
        ranForMs: Date.now() - victim.startedAtMs,
      },
      'preempted a running agent for a higher-voted task',
    );
    return { preempted: victim.invocationId };
  }

  /** Tasks with cli-exec work sitting in the queue. Both queued states, per QUEUED_STATES —
   *  scanning `waiting` alone finds nothing on a fair-scheduled queue. `delayed` is excluded on
   *  purpose: those jobs are parked by a gate (pause / per-task cap / runtime reserve), so they
   *  are not demand that a freed slot could satisfy. */
  private async queuedTaskIds(): Promise<Set<string>> {
    const jobs = await getCliExecQueue().getJobs([...QUEUED_STATES], 0, QUEUE_SCAN_LIMIT - 1);
    const ids = new Set<string>();
    for (const j of jobs) {
      if (j.name !== CLI_EXEC_JOB_NAMES.INVOKE) continue;
      const taskId = (j.data as CliExecJobPayload | undefined)?.taskId;
      if (taskId) ids.add(taskId);
    }
    return ids;
  }

  /** Agents currently occupying a slot, with their task's vote score and how long they have run. */
  private async runningAgents(): Promise<RunningAgent[]> {
    const rows = await this.db
      .select({
        invocationId: schema.cliInvocations.id,
        taskId: schema.cliInvocations.taskId,
        startedAt: schema.cliInvocations.startedAt,
        voteScore: schema.tasks.voteScore,
      })
      .from(schema.cliInvocations)
      .innerJoin(schema.tasks, eq(schema.cliInvocations.taskId, schema.tasks.id))
      .where(
        and(
          isNotNull(schema.cliInvocations.startedAt),
          isNull(schema.cliInvocations.endedAt),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
    return rows
      .filter((r) => r.startedAt !== null)
      .map((r) => ({
        invocationId: r.invocationId,
        taskId: r.taskId,
        voteScore: r.voteScore,
        startedAtMs: r.startedAt!.getTime(),
      }));
  }

  private async voteScores(taskIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (taskIds.length === 0) return out;
    const rows = await this.db
      .select({ id: schema.tasks.id, voteScore: schema.tasks.voteScore })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, taskIds));
    for (const r of rows) out.set(r.id, r.voteScore);
    return out;
  }

  /** True when at least one task that outscores the victim would actually be allowed to start.
   *  A task holding a live runner always can; a runner-less one only when no holder has queued
   *  demand (the runtime-holder reserve's rule, read from the same source of truth). */
  private async aBoosterCanRun(
    queuedTaskIds: ReadonlySet<string>,
    scores: ReadonlyMap<string, number>,
    victimScore: number,
  ): Promise<boolean> {
    const boosters = [...queuedTaskIds].filter((id) => (scores.get(id) ?? 0) > victimScore);
    if (boosters.length === 0) return false;
    let holders: ReadonlySet<string>;
    try {
      holders = await runnerHoldingTaskIds();
    } catch (err) {
      // Cannot read the pool — assume the booster can run rather than blocking preemption on a
      // docker hiccup. The eviction is still bounded by every other guard.
      log.warn({ err }, 'runner-holder lookup failed; assuming the booster can take the slot');
      return true;
    }
    if (holders.size === 0) return true; // the reserve never fires with no holders
    if (boosters.some((id) => holders.has(id))) return true;
    // Every booster is runner-less. It can only run if no holder has queued demand.
    const holderDemand = await countWaitingHolderJobs(getCliExecQueue(), holders);
    return holderDemand === 0;
  }

  /** Force-remove the ONE container running this invocation. Keyed on the `haive.invocation.id`
   *  label rather than the task label, so a task's other agents keep running — preemption frees
   *  exactly one slot. Returns false when nothing matched (the run finished on its own in the
   *  gap since we listed), which is why the caller does not record an eviction. */
  private async killAgentContainer(invocationId: string): Promise<boolean> {
    const { stdout } = await exec('docker', [
      'ps',
      '-q',
      '--filter',
      `label=haive.invocation.id=${invocationId}`,
    ]);
    const ids = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return false;
    await exec('docker', ['rm', '-f', ...ids]);
    return true;
  }

  /** Audit trail, so an eviction reads as a decision rather than a random CLI death. */
  private async recordEvent(victim: RunningAgent): Promise<void> {
    try {
      await this.db.insert(schema.taskEvents).values({
        taskId: victim.taskId,
        taskStepId: null,
        eventType: 'task.agent_preempted',
        payload: {
          invocationId: victim.invocationId,
          voteScore: victim.voteScore,
          ranForMs: Date.now() - victim.startedAtMs,
        },
      });
    } catch (err) {
      log.warn({ err, taskId: victim.taskId }, 'preemption event write failed');
    }
  }
}
