/**
 * Host-resource sizing for the runtime resource governor. Reads the worker host's
 * total RAM + CPU count and derives conservative per-runner Docker caps and an
 * aggregate max-concurrent-runtimes number, so a fresh install self-tunes to its
 * machine (thin community boxes down to 8 GB) instead of spawning unbounded DDEV/app
 * runners that can drive a small WSL2 VM into swap thrash.
 *
 * deriveRuntimeCaps is pure (no `node:os`) so the sizing formula is unit-testable;
 * readHostResources is the one impure entry point.
 */
import os from 'node:os';

export interface HostResources {
  totalMemMb: number;
  freeMemMb: number;
  cpuCount: number;
}

export interface RuntimeCapOverrides {
  /** Admin RUNTIME_MEMORY_MB; <= 0 means auto-derive. */
  memoryMb?: number;
  /** Admin RUNTIME_CPUS; <= 0 means auto-derive. */
  cpus?: number;
  /** Admin MAX_CONCURRENT_RUNTIMES; <= 0 means auto-derive. */
  maxConcurrent?: number;
}

export interface RuntimeCaps {
  /** --memory / --memory-swap (MB) per DDEV/app runner. */
  perRunnerMemoryMb: number;
  /** --cpus per DDEV/app runner. */
  perRunnerCpus: number;
  /** --pids-limit per DDEV/app runner. */
  perRunnerPidsLimit: number;
  /** Max concurrent LIVE runtime runners the admission gate admits. */
  maxConcurrentRuntimes: number;
}

/** RAM the base stack (postgres/redis/api/worker/web) + OS/page-cache is assumed to
 *  need, reserved off the top before budgeting runners. 30% of host, bounded so a
 *  tiny box keeps at least 2 GB and a huge box doesn't over-reserve. */
const RESERVE_FRACTION = 0.3;
const RESERVE_FLOOR_MB = 2048;
const RESERVE_CEIL_MB = 6144;

/** Desired per-runner memory. Sized for the heaviest runner: a DDEV DinD (nested
 *  dockerd + web + db + router) that ALSO hosts a headed Chromium for VNC testing.
 *  Clamped down to the budget on small machines, never below the floor a real
 *  DDEV+Chromium boot needs (a tighter cap OOM-kills mid-boot). */
const DESIRED_RUNNER_MB = 4096;
const RUNNER_FLOOR_MB = 1536;

/** Generous PID cap: a DinD daemon plus DDEV's containers plus Chromium fork heavily,
 *  so this guards against a runaway fork bomb without breaking normal operation. */
const RUNNER_PIDS_LIMIT = 8192;

/** Cap on auto-derived per-runner CPUs (a runner rarely needs more, and leaving cores
 *  for the host keeps it responsive). */
const RUNNER_CPU_CEIL = 4;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** Read the worker host's live memory + CPU. Uses availableParallelism (respects any
 *  cpuset the worker container itself runs under) with a cpus().length fallback. */
export function readHostResources(): HostResources {
  const bytesToMb = (b: number): number => Math.floor(b / 1024 / 1024);
  const cpuCount =
    typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length || 1;
  return {
    totalMemMb: bytesToMb(os.totalmem()),
    freeMemMb: bytesToMb(os.freemem()),
    cpuCount: Math.max(1, cpuCount),
  };
}

/** Derive per-runner caps + the aggregate concurrency cap from host size. Pure. Any
 *  override <= 0 (or absent) auto-derives that field; a positive override wins as-is.
 *  On thin machines the budget shrinks maxConcurrentRuntimes FIRST (keeping per-runner
 *  memory at a workable floor) rather than starving each runner below what DDEV needs. */
export function deriveRuntimeCaps(input: {
  totalMemMb: number;
  cpuCount: number;
  overrides?: RuntimeCapOverrides;
}): RuntimeCaps {
  const totalMemMb = Math.max(0, Math.floor(input.totalMemMb));
  const cpuCount = Math.max(1, Math.floor(input.cpuCount));
  const ov = input.overrides ?? {};

  const reserveMb = clamp(
    Math.round(totalMemMb * RESERVE_FRACTION),
    RESERVE_FLOOR_MB,
    RESERVE_CEIL_MB,
  );
  const budgetMb = Math.max(RUNNER_FLOOR_MB, totalMemMb - reserveMb);

  const perRunnerMemoryMb =
    ov.memoryMb && ov.memoryMb > 0
      ? Math.floor(ov.memoryMb)
      : clamp(DESIRED_RUNNER_MB, RUNNER_FLOOR_MB, budgetMb);

  const perRunnerCpus =
    ov.cpus && ov.cpus > 0 ? ov.cpus : clamp(Math.floor(cpuCount / 2), 1, RUNNER_CPU_CEIL);

  const maxConcurrentRuntimes =
    ov.maxConcurrent && ov.maxConcurrent > 0
      ? Math.floor(ov.maxConcurrent)
      : Math.max(1, Math.floor(budgetMb / perRunnerMemoryMb));

  return {
    perRunnerMemoryMb,
    perRunnerCpus,
    perRunnerPidsLimit: RUNNER_PIDS_LIMIT,
    maxConcurrentRuntimes,
  };
}
