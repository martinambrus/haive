/**
 * Host-resource sizing for the runtime resource governor. Reads the worker host's
 * total RAM + CPU count and derives conservative per-runner Docker caps plus the MB
 * budget the admission gate hands out, so a fresh install self-tunes to its machine
 * (thin community boxes down to 8 GB) instead of spawning unbounded DDEV/app runners
 * that can drive a small WSL2 VM into swap thrash.
 *
 * CAP vs WEIGHT — the two numbers are deliberately different:
 *   - `perRunnerMemoryMb` is the Docker `--memory` CEILING. It is generous on purpose
 *     (sized for the heaviest runner) and only ever OOM-kills a runaway container.
 *   - `*WeightMb` are PLANNING weights: what admission assumes a runner of that kind
 *     actually occupies. Budgeting against the ceiling is what made every runtime cost
 *     a full DDEV DinD, so a ~300 MB app-runner consumed the same slot as a nested
 *     dockerd hosting Chromium.
 * Weights are admin-tunable and the defaults below are PROVISIONAL: they are set so
 * nothing regresses against the previous count-based behavior, not from measurement.
 * Calibrate by sampling `docker stats` across a real boot / `ddev start` / agent run
 * and lowering them; lower weights are what buy extra concurrency.
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
  /** Admin MAX_CONCURRENT_RUNTIMES; <= 0 means "no count cap, the byte budget governs". */
  maxConcurrent?: number;
  /** Admin planning weights; <= 0 means auto-derive. */
  ddevWeightMb?: number;
  appWeightMb?: number;
  agentWeightMb?: number;
  browserWeightMb?: number;
  /** Admin AGENT_FLOOR; <= 0 means auto-derive. */
  agentFloor?: number;
}

export interface RuntimeCaps {
  /** --memory / --memory-swap (MB) per DDEV/app runner. A ceiling, not a claim. */
  perRunnerMemoryMb: number;
  /** --cpus per DDEV/app runner. */
  perRunnerCpus: number;
  /** --pids-limit per DDEV/app runner. */
  perRunnerPidsLimit: number;
  /** Admin-pinned cap on the NUMBER of live runtime runners, enforced alongside the byte
   *  budget. Null (the default) means only the budget governs — the previous auto-derived
   *  count is exactly what made every runtime cost a DDEV-sized slot. */
  maxConcurrentRuntimes: number | null;
  /** MB the runtime pool may commit across all live runners. */
  runtimeBudgetMb: number;
  /** Planning weight for a DDEV DinD runner WITHOUT the browser desktop: nested dockerd,
   *  web, db and router. Defaults to the per-runner ceiling minus the browser surcharge,
   *  since that ceiling was sized for a runner hosting Chromium too. */
  ddevWeightMb: number;
  /** Planning weight for an app-runner (the app image plus its dev server, no nested
   *  dockerd) without the browser desktop. */
  appWeightMb: number;
  /** Surcharge added when the task runs browser testing. Xvfb + x11vnc + headed Chromium
   *  run INSIDE the runner container (start-browser-desktop.sh), sharing its --memory cap,
   *  so they are not a separate pool entry — they make that one runner heavier. Charging it
   *  per task rather than to every runner is what lets browser-less environments pack
   *  tighter. */
  browserWeightMb: number;
  /** Planning weight for one cli-exec agent sandbox. */
  agentWeightMb: number;
  /** Agents that must stay runnable no matter how full the runtime pool is. A runtime
   *  holder needs an agent to finish its task, so a zero-agent state deadlocks. */
  agentFloor: number;
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

/** PROVISIONAL planning weight for the light consumers (app-runner, cli-exec agent
 *  sandbox) as a fraction of the per-runner ceiling. Neither runs a nested dockerd, so
 *  neither peaks anywhere near a DDEV DinD — but the exact figure is a placeholder until
 *  calibrated from `docker stats`. Chosen conservatively: half the ceiling keeps DDEV
 *  concurrency identical to the previous count-based governor. */
const LIGHT_WEIGHT_FRACTION = 0.5;

/** Never plan a consumer at less than this, however small the ceiling gets. */
const WEIGHT_FLOOR_MB = 512;

/** PROVISIONAL share of the per-runner ceiling attributed to the headed browser desktop
 *  (Xvfb + x11vnc + Chromium) when a task runs browser testing. The ceiling was sized for a
 *  DDEV DinD that ALSO hosts Chromium, so this is carved OUT of the ddev/app base weights:
 *  a browser-testing runner still totals the old full-ceiling weight, while one that never
 *  starts the desktop stops paying for it. */
const BROWSER_WEIGHT_FRACTION = 0.25;

/** Agents kept runnable regardless of runtime occupancy (deadlock floor). */
const DEFAULT_AGENT_FLOOR = 2;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** How many cli-exec agent sandboxes may run alongside what the runtime pool currently holds.
 *  One host budget, two consumers: agents get what the runtimes are not holding. Previously the
 *  two pools never reconciled — a fixed agent count ran regardless of how many DDEV runners were
 *  up, and refused to use the headroom when none were.
 *
 *  Bounded on three sides:
 *   - `agentFloor` from below, because a task holding a runtime needs an agent to finish it. Let
 *     agents reach zero and those runtimes never release: the pool deadlocks.
 *   - the free budget divided by the agent weight, which is the actual RAM argument.
 *   - `cpuCount`, because an agent is a full CLI process tree and more of them than cores is
 *     thrash no matter how much RAM is free.
 *  The floor yields to `cpuCount` only if a host has fewer cores than the floor — a hard limit
 *  stays hard. */
export function deriveAgentConcurrency(input: {
  caps: RuntimeCaps;
  /** MB the runtime pool commits right now (live runners + reservations + in-flight boots). */
  liveRuntimeWeightMb: number;
  cpuCount: number;
}): number {
  const freeMb = Math.max(0, input.caps.runtimeBudgetMb - Math.max(0, input.liveRuntimeWeightMb));
  const fits = Math.floor(freeMb / Math.max(1, input.caps.agentWeightMb));
  const ceiling = Math.max(1, Math.floor(input.cpuCount));
  return Math.min(ceiling, Math.max(input.caps.agentFloor, fits));
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

/** Derive per-runner ceilings, the runtime byte budget and the planning weights from host
 *  size. Pure. Any override <= 0 (or absent) auto-derives that field; a positive override
 *  wins as-is. On thin machines the budget admits fewer runners (keeping per-runner memory
 *  at a workable floor) rather than starving each runner below what DDEV needs. */
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
    ov.maxConcurrent && ov.maxConcurrent > 0 ? Math.floor(ov.maxConcurrent) : null;

  const lightWeightMb = Math.max(
    WEIGHT_FLOOR_MB,
    Math.round(perRunnerMemoryMb * LIGHT_WEIGHT_FRACTION),
  );
  const positive = (v: number | undefined, fallback: number): number =>
    v && v > 0 ? Math.floor(v) : fallback;
  const browserWeightMb = positive(
    ov.browserWeightMb,
    Math.round(perRunnerMemoryMb * BROWSER_WEIGHT_FRACTION),
  );

  return {
    perRunnerMemoryMb,
    perRunnerCpus,
    perRunnerPidsLimit: RUNNER_PIDS_LIMIT,
    maxConcurrentRuntimes,
    runtimeBudgetMb: budgetMb,
    browserWeightMb,
    ddevWeightMb: positive(
      ov.ddevWeightMb,
      Math.max(WEIGHT_FLOOR_MB, perRunnerMemoryMb - browserWeightMb),
    ),
    appWeightMb: positive(ov.appWeightMb, lightWeightMb),
    agentWeightMb: positive(ov.agentWeightMb, lightWeightMb),
    agentFloor: positive(ov.agentFloor, DEFAULT_AGENT_FLOOR),
  };
}
