import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_RUNNER_LABEL,
  CONFIG_RUNTIME_LIMITS_CHANNEL,
  configService,
  createRedisConnection,
  logger,
} from '@haive/shared';
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

interface Waiter {
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  admit: (reason: 'slot' | 'timeout' | 'disabled') => void;
}

let inFlightBoots = 0;
const waiters: Waiter[] = [];
let pumping = false;
let pumpAgain = false;
let repumpTimer: ReturnType<typeof setInterval> | null = null;

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
export async function acquireRuntimeSlot(taskId: string, kind: 'ddev' | 'app'): Promise<ReleaseFn> {
  if (!(await resourceLimitsEnabled())) return NOOP_RELEASE;

  return new Promise<ReleaseFn>((resolve) => {
    const w: Waiter = { done: false, timer: null, admit: () => {} };
    w.admit = (reason) => {
      if (w.done) return;
      w.done = true;
      if (w.timer) clearTimeout(w.timer);
      const idx = waiters.indexOf(w);
      if (idx >= 0) waiters.splice(idx, 1);
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
