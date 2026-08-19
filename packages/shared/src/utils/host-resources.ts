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
 * deriveRuntimeCaps and deriveAgentConcurrency are pure (no `node:os`, no `node:fs`) so the
 * sizing formulas are unit-testable; readHostResources and readHostAvailableMb are the impure
 * entry points.
 */
import fs from 'node:fs';
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

/** Baseline per-runner memory CEILING — the OOM-kill boundary, not a claim. Sized for the
 *  heaviest runner we measured: a DDEV DinD (nested dockerd + web + db + router) that ALSO
 *  hosts a headed Chromium, which peaked at 2505 MB. Never below the floor a real
 *  DDEV+Chromium boot needs (a tighter cap OOM-kills mid-boot). */
const DESIRED_RUNNER_MB = 4096;
const RUNNER_FLOOR_MB = 1536;

/** The ceiling SCALES with the host, because the biggest project one machine is asked to run
 *  grows with the machine. A flat 4096 meant a 128 GB box OOM-killed a project needing 6 GB
 *  exactly as a 16 GB box would — the one number that genuinely should track host size, since
 *  what a runner is ALLOWED to grow into is a property of the host, while what it typically
 *  occupies (its planning weight) is a property of the project.
 *
 *  One runner may be allowed up to this share of the pool: enough headroom for a fat project,
 *  still small enough that a single runaway container cannot eat the machine — which is what
 *  the cap exists to prevent. Bounded absolutely, because past ~16 GB in ONE runner the
 *  problem is the project, not the limit, and an admin override is the honest answer.
 *
 *  Note this widens the gap between planned (weight) and worst-case (cap) occupancy on big
 *  hosts. That gap is inherent to caps-vs-weights and already exists at 4096; a task that
 *  really needs the headroom should carry a per-task memoryLimitMb, which admission charges
 *  verbatim (resolveRuntimeWeightMb) instead of the class weight. */
const RUNNER_BUDGET_SHARE = 0.25;
const RUNNER_CEIL_MB = 16384;

/** Generous PID cap: a DinD daemon plus DDEV's containers plus Chromium fork heavily,
 *  so this guards against a runaway fork bomb without breaking normal operation. */
const RUNNER_PIDS_LIMIT = 8192;

/** Cap on auto-derived per-runner CPUs (a runner rarely needs more, and leaving cores
 *  for the host keeps it responsive). */
const RUNNER_CPU_CEIL = 4;

/* CALIBRATED planning weights (MB), from 1731 `docker stats` samples over 4 DDEV runners
 * and 52 cli-exec sandboxes on a 16 GB WSL2 host, covering cold boots, idle gates, agent
 * fix rounds and browser verification:
 *
 *   kind            mean    p90   peak     weight   margin over peak
 *   ddev (no browser) 666    972   1036       1536   1.5x   (peak includes a full cold boot)
 *   ddev + browser   1052   1612   2505       3072   1.2x   (base + surcharge)
 *   agent             831   1416   1736       2048   1.2x
 *
 * These are ABSOLUTE, not a fraction of the container cap, because a DDEV runner's real
 * footprint does not grow with host size — the same Drupal project uses ~1 GB on a 16 GB
 * box and on a 64 GB one. They are clamped to the cap below, since a container can never
 * occupy more than it is allowed.
 *
 * Two findings worth carrying: a cold `ddev start` peaks near 1 GB (image pulls are
 * disk-bound, not RAM-bound), and the browser flag is a PROXY rather than a cause — the
 * 2505 peak came from agent work during a fix round, not from Chromium being resident. The
 * surcharge holds because the desktop is up precisely during verify/fix phases.
 *
 * Re-calibrate by sampling `docker stats` per container kind and setting the admin
 * overrides; these defaults only apply when those are 0. */
const DDEV_WEIGHT_MB = 1536;
const BROWSER_WEIGHT_MB = 1536;
const AGENT_WEIGHT_MB = 2048;

/** App-runner: the ONE unmeasured weight — no app-runner was ever admitted during
 *  calibration. Set below the DDEV base deliberately: it runs the app image and its dev
 *  server with no nested dockerd, db or router, so it is strictly less machinery than the
 *  1036 MB a DDEV base peaked at. Treat as provisional. */
const APP_WEIGHT_MB = 1024;

/** Never plan a consumer at less than this, however small the ceiling gets. */
const WEIGHT_FLOOR_MB = 512;

/** Agents kept runnable regardless of runtime occupancy (deadlock floor). */
const DEFAULT_AGENT_FLOOR = 2;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** What the agent pool measures about the host, when measurement is available. Supplied by the
 *  caller so deriveAgentConcurrency stays pure. */
export interface AgentPoolMeasurement {
  /** MB the host can hand out without swapping, from readHostAvailableMb(). */
  availableMb: number;
  /** MB committed to runtime runners that do NOT exist yet — reservations for a boot in progress
   *  plus in-flight admissions. Live runners are deliberately excluded: their RSS is already
   *  missing from `availableMb`, while a reservation's is not, and an agent must not be handed
   *  headroom a DDEV is seconds away from taking. */
  pendingRuntimeMb: number;
  /** Agent sandboxes running right now. The anchor for both the headroom sum (measured WITH them
   *  resident) and the ramp. */
  liveAgents: number;
  /** Kept free for the base stack's own growth and for the running agents' climb toward their
   *  peak — the gap between the ~450 MB an agent occupies early and the 1736 MB one peaked at. */
  safetyMb: number;
  /** Most agents that may be ADDED per evaluation. */
  rampStep: number;
}

/** Agents added per evaluation when growing into measured headroom. Small on purpose: the pool is
 *  re-measured every 30s WITH the previously added agents resident, so growth stops itself the
 *  moment the headroom turns out to have been illusory. A big step would commit to a number the
 *  next measurement could only regret. */
export const DEFAULT_AGENT_RAMP_STEP = 2;

/** Auto-derived `safetyMb` for the measured path: a fifth of the host, bounded. A fraction rather
 *  than an absolute because what the base stack grows by scales with the machine, and bounded
 *  because a thin box cannot afford to reserve much and a fat one does not need to. */
export function deriveAgentSafetyMb(totalMemMb: number, override?: number): number {
  if (override && override > 0) return Math.floor(override);
  return clamp(Math.round(Math.max(0, totalMemMb) * 0.2), 2048, 4096);
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
 *  stays hard.
 *
 *  With `measured` supplied, the host's OWN free memory replaces the planned subtraction as the
 *  RAM authority, in BOTH directions. The planned figure is a difference of two peak-calibrated
 *  estimates and is wrong by a different factor at each end: MEASURED on a 16 GB dev host, three
 *  DDEV runners charged 9216 MB were occupying 2551, which starved the pool to its floor, while
 *  the base stack (a `next dev` server plus Ollama) overran its 30% reserve, which the planned
 *  figure cannot see at all. The agent weight stays the divisor — it is peak-safe, and being
 *  coarse (19% of a 16 GB budget) is precisely why the planned quantisation could not express the
 *  difference. Growth BEYOND the planned figure is capped at `rampStep` per evaluation so each
 *  step is re-measured with the previous one resident; shrinking is not capped, because a smaller
 *  cap only stops NEW jobs starting and never touches a running agent. */
export function deriveAgentConcurrency(input: {
  caps: RuntimeCaps;
  /** MB the runtime pool commits right now (live runners + reservations + in-flight boots). */
  liveRuntimeWeightMb: number;
  cpuCount: number;
  /** Live host measurement; absent (or null, when it cannot be read) keeps the planned-only
   *  behavior byte for byte. */
  measured?: AgentPoolMeasurement | null;
}): number {
  const freeMb = Math.max(0, input.caps.runtimeBudgetMb - Math.max(0, input.liveRuntimeWeightMb));
  const fits = Math.floor(freeMb / Math.max(1, input.caps.agentWeightMb));
  const ceiling = Math.max(1, Math.floor(input.cpuCount));
  const planned = Math.min(ceiling, Math.max(input.caps.agentFloor, fits));
  const m = input.measured;
  if (!m) return planned;

  const liveAgents = Math.max(0, Math.floor(m.liveAgents));
  const headroomMb = Math.max(
    0,
    m.availableMb - Math.max(0, m.safetyMb) - Math.max(0, m.pendingRuntimeMb),
  );
  const measuredFits = liveAgents + Math.floor(headroomMb / Math.max(1, input.caps.agentWeightMb));
  const target = Math.min(ceiling, Math.max(input.caps.agentFloor, measuredFits));
  // The ramp bounds growth BEYOND what the plan already allowed, not the plan itself: an idle
  // host used to start a fan-out at `planned` immediately, and making it climb there two at a
  // time would be a regression in the one case that was never broken. Clamping DOWN is never
  // ramped — a smaller cap only stops new jobs starting.
  const rampCeiling = Math.max(planned, liveAgents + Math.max(1, Math.floor(m.rampStep)));
  return Math.max(input.caps.agentFloor, Math.min(target, rampCeiling));
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

function readNumericFile(path: string): number | null {
  try {
    const parsed = Number.parseInt(fs.readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** MB this host can hand out right now without swapping, or null when it cannot be read (which
 *  turns the measured agent-pool path off rather than guessing).
 *
 *  `MemAvailable`, NOT `os.freemem()`: freemem is MemFree, which excludes the page cache the
 *  kernel would evict on demand — MEASURED on the dev host, 750 MB free against 7.9 GB actually
 *  available, i.e. using it would zero the measured term permanently. MemAvailable is the
 *  kernel's own estimate of the same question this function asks.
 *
 *  A cgroup memory limit wins when one is set below the host total, because `/proc/meminfo`
 *  reports the HOST even inside a capped container: a worker running under `--memory` would
 *  otherwise read headroom it is not allowed to use. Limit minus current usage understates the
 *  answer slightly (usage counts reclaimable page cache), which errs toward fewer agents. */
export function readHostAvailableMb(): number | null {
  const bytesToMb = (b: number): number => Math.floor(b / 1024 / 1024);
  const totalMb = bytesToMb(os.totalmem());

  // cgroup v2, then v1. An unlimited cgroup reports "max" (unparseable) or a sentinel far above
  // host RAM, so the `< totalMb` test rejects both without special-casing either.
  const limits: Array<[string, string]> = [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ];
  for (const [limitPath, usagePath] of limits) {
    const limit = readNumericFile(limitPath);
    if (limit === null) continue;
    const limitMb = bytesToMb(limit);
    if (limitMb <= 0 || limitMb >= totalMb) continue;
    const usage = readNumericFile(usagePath);
    if (usage === null) continue;
    return Math.max(0, limitMb - bytesToMb(usage));
  }

  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (!match) return null;
    return Math.floor(Number.parseInt(match[1]!, 10) / 1024);
  } catch {
    return null;
  }
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

  // Never below the baseline (a smaller ceiling OOM-kills a normal runner), never above a
  // quarter of the pool or the absolute ceiling, and never above the whole budget on a host
  // too thin to honour either.
  const perRunnerMemoryMb =
    ov.memoryMb && ov.memoryMb > 0
      ? Math.floor(ov.memoryMb)
      : clamp(
          Math.max(DESIRED_RUNNER_MB, Math.round(budgetMb * RUNNER_BUDGET_SHARE)),
          RUNNER_FLOOR_MB,
          Math.min(budgetMb, RUNNER_CEIL_MB),
        );

  const perRunnerCpus =
    ov.cpus && ov.cpus > 0 ? ov.cpus : clamp(Math.floor(cpuCount / 2), 1, RUNNER_CPU_CEIL);

  const maxConcurrentRuntimes =
    ov.maxConcurrent && ov.maxConcurrent > 0 ? Math.floor(ov.maxConcurrent) : null;

  const positive = (v: number | undefined, fallback: number): number =>
    v && v > 0 ? Math.floor(v) : fallback;
  // A container cannot occupy more than its own --memory cap, so no weight may exceed it.
  // This only binds on a thin host where the cap itself was clamped down to the budget.
  const withinCap = (mb: number): number =>
    clamp(mb, Math.min(WEIGHT_FLOOR_MB, perRunnerMemoryMb), perRunnerMemoryMb);

  const ddevWeightMb = positive(ov.ddevWeightMb, withinCap(DDEV_WEIGHT_MB));
  // The desktop runs INSIDE the runner and shares its cap, so base + surcharge is bounded by
  // that cap too — charging more than a container can hold would park tasks against capacity
  // that could never be used.
  const browserWeightMb = positive(
    ov.browserWeightMb,
    Math.max(0, Math.min(BROWSER_WEIGHT_MB, perRunnerMemoryMb - ddevWeightMb)),
  );

  return {
    perRunnerMemoryMb,
    perRunnerCpus,
    perRunnerPidsLimit: RUNNER_PIDS_LIMIT,
    maxConcurrentRuntimes,
    runtimeBudgetMb: budgetMb,
    browserWeightMb,
    ddevWeightMb,
    appWeightMb: positive(ov.appWeightMb, withinCap(APP_WEIGHT_MB)),
    agentWeightMb: positive(ov.agentWeightMb, withinCap(AGENT_WEIGHT_MB)),
    agentFloor: positive(ov.agentFloor, DEFAULT_AGENT_FLOOR),
  };
}
