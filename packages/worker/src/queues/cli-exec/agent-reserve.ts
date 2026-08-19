import { DelayedError, type Job, type JobType } from 'bullmq';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  CONFIG_KEYS,
  configService,
  type CliExecJobPayload,
} from '@haive/shared';
import { getRedis } from '../../redis.js';
import { runnerHoldingTaskIds } from '../../sandbox/runtime-admission.js';
import { resourceLimitsEnabled } from '../../sandbox/runtime-caps.js';
import { getCliExecQueue, log, type CliExecQueuePayload } from './_shared.js';

/**
 * Runtime-holder reserve: a task that holds NO live runtime runner yields its cli-exec slot to
 * one that does.
 *
 * The agent pool is already sized from what the runtime pool leaves free (deriveAgentConcurrency),
 * so a host running DDEV runners has very few agent slots — on a 16 GB box with three runners up it
 * is the agentFloor, 2. Nothing made those slots runtime-aware, so a runner-less task (onboarding,
 * or a workflow task before its environment boots) competed FIFO with a task sitting on gigabytes
 * of primed DDEV. Observed: three tasks each holding a 3072 MB runner, two of them idle, while an
 * onboarding task held one of the two slots. Those runners can only be released by their tasks
 * FINISHING, and finishing needs an agent — so the runner-less job was not merely first in line,
 * it was holding the machine's committed RAM hostage, which also kept four more tasks parked at
 * the runtime gate behind capacity that could not free.
 *
 * The asymmetry this closes: a runner-less task's slot is fungible, a runner-holder's is not. Its
 * idle time is billed in RAM.
 *
 * Enforced at job PICKUP, as a third sibling to enforcePauseGate and enforceTaskAgentCap and by the
 * same mechanism (moveToDelayed + DelayedError, fail-open on everything). Pickup rather than
 * enqueue priority because BullMQ freezes priority at `queue.add` while runner-holding is state
 * that changes: a task that owned no runner when its job was queued may own one by the time the
 * job runs, and the reverse. The fair-scheduling composite priority is untouched — it orders
 * across tasks, this decides yield-or-run against the state right now.
 *
 * NOT preemption: an already-running agent keeps its slot to completion.
 */

/** Task ids are read from docker labels, never from `tasks.type`. "Holds a live runtime runner" is
 *  the invariant that makes a slot non-fungible; "is an onboarding task" is today's instance of it.
 *  Keying on the invariant means a future runner-less task type inherits this with no code change. */
export interface AgentReserveInput {
  /** Reserve switched on AND the governor enabled. Off = pre-feature first-come behavior. */
  enabled: boolean;
  /** Tasks holding a live runtime runner right now. Zero means there is nothing to protect. */
  holderCount: number;
  /** Whether THIS job's task is one of them — a holder is never gated. */
  holdsRunner: boolean;
  /** Queued cli-exec jobs belonging to a holder, i.e. work that would start the moment this job
   *  yielded. Counted from BullMQ's queued lists (see QUEUED_STATES) rather than from queued
   *  `cli_invocations` rows, because a DB count also includes invocations whose jobs are delayed
   *  (a paused task, a task over its per-task cap) or not yet enqueued at all — yielding to those
   *  would leave the slot idle with nothing able to take it. */
  waitingHolderJobs: number;
  /** This task's vote score, and the highest score among the runner holders.
   *
   *  A vote is the operator stating outright which task should run first; holding a runner is
   *  this module INFERRING it from committed RAM. The explicit statement wins — but only a
   *  strict one, because equal scores say nothing and there the RAM argument still decides.
   *  Read live at pickup, never carried on the job, for the same reason the whole gate is at
   *  pickup: a vote lands long after `queue.add` froze the job's priority.
   *
   *  Both default to 0, so on an install where nobody has voted this term is inert and the
   *  reserve behaves exactly as it did before it existed. */
  voteScore: number;
  maxHolderVoteScore: number;
  /** How long this invocation has already been held here. */
  heldForMs: number;
  /** Escape hatch: hold no longer than this. Without it a busy runtime fleet starves runner-less
   *  work for as long as it keeps queueing jobs, which is a priority rule turning into a stall.
   *  0 = strict, no escape. */
  maxHoldMs: number;
}

/** Pure decision, split from the docker/redis/db I/O so the rule is directly testable (mirrors
 *  runtimeAdmissionDecision / reapDecision / pickPreemptibleRunner). */
export function agentReserveDecision(input: AgentReserveInput): 'allow' | 'defer' {
  if (!input.enabled) return 'allow';
  if (input.holderCount === 0) return 'allow';
  if (input.holdsRunner) return 'allow';
  // Explicit intent over inferred intent. Strictly greater: a tie is not a statement.
  if (input.voteScore > input.maxHolderVoteScore) return 'allow';
  if (input.waitingHolderJobs === 0) return 'allow';
  if (input.maxHoldMs > 0 && input.heldForMs >= input.maxHoldMs) return 'allow';
  return 'defer';
}

/** How long a yielded job waits before BullMQ redelivers it. Longer than the per-task cap's 4s:
 *  that one waits on a sibling agent finishing seconds from now, this one waits on a holder's job
 *  being picked up, and a deferred job occupies no slot — so the only cost of waiting longer is
 *  latency once the holders drain, and the only cost of waiting less is churn. */
const DEFER_MS = 10_000;

/** Queued jobs scanned when counting holder demand. Any holder job in the queue is enough to
 *  yield for, so this only has to be deep enough to FIND one; a deeper scan cannot change the
 *  decision, only its cost. */
const WAITING_SCAN_LIMIT = 200;

/** BullMQ v5 splits queued jobs across TWO lists: a job enqueued with `opts.priority` goes to
 *  `prioritized`, everything else to `waiting`. cli-exec sets a priority whenever fair scheduling
 *  is on (CONFIG_KEYS.FAIR_SCHEDULING_ENABLED, default true), so scanning `waiting` alone counted
 *  zero on a real queue and this gate would have been a silent no-op — verified live: `waiting`
 *  did not exist while `prioritized` held 21 jobs. Both are listed because fair scheduling is a
 *  kill switch: matching only whichever list today's config happens to fill would break the moment
 *  it is flipped. */
export const QUEUED_STATES: readonly JobType[] = ['waiting', 'prioritized'];

/** First-defer timestamp per invocation, so the escape hatch measures the whole hold rather than
 *  the current 10s slice. Self-expiring, so nothing has to prune it; the TTL only has to outlast a
 *  plausible hold. */
const HOLD_KEY_PREFIX = 'haive:agent-reserve-hold:';
const HOLD_TTL_S = 3600;

function holdKey(invocationId: string): string {
  return `${HOLD_KEY_PREFIX}${invocationId}`;
}

/** Age of this invocation's hold, or 0 when it has never been deferred. Read-only — the clock is
 *  started by markHeld on the first actual defer, so merely evaluating the gate never ages a job. */
async function readHoldAgeMs(invocationId: string, now: number): Promise<number> {
  const raw = await getRedis().get(holdKey(invocationId));
  const first = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(first) ? Math.max(0, now - first) : 0;
}

/** Start the hold clock. NX, so re-defers keep the ORIGINAL timestamp — otherwise every 10s slice
 *  would reset the escape hatch and the hold could never expire. Returns true on the first defer. */
async function markHeld(invocationId: string, now: number): Promise<boolean> {
  const res = await getRedis().set(holdKey(invocationId), String(now), 'EX', HOLD_TTL_S, 'NX');
  return res === 'OK';
}

async function clearHold(invocationId: string): Promise<void> {
  try {
    await getRedis().del(holdKey(invocationId));
  } catch {
    // Soft state: the TTL prunes it anyway, and a stale marker can only make this invocation
    // escape a future hold EARLIER, never hold it longer.
  }
}

/** The slice of the queue the demand count needs. Narrow on purpose: it lets the count be tested
 *  without a live BullMQ connection, so which STATES are scanned is asserted rather than assumed —
 *  the one detail whose silent failure mode is "the gate never fires". A real Queue satisfies it. */
export interface QueuedJobSource {
  getJobs(
    types: JobType[],
    start: number,
    end: number,
  ): Promise<Array<{ name: string; data: unknown }>>;
}

/** Queued cli-exec invocations belonging to a task that holds a runtime runner. */
export async function countWaitingHolderJobs(
  queue: QueuedJobSource,
  holders: ReadonlySet<string>,
): Promise<number> {
  const jobs = await queue.getJobs([...QUEUED_STATES], 0, WAITING_SCAN_LIMIT - 1);
  let n = 0;
  for (const j of jobs) {
    if (j.name !== CLI_EXEC_JOB_NAMES.INVOKE) continue;
    const taskId = (j.data as CliExecJobPayload | undefined)?.taskId;
    if (taskId && holders.has(taskId)) n += 1;
  }
  return n;
}

/** The pool view this gate decides against, memoised for a beat.
 *
 *  A defer frees the slot immediately, so BullMQ hands over the next queued job at once: with a
 *  deep queue of runner-less jobs the worker walks the whole list in one burst, and an un-memoised
 *  gate would run a `docker ps` plus a queue scan PER JOB. Against a live 21-job queue that is
 *  roughly two docker calls a second, where the concurrency poller makes two per THIRTY seconds.
 *  The window is short enough that a decision can only ever be one beat stale, and every mistake it
 *  can make self-corrects on the next 10s slice. */
const CONTEXT_TTL_MS = 2000;
let cachedContext: {
  at: number;
  holders: Set<string>;
  waitingHolderJobs: number;
  maxHolderVoteScore: number;
} | null = null;

/** Highest vote score among the tasks holding a runner. Its own try/catch rather than the
 *  caller's: holder ids come from a docker LABEL, so a single malformed value fails the uuid
 *  cast, and inside reserveContext's catch that would disable the ENTIRE gate rather than this
 *  one term. Falling back to 0 claims only "no holder is boosted", whose worst case is letting
 *  an upvoted runner-less job through. */
async function readMaxHolderVoteScore(db: Database, holders: ReadonlySet<string>): Promise<number> {
  try {
    const [row] = await db
      .select({ max: sql<number | null>`max(${schema.tasks.voteScore})` })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, [...holders]));
    return row?.max ?? 0;
  } catch (err) {
    log.warn({ err }, 'agent reserve: holder vote read failed; treating holders as unvoted');
    return 0;
  }
}

/** This job's task score. One indexed primary-key read per pickup — cheap beside the docker
 *  call the context memo exists to amortise, and it cannot join that memo: it is per job, and a
 *  vote cast a second ago has to count. */
async function readTaskVoteScore(db: Database, taskId: string): Promise<number> {
  const [row] = await db
    .select({ voteScore: schema.tasks.voteScore })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  return row?.voteScore ?? 0;
}

async function reserveContext(
  db: Database,
  now: number,
): Promise<{ holders: Set<string>; waitingHolderJobs: number; maxHolderVoteScore: number }> {
  if (cachedContext && now - cachedContext.at < CONTEXT_TTL_MS) return cachedContext;
  const holders = await runnerHoldingTaskIds();
  const [waitingHolderJobs, maxHolderVoteScore] =
    holders.size === 0
      ? [0, 0]
      : await Promise.all([
          countWaitingHolderJobs(getCliExecQueue(), holders),
          readMaxHolderVoteScore(db, holders),
        ]);
  cachedContext = { at: now, holders, waitingHolderJobs, maxHolderVoteScore };
  return cachedContext;
}

/** Tell the user WHY this run is waiting, on the first defer only — the text does not change
 *  between slices and rewriting it every 10s is pure churn.
 *
 *  Guarded on `started_at IS NULL`, like the queued-status mark in task-queue.ts: this races the
 *  run itself, and an invocation that has already started must never advertise itself as waiting
 *  (packages/web/src/lib/step-banners.ts keys queued-vs-running on startedAt for exactly that
 *  reason). Run-start overwrites the line, so stale copy cannot outlive the wait. */
async function markWaiting(db: Database, invocationId: string, holders: number): Promise<void> {
  await db
    .update(schema.cliInvocations)
    .set({
      statusMessage:
        `Waiting — ${holders} task${holders === 1 ? '' : 's'} with a live environment ` +
        `${holders === 1 ? 'has' : 'have'} priority for the CLI slots. ` +
        `Your run starts automatically.`,
    })
    .where(
      and(eq(schema.cliInvocations.id, invocationId), isNull(schema.cliInvocations.startedAt)),
    );
}

/** Would the reserve let ANY of these tasks take a free slot right now?
 *
 *  The agent-preemption sweeper's question. Evicting a running agent is only worth its cost if
 *  the freed slot actually reaches the task the eviction was for, so the sweeper has to know
 *  what this gate would do. It used to answer that with its own hand-rolled copy of the yield
 *  rule — which was faithful right up until the rule gained the vote term and then silently
 *  went stale, blocking every eviction the vote was supposed to enable. Exactly the drift
 *  `fair-priority.ts` was factored out to prevent: one implementation, two callers.
 *
 *  `heldForMs` is deliberately 0. A candidate already near its escape hatch gets released BY
 *  the hatch a moment later, and destroying a running agent to hurry that along is the trade
 *  this guard exists to refuse — so only the structural allows (and the vote) can answer yes.
 *
 *  Fail-open (true) on any read failure, preserving the sweeper's own previous behaviour: a
 *  docker or config hiccup must not quietly disable preemption. Every other eviction guard —
 *  strict outscoring, the min-run age, one victim per pass — still applies. */
export async function reserveAllowsAnyOf(
  db: Database,
  candidates: ReadonlyArray<{ taskId: string; voteScore: number }>,
): Promise<boolean> {
  if (candidates.length === 0) return false;
  try {
    const [reserve, governor] = await Promise.all([
      configService.getBoolean(CONFIG_KEYS.AGENT_RESERVE_ENABLED, true),
      resourceLimitsEnabled(),
    ]);
    const enabled = reserve && governor;
    // With the reserve off nothing yields, so every candidate can run. The hand-rolled copy
    // never checked the switch and would still have consulted holders here.
    if (!enabled) return true;
    const { holders, waitingHolderJobs, maxHolderVoteScore } = await reserveContext(db, Date.now());
    return candidates.some(
      (c) =>
        agentReserveDecision({
          enabled,
          holderCount: holders.size,
          holdsRunner: holders.has(c.taskId),
          waitingHolderJobs,
          heldForMs: 0,
          maxHoldMs: 0,
          voteScore: c.voteScore,
          maxHolderVoteScore,
        }) === 'allow',
    );
  } catch (err) {
    log.warn({ err }, 'reserve pre-check failed; assuming a candidate can take the slot');
    return true;
  }
}

/** The gate. Resolves to nothing when the job may run; throws DelayedError when it yielded.
 *
 *  Fail-open on every error, matching its siblings — a docker hiccup, an unavailable config or a
 *  Redis blip must never stop an agent from running. The `!token` skip has to stay: moveToDelayed
 *  cannot be called without a worker token, so there is no way to hold the job at all. */
export async function enforceRuntimeHolderReserve(
  db: Database,
  payload: CliExecJobPayload,
  job: Job<CliExecQueuePayload>,
  token: string | undefined,
): Promise<void> {
  if (!token) return;

  let enabled: boolean;
  let maxHoldMs: number;
  try {
    const [reserve, governor, holdMinutes] = await Promise.all([
      configService.getBoolean(CONFIG_KEYS.AGENT_RESERVE_ENABLED, true),
      resourceLimitsEnabled(),
      configService.getNumber(CONFIG_KEYS.AGENT_RESERVE_MAX_HOLD_MINUTES, 3),
    ]);
    enabled = reserve && governor;
    maxHoldMs = Math.max(0, Math.floor(holdMinutes)) * 60_000;
  } catch {
    return; // config unavailable — don't hold the job
  }
  if (!enabled) return;

  let holders: Set<string>;
  let holdsRunner: boolean;
  let waitingHolderJobs: number;
  let heldForMs: number;
  let voteScore: number;
  let maxHolderVoteScore: number;
  try {
    const now = Date.now();
    ({ holders, waitingHolderJobs, maxHolderVoteScore } = await reserveContext(db, now));
    holdsRunner = holders.has(payload.taskId);
    // Cost guard, not a second rule: agentReserveDecision would allow on either of these anyway,
    // and the hold read is pointless once it is settled.
    if (holders.size === 0 || holdsRunner) {
      void clearHold(payload.invocationId);
      return;
    }
    voteScore = await readTaskVoteScore(db, payload.taskId);
    heldForMs = await readHoldAgeMs(payload.invocationId, now);
  } catch (err) {
    log.warn({ err, taskId: payload.taskId }, 'agent reserve check failed; allowing job');
    return;
  }

  const decision = agentReserveDecision({
    enabled,
    holderCount: holders.size,
    holdsRunner,
    waitingHolderJobs,
    heldForMs,
    maxHoldMs,
    voteScore,
    maxHolderVoteScore,
  });
  if (decision === 'allow') {
    if (voteScore > maxHolderVoteScore && waitingHolderJobs > 0) {
      log.info(
        {
          taskId: payload.taskId,
          invocationId: payload.invocationId,
          voteScore,
          maxHolderVoteScore,
        },
        'agent reserve: vote outranks the runner holders; not yielding',
      );
    }
    if (heldForMs > 0) {
      log.info(
        { taskId: payload.taskId, invocationId: payload.invocationId, heldForMs, maxHoldMs },
        'agent reserve released invocation',
      );
    }
    void clearHold(payload.invocationId);
    return;
  }

  try {
    const first = await markHeld(payload.invocationId, Date.now());
    if (first) {
      await markWaiting(db, payload.invocationId, holders.size).catch((err: unknown) => {
        log.warn({ err, invocationId: payload.invocationId }, 'agent reserve status mark failed');
      });
      log.info(
        {
          taskId: payload.taskId,
          invocationId: payload.invocationId,
          holders: holders.size,
          waitingHolderJobs,
        },
        'agent reserve: yielding slot to a task holding a runtime runner',
      );
    }
    await job.moveToDelayed(Date.now() + DEFER_MS, token);
  } catch (err) {
    log.warn({ err, taskId: payload.taskId }, 'agent reserve defer failed; allowing job');
    return;
  }
  throw new DelayedError();
}
