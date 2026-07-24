import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_RUNNER_LABEL,
  CONFIG_RUNTIME_LIMITS_CHANNEL,
  configService,
  createRedisConnection,
  logger,
} from '@haive/shared';
import { getRedis } from '../redis.js';
import { resolveRuntimeCaps, resourceLimitsEnabled } from './runtime-caps.js';

// In-process admission gate bounding how many LIVE runtime runners (DDEV DinD + app
// runner) exist at once, to the machine-aware maxConcurrentRuntimes. The worker is a
// single process, so an in-process counter + a docker ps of live runners is
// authoritative. It wraps ONLY the cold-boot (new-container) path; reuse/warm-start
// never acquire, so steady-state calls are unaffected. When the governor is disabled
// the gate is a no-op. On timeout a waiter proceeds anyway (never fail a task purely on
// the gate) — the per-container caps + reaper make that a capped overcommit, not thrash.

const exec = promisify(execFile);
const log = logger.child({ module: 'runtime-admission' });

/** How long a cold-boot waits for a free slot before proceeding regardless. */
const ADMISSION_TIMEOUT_MS = 8 * 60_000;
/** Re-evaluate waiters periodically so slots freed OUTSIDE the gate (a runner reaped or
 *  torn down at task end) get picked up without waiting for the full timeout. */
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
  admit: (reason: 'slot' | 'timeout' | 'disabled' | 'aborted') => void;
  /** Called while this waiter is still queued behind a full gate, with the current
   *  busy count (live runners + in-flight boots) and the active max. Lets a caller
   *  surface "waiting for a runtime slot" instead of a misleading boot-progress line.
   *  Fires on the initial pump and each 15s repump, so the count stays fresh. */
  onWait?: (busy: number, max: number) => void;
}

let inFlightBoots = 0;
const waiters: Waiter[] = [];
let pumping = false;
let pumpAgain = false;
let repumpTimer: ReturnType<typeof setInterval> | null = null;

/** Optional hook to reclaim one runtime slot when the gate is full, by preempting a runner
 *  whose task is no longer running (a failed/terminal task's grace-runner). Wired at boot to
 *  the runner reaper; left unset it is exactly today's park-and-wait behavior. Returns true
 *  iff it freed a slot. */
let reclaimer: (() => Promise<boolean>) | null = null;
export function setRuntimeReclaimer(fn: (() => Promise<boolean>) | null): void {
  reclaimer = fn;
}

function listRunningIdsByLabel(label: string): Promise<string[]> {
  return exec('docker', ['ps', '-q', '--filter', `label=${label}`], { timeout: 10_000 })
    .then(({ stdout }) => stdout.split(/\s+/).filter((s) => s.length > 0))
    .catch(() => []);
}

/** Count of live runtime runners (DDEV + app). Two label queries unioned — docker ANDs
 *  multiple --filter label flags, so a single call can't OR the two labels. */
async function liveRuntimeRunnerCount(): Promise<number> {
  const [ddev, app] = await Promise.all([
    listRunningIdsByLabel('haive.ddev'),
    listRunningIdsByLabel(APP_RUNNER_LABEL),
  ]);
  return new Set([...ddev, ...app]).size;
}

/** The active max, or Infinity when the governor is disabled (gate becomes a no-op). */
async function maxConcurrentOrInfinity(): Promise<number> {
  if (!(await resourceLimitsEnabled())) return Number.POSITIVE_INFINITY;
  try {
    const caps = await resolveRuntimeCaps();
    return Math.max(1, caps.maxConcurrentRuntimes);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** True when the task already owns a LIVE (running) runtime runner — it reuses/warm-starts
 *  that one and needs NO new admission slot. Running-only (`docker ps -q`): a created/exited
 *  container is not a usable runtime. Mirrors the label ddev-runner uses for its own sweeps. */
async function taskHasLiveRunner(taskId: string): Promise<boolean> {
  const ids = await exec('docker', ['ps', '-q', '--filter', `label=haive.task.id=${taskId}`], {
    timeout: 10_000,
  })
    .then(({ stdout }) => stdout.split(/\s+/).filter((s) => s.length > 0))
    .catch(() => []);
  return ids.length > 0;
}

// --- FIFO park queue -------------------------------------------------------------------
// Fairness for tasks parked at the TASK-level gate. Without it the pool is a lottery: every
// parked step re-polls on its own timer and a freed slot goes to whichever task polls first,
// not to the one that has waited longest. ZSET member = taskId, score = ms of that task's
// FIRST park. Each poll refreshes a short-lived liveness key; a member without one has stopped
// polling (admitted, cancelled, worker died) and is pruned on read, so a dead ticket can never
// head-of-line block the queue. Redis-only soft state — losing it costs fairness for one
// round, never correctness.
const PARK_QUEUE_KEY = 'haive:runtime-park';
const PARK_ALIVE_PREFIX = 'haive:runtime-park-alive:';
/** Liveness TTL. Must outlast several park polls so a slow poll is not pruned as dead. */
const PARK_ALIVE_TTL_S = 60;

export interface ParkQueuePosition {
  /** 1-based position among live parked tasks; 1 = next in line. */
  position: number;
  /** Tasks parked on a runtime slot right now, this one included. */
  waiting: number;
}

/** Join the park queue (idempotent — the first park's score is kept) and read this task's live
 *  position. Best-effort: any Redis failure degrades to "I am next", i.e. the first-poll-wins
 *  behavior this queue replaces. */
async function joinParkQueue(taskId: string): Promise<ParkQueuePosition> {
  try {
    const redis = getRedis();
    await redis
      .multi()
      .zadd(PARK_QUEUE_KEY, 'NX', Date.now(), taskId)
      .set(`${PARK_ALIVE_PREFIX}${taskId}`, '1', 'EX', PARK_ALIVE_TTL_S)
      .exec();
    const members = await redis.zrange(PARK_QUEUE_KEY, 0, -1);
    if (members.length === 0) return { position: 1, waiting: 1 };
    const alive = await redis.mget(...members.map((m) => `${PARK_ALIVE_PREFIX}${m}`));
    const live: string[] = [];
    const dead: string[] = [];
    members.forEach((m, i) => (alive[i] === null ? dead : live).push(m));
    if (dead.length > 0) await redis.zrem(PARK_QUEUE_KEY, ...dead);
    const idx = live.indexOf(taskId);
    return { position: idx >= 0 ? idx + 1 : 1, waiting: Math.max(live.length, 1) };
  } catch (err) {
    log.warn({ err, taskId }, 'park-queue read failed; admitting first-come');
    return { position: 1, waiting: 1 };
  }
}

/** Leave the park queue — called the moment a task is admitted (or never parked at all), so
 *  its ticket cannot hold back the tasks queued behind it. */
async function leaveParkQueue(taskId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.multi().zrem(PARK_QUEUE_KEY, taskId).del(`${PARK_ALIVE_PREFIX}${taskId}`).exec();
  } catch {
    // Soft state: the liveness key expires on its own, so a failed release self-heals.
  }
}

/** Pure admission decision, split from the docker/config I/O so the rule is directly testable
 *  (mirrors reapDecision / pickPreemptibleRunner). `proceed` when the governor is off
 *  (max=Infinity), the task already holds a runner (reuse/warm — no new slot), or a free slot
 *  is this task's to take by queue position; else `park`. `position` is 1-based (1 = next in
 *  line), so with `free = max - busy` slots open only positions 1..free may claim one — a task
 *  that just arrived can no longer jump a task that has waited an hour. Default 1 keeps the
 *  pre-queue behavior when no position is known. */
export function runtimeAdmissionDecision(
  max: number,
  hasLiveRunner: boolean,
  busy: number,
  position = 1,
): 'proceed' | 'park' {
  if (max === Number.POSITIVE_INFINITY) return 'proceed';
  if (hasLiveRunner) return 'proceed';
  return position <= max - busy ? 'proceed' : 'park';
}

/** Non-blocking, TASK-level runtime admission — the pre-step gate the orchestrator consults
 *  BEFORE running a step that would bring up a runtime, so it can PARK the task (release the
 *  worker, re-drive later) instead of blocking in `acquireRuntimeSlot` and overcommitting the
 *  pool past the limit. Counts `inFlightBoots` so a task mid-cold-boot also occupies a slot
 *  here, closing most of the pre-check -> cold-boot race. The docker count is skipped when the
 *  task already holds a runner (short-circuit to proceed). */
export async function runtimeAdmission(taskId: string): Promise<{
  decision: 'proceed' | 'park';
  busy: number;
  max: number;
  position: number;
  waiting: number;
}> {
  const max = await maxConcurrentOrInfinity();
  if (max === Number.POSITIVE_INFINITY) {
    await leaveParkQueue(taskId);
    return { decision: 'proceed', busy: 0, max, position: 1, waiting: 0 };
  }
  if (await taskHasLiveRunner(taskId)) {
    await leaveParkQueue(taskId);
    return { decision: 'proceed', busy: 0, max, position: 1, waiting: 0 };
  }
  let busy = (await liveRuntimeRunnerCount()) + inFlightBoots;
  // Pool full: before parking, try to preempt a runner from a task that is no longer running
  // (a failed/terminal task's grace-runner) — a live task's demand outranks a dead task's
  // retry-cache, and parking must NOT make the waiter sit out the full failed-grace. Uses the
  // same reclaimer the in-process gate calls (the pre-check bypasses that gate, so without this
  // preemption would never fire for a parked task). If it frees one, re-count and maybe admit.
  if (busy >= max && reclaimer && (await reclaimer().catch(() => false))) {
    busy = (await liveRuntimeRunnerCount()) + inFlightBoots;
  }
  // Take (or keep) the FIFO ticket BEFORE deciding — the decision needs this task's position,
  // and an admitted task drops its ticket again right below. Cost of the extra Redis round trip
  // on an uncontended admission is one ZADD/SET/ZRANGE; the gate runs once per step advance.
  const queue = await joinParkQueue(taskId);
  const decision = runtimeAdmissionDecision(max, false, busy, queue.position);
  if (decision === 'proceed') await leaveParkQueue(taskId);
  return { decision, busy, max, position: queue.position, waiting: queue.waiting };
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
        const max = await maxConcurrentOrInfinity();
        if (max === Number.POSITIVE_INFINITY) {
          for (const w of waiters.splice(0)) w.admit('disabled');
          break;
        }
        const live = await liveRuntimeRunnerCount();
        if (live + inFlightBoots < max) {
          waiters[0]?.admit('slot');
        } else {
          // Gate full. Before parking the waiters, try to reclaim a slot by preempting a
          // runner whose task is no longer running (a dead task's grace-runner) — a live
          // waiter's demand outranks a retry-cache. A reclaim frees a running runner, so loop
          // again to re-count `live` and admit. Best-effort: never let it fail the pump.
          if (reclaimer && (await reclaimer().catch(() => false))) continue;
          // Nothing to preempt: tell every still-queued waiter WHY it's blocked (a resource
          // queue, not a slow boot) so its caller's progress line can say so. Fires on the
          // initial pump and each repump, refreshing the count as runners come/go.
          const busy = live + inFlightBoots;
          for (const w of waiters) w.onWait?.(busy, max);
          break;
        }
      }
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

/** Acquire a slot before booting a runtime runner. Resolves with a release function the
 *  caller MUST invoke (in a finally) once the runner is up or the boot failed. When the
 *  governor is disabled, resolves immediately with a no-op release. */
export async function acquireRuntimeSlot(
  taskId: string,
  kind: 'ddev' | 'app',
  onWait?: (busy: number, max: number) => void,
  signal?: AbortSignal,
): Promise<ReleaseFn> {
  if (!(await resourceLimitsEnabled())) return NOOP_RELEASE;
  // Already stopped before we even queued — don't take a slot at all.
  if (signal?.aborted) throw new RuntimeSlotAbortedError(taskId);

  return new Promise<ReleaseFn>((resolve, reject) => {
    const w: Waiter = { done: false, timer: null, admit: () => {}, onWait };
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
      // inFlightBoot (we never boot). The slot goes to the next real waiter.
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
      inFlightBoots += 1;
      if (reason === 'timeout') {
        log.warn(
          { taskId, kind, waitedMs: ADMISSION_TIMEOUT_MS },
          'runtime admission timed out; proceeding (capped overcommit, not blocked)',
        );
      }
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        if (inFlightBoots > 0) inFlightBoots -= 1;
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

/** Subscribe to the runtime-limits config channel so a change to MAX_CONCURRENT_RUNTIMES
 *  (or the master switch) retunes the gate live: bust the config cache and re-evaluate
 *  waiters (a raised cap releases some; a lowered cap makes new boots wait). Best-effort;
 *  the ~30s config cache is the fallback. Returns an unsubscribe for shutdown. */
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
