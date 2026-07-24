import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_RUNNER_LABEL,
  CONFIG_KEYS,
  CONFIG_RUNTIME_LIMITS_CHANNEL,
  configService,
  createRedisConnection,
  deriveAgentConcurrency,
  logger,
  type RuntimeCaps,
} from '@haive/shared';
import { getRedis } from '../redis.js';
import {
  RUNTIME_WEIGHT_LABEL,
  hostCpuCount,
  resolveRuntimeCaps,
  resolveRuntimeWeightMb,
  resourceLimitsEnabled,
  type RuntimeKind,
} from './runtime-caps.js';

// In-process admission gate bounding how much MEMORY the LIVE runtime runners (DDEV DinD + app
// runner) commit at once, to the machine-aware runtime budget. The worker is a single process,
// so an in-process counter + a docker ps of live runners is authoritative. It wraps ONLY the
// cold-boot (new-container) path; reuse/warm-start never acquire, so steady-state calls are
// unaffected. When the governor is disabled the gate is a no-op. On timeout a waiter proceeds
// anyway (never fail a task purely on the gate) — the per-container caps + reaper make that a
// capped overcommit, not thrash.
//
// The budget is in MB rather than a slot count because a slot count prices every runtime at the
// heaviest one: a ~300 MB app-runner consumed the same slot as a nested dockerd hosting
// Chromium, so a 16 GB host admitted two runtimes of any kind. Weights are PLANNING values
// (see deriveRuntimeCaps), not the `--memory` ceilings the containers actually run with.

const exec = promisify(execFile);
const log = logger.child({ module: 'runtime-admission' });

/** How long a cold-boot waits for a free slot before proceeding regardless. */
const ADMISSION_TIMEOUT_MS = 8 * 60_000;
/** Re-evaluate waiters periodically so capacity freed OUTSIDE the gate (a runner reaped or
 *  torn down at task end) gets picked up without waiting for the full timeout. */
const REPUMP_INTERVAL_MS = 15_000;

type ReleaseFn = () => void;
const NOOP_RELEASE: ReleaseFn = () => {};

/** Thrown from acquireRuntimeSlot when the task was stopped/cancelled while it waited for a
 *  runtime slot, so the caller unwinds the bring-up instead of proceeding. */
export class RuntimeSlotAbortedError extends Error {
  constructor(taskId: string) {
    super(`runtime slot wait aborted: task ${taskId} was stopped`);
    this.name = 'RuntimeSlotAbortedError';
  }
}

interface Waiter {
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** What this waiter's runner will occupy, so the head of the queue is admitted against the
   *  budget it actually needs rather than a one-size slot. */
  weightMb: number;
  admit: (reason: 'slot' | 'timeout' | 'disabled' | 'aborted') => void;
  /** Called while this waiter is still queued behind a full pool, with the MB in use (live
   *  runners + in-flight boots) and the budget. Lets a caller surface "waiting for a runtime
   *  slot" instead of a misleading boot-progress line. Fires on the initial pump and each 15s
   *  repump, so the numbers stay fresh. */
  onWait?: (busyMb: number, budgetMb: number) => void;
}

/** Boots this process has admitted but whose containers do not exist yet, so they are invisible
 *  to `docker ps`. Both dimensions are tracked: MB for the budget, count for a pinned count cap. */
const inFlight = { count: 0, weightMb: 0 };
const waiters: Waiter[] = [];
let pumping = false;
let pumpAgain = false;
let repumpTimer: ReturnType<typeof setInterval> | null = null;

/** Optional hook to reclaim runtime capacity when the pool is full, by preempting a runner
 *  whose task is no longer running (a failed/terminal task's grace-runner). Wired at boot to
 *  the runner reaper; left unset it is exactly today's park-and-wait behavior. Returns true
 *  iff it freed a runner. */
let reclaimer: (() => Promise<boolean>) | null = null;
export function setRuntimeReclaimer(fn: (() => Promise<boolean>) | null): void {
  reclaimer = fn;
}

function listRunningIdsByLabels(labels: string[]): Promise<string[]> {
  const filters = labels.flatMap((l) => ['--filter', `label=${l}`]);
  return exec('docker', ['ps', '-q', ...filters], { timeout: 10_000 })
    .then(({ stdout }) => stdout.split(/\s+/).filter((s) => s.length > 0))
    .catch(() => []);
}

/** Weight each live runner carrying `label` contributes, keyed by TASK rather than container
 *  because admission is per task — a task running both a DDEV and an app runner holds ONE
 *  environment, which is already how taskHasLiveRunner treats it, so it contributes the heavier
 *  of the two rather than their sum. A runner missing the task label falls back to its container
 *  id so it still occupies capacity; one missing the weight label (started before this existed,
 *  or with the governor off) falls back to the caller's class weight rather than to zero. */
export function parseRunnerWeights(stdout: string, fallbackWeightMb: number): Map<string, number> {
  const weights = new Map<string, number>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const [taskId, containerId, weightRaw] = line.split('|');
    const key = taskId && taskId.length > 0 ? taskId : `container:${containerId}`;
    const parsed = Number.parseInt(weightRaw ?? '', 10);
    const weightMb = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackWeightMb;
    weights.set(key, Math.max(weights.get(key) ?? 0, weightMb));
  }
  return weights;
}

function listRunnerWeightsByLabel(
  label: string,
  fallbackWeightMb: number,
): Promise<Map<string, number>> {
  return exec(
    'docker',
    [
      'ps',
      '--filter',
      `label=${label}`,
      '--format',
      `{{.Label "haive.task.id"}}|{{.ID}}|{{.Label "${RUNTIME_WEIGHT_LABEL}"}}`,
    ],
    { timeout: 10_000 },
  )
    .then(({ stdout }) => parseRunnerWeights(stdout, fallbackWeightMb))
    .catch(() => new Map<string, number>());
}

/** What an unknown weight counts as: the heaviest runner kind, browser desktop included.
 *  Used for runners started before the weight label existed and for reservations/tickets whose
 *  weight cannot be read. Over-counting delays one boot; under-counting overcommits the host,
 *  and it is exactly what the previous governor assumed every runtime cost. */
function heaviestWeightMb(caps: RuntimeCaps): number {
  return caps.ddevWeightMb + caps.browserWeightMb;
}

/** Tasks holding a live runtime runner, with the MB each occupies. Two label queries unioned —
 *  docker ANDs multiple --filter label flags, so a single call can't OR the two labels. */
async function liveRuntimeWeights(caps: RuntimeCaps): Promise<Map<string, number>> {
  const [ddev, app] = await Promise.all([
    listRunnerWeightsByLabel('haive.ddev', heaviestWeightMb(caps)),
    listRunnerWeightsByLabel(APP_RUNNER_LABEL, caps.appWeightMb + caps.browserWeightMb),
  ]);
  const merged = new Map(ddev);
  for (const [taskId, weightMb] of app) {
    merged.set(taskId, Math.max(merged.get(taskId) ?? 0, weightMb));
  }
  return merged;
}

/** The governor's resolved sizing, or null when it is off (the gate becomes a no-op). Also null
 *  when config is unavailable — fail open, never block a task because Redis blinked. */
async function governor(): Promise<RuntimeCaps | null> {
  if (!(await resourceLimitsEnabled())) return null;
  try {
    return await resolveRuntimeCaps();
  } catch {
    return null;
  }
}

/** True when the task already owns a LIVE (running) runtime runner — it reuses/warm-starts
 *  that one and needs NO new admission. Running-only (`docker ps -q`): a created/exited
 *  container is not a usable runtime. Both RUNTIME labels are required alongside the task id:
 *  `haive.task.id` on its own is stamped on cli sandboxes, IDE and terminal containers too
 *  (sandbox-kill.ts relies on exactly that), so matching it alone answered "has a runner" for
 *  any task merely running a CLI — and waved that task straight past the pool limit. */
async function taskHasLiveRunner(taskId: string): Promise<boolean> {
  const [ddev, app] = await Promise.all([
    listRunningIdsByLabels(['haive.ddev', `haive.task.id=${taskId}`]),
    listRunningIdsByLabels([APP_RUNNER_LABEL, `haive.task.id=${taskId}`]),
  ]);
  return ddev.length > 0 || app.length > 0;
}

// --- Slot reservations -----------------------------------------------------------------
// A task admitted by the TASK-level gate does not create its container until the step's boot
// path runs, so between admit and `docker run` it occupied nothing: every task polling inside
// that window saw the same free capacity, and the surplus piled up inside acquireRuntimeSlot,
// each holding a worker job until ADMISSION_TIMEOUT_MS elapsed and then booting anyway — a
// budget for 2 running 4 runners. A reservation closes the window: written at admit, counted as
// busy until the boot either produced a runner (the container counts from then on) or gave up.
// Redis HASH field=taskId, value=`<expiryMs>|<weightMb>`; reads prune expired fields, so a
// reservation can never outlive its task by more than the TTL.
const RESERVE_KEY = 'haive:runtime-reserve';
/** Backstop only — the boot path releases on success or failure, the orchestrator releases when
 *  the reserving step ends, and worker boot wipes the hash (the boot reaper removes every runner
 *  anyway). This bounds only a reservation whose worker died mid-boot, so it must sit well above
 *  a legitimate cold DDEV boot (image pulls plus two 15-minute `ddev start` attempts). */
const RESERVE_TTL_MS = 45 * 60_000;

/** Tasks holding a reservation and the MB each reserved, expired fields pruned. A Redis failure
 *  returns an empty map: reservations then stop counting and the gate falls back to live runners
 *  only — the pre-reservation behavior, never a block. */
async function reservedWeights(caps: RuntimeCaps): Promise<Map<string, number>> {
  try {
    const redis = getRedis();
    const all = await redis.hgetall(RESERVE_KEY);
    const now = Date.now();
    const live = new Map<string, number>();
    const expired: string[] = [];
    for (const [taskId, value] of Object.entries(all)) {
      const [expiresAt, weightRaw] = value.split('|');
      if (Number(expiresAt) > now) {
        const parsed = Number.parseInt(weightRaw ?? '', 10);
        // An unparseable weight (a reservation written by an older worker) counts as the
        // heaviest kind: over-counting delays a boot, under-counting overcommits the host.
        live.set(taskId, Number.isFinite(parsed) && parsed > 0 ? parsed : heaviestWeightMb(caps));
      } else {
        expired.push(taskId);
      }
    }
    if (expired.length > 0) await redis.hdel(RESERVE_KEY, ...expired);
    return live;
  } catch (err) {
    log.warn({ err }, 'runtime reservation read failed; counting live runners only');
    return new Map();
  }
}

async function reserveRuntimeSlot(taskId: string, weightMb: number): Promise<void> {
  try {
    await getRedis().hset(RESERVE_KEY, taskId, `${Date.now() + RESERVE_TTL_MS}|${weightMb}`);
  } catch (err) {
    log.warn({ err, taskId }, 'runtime reservation write failed; slot uncounted until it boots');
  }
}

/** Whether this task holds a reservation right now. */
async function hasReservation(taskId: string): Promise<boolean> {
  try {
    return (await getRedis().hexists(RESERVE_KEY, taskId)) === 1;
  } catch {
    return false;
  }
}

/** Drop a task's reservation — its boot finished (the container counts on its own now) or the
 *  step that reserved ended without booting one. Idempotent. */
export async function releaseRuntimeReservation(taskId: string): Promise<void> {
  try {
    await getRedis().hdel(RESERVE_KEY, taskId);
  } catch {
    // Soft state: the expiry prunes it on the next read.
  }
}

/** Wipe every reservation. Called on worker boot, where the boot reaper removes all runtime
 *  runners — so any reservation left by the previous process is stale by definition. */
export async function clearRuntimeReservations(): Promise<void> {
  try {
    await getRedis().del(RESERVE_KEY);
  } catch (err) {
    log.warn({ err }, 'clearing runtime reservations on boot failed');
  }
}

/** Capacity in use: tasks holding a live runtime runner plus tasks holding a reservation for one
 *  they have not booted yet. Keyed by task id, so a task whose container already exists is not
 *  counted twice while its reservation is still open. */
async function runtimeOccupancy(caps: RuntimeCaps): Promise<Map<string, number>> {
  const [running, reserved] = await Promise.all([liveRuntimeWeights(caps), reservedWeights(caps)]);
  const merged = new Map(running);
  for (const [taskId, weightMb] of reserved) {
    merged.set(taskId, Math.max(merged.get(taskId) ?? 0, weightMb));
  }
  return merged;
}

function sumWeights(weights: Map<string, number>): number {
  let total = 0;
  for (const weightMb of weights.values()) total += weightMb;
  return total;
}

/** MB the runtime pool currently commits (live runners + reservations + in-flight boots), or 0
 *  when the governor is off. Exported for the cli-exec worker, which sizes agent concurrency
 *  from whatever the runtime pool is NOT holding — one implementation, one docker query shape. */
export async function runtimeOccupancyMb(): Promise<number> {
  const caps = await governor();
  if (!caps) return 0;
  return sumWeights(await runtimeOccupancy(caps)) + inFlight.weightMb;
}

/** Concurrency the cli-exec queue should run at right now.
 *
 *  A positive MAX_PARALLEL_AGENTS is an admin pin and wins outright (that is the rollback to the
 *  fixed behavior). At 0 the count is sized from what the runtime pool leaves free, so agent
 *  throughput rises on an idle host and falls back to the floor while DDEV runners are up —
 *  the two pools finally spend one budget instead of two independent ones.
 *
 *  With the governor off there is no budget to divide, so it falls back to the historical fixed
 *  default: "governor disabled" must mean pre-feature behavior everywhere. */
export async function resolveAgentConcurrency(fallback: number): Promise<number> {
  const pinned = await configService.getNumber(CONFIG_KEYS.MAX_PARALLEL_AGENTS, 0);
  if (pinned > 0) return Math.floor(pinned);
  const caps = await governor();
  if (!caps) return fallback;
  return deriveAgentConcurrency({
    caps,
    liveRuntimeWeightMb: sumWeights(await runtimeOccupancy(caps)) + inFlight.weightMb,
    cpuCount: hostCpuCount(),
  });
}

// --- FIFO park queue -------------------------------------------------------------------
// Fairness for tasks parked at the TASK-level gate. Without it the pool is a lottery: every
// parked step re-polls on its own timer and freed capacity goes to whichever task polls first,
// not to the one that has waited longest. ZSET member = taskId, score = ms of that task's
// FIRST park. Each poll refreshes a short-lived liveness key; a member without one has stopped
// polling (admitted, cancelled, worker died) and is pruned on read, so a dead ticket can never
// head-of-line block the queue. A companion HASH carries each ticket's weight, because with a
// byte budget "am I next" is not enough — a waiter needs to know how much the tasks ahead of it
// will take before it can claim what is free. Redis-only soft state — losing it costs fairness
// for one round, never correctness.
const PARK_QUEUE_KEY = 'haive:runtime-park';
const PARK_WEIGHT_KEY = 'haive:runtime-park-weight';
const PARK_ALIVE_PREFIX = 'haive:runtime-park-alive:';
/** Liveness TTL. Must outlast several park polls so a slow poll is not pruned as dead. */
const PARK_ALIVE_TTL_S = 60;

export interface ParkQueuePosition {
  /** 1-based position among live parked tasks; 1 = next in line. */
  position: number;
  /** Tasks parked on a runtime slot right now, this one included. */
  waiting: number;
  /** Weights of the live tasks queued strictly AHEAD of this one. */
  weightsAheadMb: number[];
}

/** Join the park queue (idempotent — the first park's score is kept) and read this task's live
 *  position plus the weights ahead of it. Best-effort: any Redis failure degrades to "I am next
 *  and nothing is ahead", i.e. the first-poll-wins behavior this queue replaces. */
async function joinParkQueue(
  taskId: string,
  weightMb: number,
  caps: RuntimeCaps,
): Promise<ParkQueuePosition> {
  try {
    const redis = getRedis();
    await redis
      .multi()
      .zadd(PARK_QUEUE_KEY, 'NX', Date.now(), taskId)
      .hset(PARK_WEIGHT_KEY, taskId, String(weightMb))
      .set(`${PARK_ALIVE_PREFIX}${taskId}`, '1', 'EX', PARK_ALIVE_TTL_S)
      .exec();
    const members = await redis.zrange(PARK_QUEUE_KEY, 0, -1);
    if (members.length === 0) return { position: 1, waiting: 1, weightsAheadMb: [] };
    const alive = await redis.mget(...members.map((m) => `${PARK_ALIVE_PREFIX}${m}`));
    const live: string[] = [];
    const dead: string[] = [];
    members.forEach((m, i) => (alive[i] === null ? dead : live).push(m));
    if (dead.length > 0) {
      await redis
        .multi()
        .zrem(PARK_QUEUE_KEY, ...dead)
        .hdel(PARK_WEIGHT_KEY, ...dead)
        .exec();
    }
    const idx = live.indexOf(taskId);
    if (idx < 0) return { position: 1, waiting: Math.max(live.length, 1), weightsAheadMb: [] };
    const ahead = live.slice(0, idx);
    const aheadWeights = ahead.length > 0 ? await redis.hmget(PARK_WEIGHT_KEY, ...ahead) : [];
    return {
      position: idx + 1,
      waiting: Math.max(live.length, 1),
      // A ticket with no recorded weight counts as the heaviest kind — see reservedWeights.
      weightsAheadMb: aheadWeights.map((v) => {
        const parsed = Number.parseInt(v ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : heaviestWeightMb(caps);
      }),
    };
  } catch (err) {
    log.warn({ err, taskId }, 'park-queue read failed; admitting first-come');
    return { position: 1, waiting: 1, weightsAheadMb: [] };
  }
}

/** Leave the park queue — called the moment a task is admitted (or never parked at all), so
 *  its ticket cannot hold back the tasks queued behind it. */
async function leaveParkQueue(taskId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis
      .multi()
      .zrem(PARK_QUEUE_KEY, taskId)
      .hdel(PARK_WEIGHT_KEY, taskId)
      .del(`${PARK_ALIVE_PREFIX}${taskId}`)
      .exec();
  } catch {
    // Soft state: the liveness key expires on its own, so a failed release self-heals.
  }
}

export interface RuntimeAdmissionInput {
  /** Null when the governor is off — the gate is a no-op. */
  budgetMb: number | null;
  /** MB already committed (live runners + reservations + in-flight boots). */
  busyMb: number;
  /** What this task's runner will occupy. */
  myWeightMb: number;
  /** Weights of the live tasks queued strictly ahead of this one in the FIFO park queue. */
  weightsAheadMb: readonly number[];
  hasLiveRunner: boolean;
  /** Admin-pinned cap on the NUMBER of runners, or null when only the budget governs. */
  maxCount: number | null;
  /** Runners counted for the pinned count cap (live + reserved + in-flight). */
  busyCount: number;
}

/** Pure admission decision, split from the docker/config I/O so the rule is directly testable
 *  (mirrors reapDecision / pickPreemptibleRunner). `proceed` when the governor is off, the task
 *  already holds a runner (reuse/warm — no new capacity), the machine is idle, or what is free
 *  covers this task AND everything queued ahead of it; else `park`.
 *
 *  Counting the queue ahead is what keeps FIFO honest in bytes: a light app-runner may still
 *  backfill capacity a queued DDEV cannot use, but it can never claim capacity the tasks that
 *  have waited longer are about to need. */
export function runtimeAdmissionDecision(input: RuntimeAdmissionInput): 'proceed' | 'park' {
  if (input.budgetMb === null) return 'proceed';
  if (input.hasLiveRunner) return 'proceed';
  const aheadMb = input.weightsAheadMb.reduce((sum, w) => sum + w, 0);
  // Never block on an idle machine. A weight larger than the whole budget (a fat per-task
  // memory pin, or a mis-set weight) would otherwise park forever waiting for capacity that
  // cannot exist — the host is better served running it alone than running nothing.
  if (input.busyMb === 0 && aheadMb === 0 && input.busyCount === 0) return 'proceed';
  if (input.maxCount !== null && input.busyCount >= input.maxCount) return 'park';
  return input.busyMb + aheadMb + input.myWeightMb <= input.budgetMb ? 'proceed' : 'park';
}

/** Non-blocking, TASK-level runtime admission — the pre-step gate the orchestrator consults
 *  BEFORE running a step that would bring up a runtime, so it can PARK the task (release the
 *  worker, re-drive later) instead of blocking in `acquireRuntimeSlot` and overcommitting the
 *  pool past the budget. Counts in-flight boots so a task mid-cold-boot also occupies capacity
 *  here, closing most of the pre-check -> cold-boot race. The docker count is skipped when the
 *  task already holds a runner (short-circuit to proceed). */
export async function runtimeAdmission(
  taskId: string,
  kind: RuntimeKind,
): Promise<{
  decision: 'proceed' | 'park';
  busyMb: number;
  budgetMb: number;
  myWeightMb: number;
  position: number;
  waiting: number;
}> {
  const idle = { decision: 'proceed' as const, busyMb: 0, budgetMb: 0, position: 1, waiting: 0 };
  const caps = await governor();
  if (!caps) {
    await leaveParkQueue(taskId);
    return { ...idle, myWeightMb: 0 };
  }
  if (await taskHasLiveRunner(taskId)) {
    await leaveParkQueue(taskId);
    return { ...idle, budgetMb: caps.runtimeBudgetMb, myWeightMb: 0 };
  }
  const myWeightMb = await resolveRuntimeWeightMb(taskId, kind);
  let occupancy = await runtimeOccupancy(caps);
  let busyMb = sumWeights(occupancy) + inFlight.weightMb;
  // Pool full: before parking, try to preempt a runner from a task that is no longer running
  // (a failed/terminal task's grace-runner) — a live task's demand outranks a dead task's
  // retry-cache, and parking must NOT make the waiter sit out the full failed-grace. Uses the
  // same reclaimer the in-process gate calls (the pre-check bypasses that gate, so without this
  // preemption would never fire for a parked task). If it frees one, re-count and maybe admit.
  if (
    busyMb + myWeightMb > caps.runtimeBudgetMb &&
    reclaimer &&
    (await reclaimer().catch(() => false))
  ) {
    occupancy = await runtimeOccupancy(caps);
    busyMb = sumWeights(occupancy) + inFlight.weightMb;
  }
  // Take (or keep) the FIFO ticket BEFORE deciding — the decision needs this task's position and
  // the weights ahead of it, and an admitted task drops its ticket again right below.
  const queue = await joinParkQueue(taskId, myWeightMb, caps);
  const decision = runtimeAdmissionDecision({
    budgetMb: caps.runtimeBudgetMb,
    busyMb,
    myWeightMb,
    weightsAheadMb: queue.weightsAheadMb,
    hasLiveRunner: false,
    maxCount: caps.maxConcurrentRuntimes,
    busyCount: occupancy.size + inFlight.count,
  });
  if (decision === 'proceed') {
    // Reserve before returning. The step's boot is seconds away at best, and until its container
    // exists this reservation is the only thing between the next poller and a double-booked slot.
    await reserveRuntimeSlot(taskId, myWeightMb);
    await leaveParkQueue(taskId);
  }
  return {
    decision,
    busyMb,
    budgetMb: caps.runtimeBudgetMb,
    myWeightMb,
    position: queue.position,
    waiting: queue.waiting,
  };
}

function ensureRepumpTimer(): void {
  if (repumpTimer || waiters.length === 0) return;
  repumpTimer = setInterval(() => {
    if (waiters.length === 0) {
      if (repumpTimer) clearInterval(repumpTimer);
      repumpTimer = null;
      return;
    }
    void pump();
  }, REPUMP_INTERVAL_MS);
  if (repumpTimer.unref) repumpTimer.unref();
}

async function pump(): Promise<void> {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      while (waiters.length > 0) {
        const caps = await governor();
        if (!caps) {
          for (const w of waiters.splice(0)) w.admit('disabled');
          break;
        }
        const occupancy = await runtimeOccupancy(caps);
        const busyMb = sumWeights(occupancy) + inFlight.weightMb;
        const head = waiters[0];
        if (!head) break;
        const decision = runtimeAdmissionDecision({
          budgetMb: caps.runtimeBudgetMb,
          busyMb,
          myWeightMb: head.weightMb,
          // The in-process queue IS the order, so the head has nothing ahead of it.
          weightsAheadMb: [],
          hasLiveRunner: false,
          maxCount: caps.maxConcurrentRuntimes,
          busyCount: occupancy.size + inFlight.count,
        });
        if (decision === 'proceed') {
          head.admit('slot');
        } else {
          // Pool full. Before parking the waiters, try to reclaim capacity by preempting a
          // runner whose task is no longer running (a dead task's grace-runner) — a live
          // waiter's demand outranks a retry-cache. A reclaim frees a running runner, so loop
          // again to re-count and admit. Best-effort: never let it fail the pump.
          if (reclaimer && (await reclaimer().catch(() => false))) continue;
          // Nothing to preempt: tell every still-queued waiter WHY it's blocked (a resource
          // queue, not a slow boot) so its caller's progress line can say so. Fires on the
          // initial pump and each repump, refreshing the numbers as runners come/go.
          for (const w of waiters) w.onWait?.(busyMb, caps.runtimeBudgetMb);
          break;
        }
      }
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

/** Acquire admission before booting a runtime runner. Resolves with a release function the
 *  caller MUST invoke (in a finally) once the runner is up or the boot failed. When the
 *  governor is disabled, resolves immediately with a no-op release. */
export async function acquireRuntimeSlot(
  taskId: string,
  kind: RuntimeKind,
  onWait?: (busyMb: number, budgetMb: number) => void,
  signal?: AbortSignal,
): Promise<ReleaseFn> {
  if (!(await resourceLimitsEnabled())) return NOOP_RELEASE;
  // Already stopped before we even queued — don't take capacity at all.
  if (signal?.aborted) throw new RuntimeSlotAbortedError(taskId);

  // The TASK-level gate already reserved this task's capacity, and that reservation counts
  // toward `busyMb` — queueing here would make the task wait on itself, which is the
  // double-gated stall this closes. Hand back a release that drops the reservation once the boot
  // is done: by then the container exists and counts on its own, or the boot failed and the
  // capacity is genuinely free. inFlight is deliberately NOT incremented — the reservation is
  // the count.
  if (await hasReservation(taskId)) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      void releaseRuntimeReservation(taskId).then(() => {
        void pump();
      });
    };
  }

  const weightMb = await resolveRuntimeWeightMb(taskId, kind);
  return new Promise<ReleaseFn>((resolve, reject) => {
    const w: Waiter = { done: false, timer: null, weightMb, admit: () => {}, onWait };
    let onAbort: (() => void) | null = null;
    w.admit = (reason) => {
      if (w.done) return;
      w.done = true;
      if (w.timer) clearTimeout(w.timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      const idx = waiters.indexOf(w);
      if (idx >= 0) waiters.splice(idx, 1);
      // The task was stopped/cancelled while queued — reject so the bring-up unwinds
      // instead of resuming and clobbering the Stopped step, and DON'T count an
      // in-flight boot (we never boot). The capacity goes to the next real waiter.
      if (reason === 'aborted') {
        log.info({ taskId, kind }, 'runtime admission aborted (task stopped while waiting)');
        reject(new RuntimeSlotAbortedError(taskId));
        return;
      }
      // 'disabled' means the governor was turned off while waiting — don't count it
      // against the budget; hand back a no-op release.
      if (reason === 'disabled') {
        resolve(NOOP_RELEASE);
        return;
      }
      inFlight.count += 1;
      inFlight.weightMb += w.weightMb;
      if (reason === 'timeout') {
        log.warn(
          { taskId, kind, weightMb: w.weightMb, waitedMs: ADMISSION_TIMEOUT_MS },
          'runtime admission timed out; proceeding (capped overcommit, not blocked)',
        );
      }
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        if (inFlight.count > 0) inFlight.count -= 1;
        inFlight.weightMb = Math.max(0, inFlight.weightMb - w.weightMb);
        void pump();
      });
    };
    if (signal) {
      onAbort = () => w.admit('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    w.timer = setTimeout(() => w.admit('timeout'), ADMISSION_TIMEOUT_MS);
    waiters.push(w);
    ensureRepumpTimer();
    void pump();
  });
}

/** Subscribe to the runtime-limits config channel so a change to the budget, the weights or
 *  the master switch retunes the gate live: bust the config cache and re-evaluate waiters (more
 *  capacity releases some; less makes new boots wait). Best-effort; the ~30s config cache is the
 *  fallback. Returns an unsubscribe for shutdown. */
export function startRuntimeLimitsWatch(): () => void {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return () => {};
  const sub = createRedisConnection(redisUrl);
  sub.on('message', () => {
    configService.clearCache();
    void pump();
  });
  sub.subscribe(CONFIG_RUNTIME_LIMITS_CHANNEL).catch((err) => {
    log.warn({ err }, 'runtime-limits watch subscribe failed');
  });
  return () => {
    void sub.quit().catch(() => {});
  };
}
