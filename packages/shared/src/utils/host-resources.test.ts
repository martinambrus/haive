import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_RAMP_STEP,
  deriveAgentConcurrency,
  deriveAgentSafetyMb,
  deriveRuntimeCaps,
  readHostAvailableMb,
  readHostResources,
  type AgentPoolMeasurement,
  type RuntimeCaps,
} from './host-resources.js';

/** How many runners of one weight class the budget admits — the number the old
 *  maxConcurrentRuntimes used to state for every class at once. */
function admits(caps: RuntimeCaps, weightMb: number): number {
  return Math.floor(caps.runtimeBudgetMb / weightMb);
}

describe('deriveRuntimeCaps', () => {
  it('sizes a 16 GB / 16-CPU host from the calibrated weights', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });
    expect(caps).toEqual({
      perRunnerMemoryMb: 4096,
      perRunnerCpus: 4,
      perRunnerPidsLimit: 8192,
      maxConcurrentRuntimes: null,
      runtimeBudgetMb: 11469,
      ddevWeightMb: 1536,
      appWeightMb: 1024,
      agentWeightMb: 2048,
      browserWeightMb: 1536,
      agentFloor: 2,
    });
    // Measured: a DDEV in a browser-verification phase peaked at 2505 MB, so 3072 covers it
    // with ~1.2x margin and three fit where the old count-based governor allowed two.
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(3);
    // A DDEV that never starts the desktop peaked at 1036 MB including a full cold boot.
    expect(admits(caps, caps.ddevWeightMb)).toBe(7);
    expect(admits(caps, caps.appWeightMb)).toBe(11);
  });

  it('keeps base + browser within the container cap, since the desktop runs inside it', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });
    expect(caps.ddevWeightMb + caps.browserWeightMb).toBeLessThanOrEqual(caps.perRunnerMemoryMb);
  });

  it('allows one browser-phase DDEV runner on an 8 GB host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 8192, cpuCount: 4 });
    expect(caps.perRunnerMemoryMb).toBe(4096);
    expect(caps.perRunnerCpus).toBe(2);
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(1);
    expect(admits(caps, caps.ddevWeightMb)).toBe(3);
  });

  it('scales up on a 32 GB host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 32768, cpuCount: 16 });
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(8);
    expect(admits(caps, caps.ddevWeightMb)).toBe(17);
    expect(caps.perRunnerCpus).toBe(4);
  });

  it('grows the per-runner CEILING with the host, leaving the weights alone', () => {
    // What a runner may grow into is a property of the HOST (a bigger box is asked to run
    // bigger projects); what it typically occupies is a property of the project. So the cap
    // scales and the weights do not — a flat cap made a 128 GB box OOM-kill a 6 GB project
    // exactly as a 16 GB box would.
    const caps = [4, 8, 16, 32, 64, 128].map((gb) =>
      deriveRuntimeCaps({ totalMemMb: gb * 1024, cpuCount: 16 }),
    );
    expect(caps.map((c) => c.perRunnerMemoryMb)).toEqual([2048, 4096, 4096, 6656, 14848, 16384]);
    // Hosts at or below 16 GB are untouched by the change, and no weight moved with the cap.
    expect(caps.every((c) => c.ddevWeightMb === 1536)).toBe(true);
    expect(caps.every((c) => c.agentWeightMb === 2048 || c.perRunnerMemoryMb < 2048)).toBe(true);
  });

  it('never lets one runner’s ceiling exceed the pool it is drawn from', () => {
    for (const gb of [1, 2, 4, 8, 16, 64]) {
      const caps = deriveRuntimeCaps({ totalMemMb: gb * 1024, cpuCount: 4 });
      expect(caps.perRunnerMemoryMb).toBeLessThanOrEqual(caps.runtimeBudgetMb);
      expect(caps.perRunnerMemoryMb).toBeLessThanOrEqual(16384);
    }
  });

  it('never charges a weight the container cap could not hold', () => {
    // Thin host: the cap itself clamps to the runner floor, so every weight clamps with it
    // and the browser surcharge collapses to zero rather than pushing past the cap.
    const caps = deriveRuntimeCaps({ totalMemMb: 2048, cpuCount: 2 });
    expect(caps.perRunnerMemoryMb).toBe(1536);
    expect(caps.ddevWeightMb).toBe(1536);
    expect(caps.browserWeightMb).toBe(0);
    expect(caps.agentWeightMb).toBeLessThanOrEqual(caps.perRunnerMemoryMb);
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(1);
  });

  it('floors per-runner memory (never below what DDEV needs) on a tiny host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 2048, cpuCount: 2 });
    expect(caps.perRunnerMemoryMb).toBe(1536);
    expect(caps.perRunnerCpus).toBe(1);
  });

  it('always leaves room for one runtime, one CPU and a weight floor', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 512, cpuCount: 1 });
    expect(admits(caps, caps.ddevWeightMb)).toBeGreaterThanOrEqual(1);
    expect(caps.ddevWeightMb).toBeGreaterThanOrEqual(512);
    expect(caps.perRunnerCpus).toBeGreaterThanOrEqual(1);
    expect(caps.perRunnerMemoryMb).toBeGreaterThanOrEqual(1536);
    expect(caps.agentWeightMb).toBeGreaterThanOrEqual(512);
  });

  it('leaves the calibrated weights alone until the cap drops below them', () => {
    // Weights are absolute (a DDEV project uses the same RAM on any host), so lowering the
    // per-container cap only matters where it would charge more than the container can hold:
    // here the browser surcharge is squeezed to what is left under a 2048 cap.
    const caps = deriveRuntimeCaps({
      totalMemMb: 16384,
      cpuCount: 16,
      overrides: { memoryMb: 2048 },
    });
    expect(caps.perRunnerMemoryMb).toBe(2048);
    expect(caps.ddevWeightMb).toBe(1536);
    expect(caps.browserWeightMb).toBe(512);
    expect(caps.appWeightMb).toBe(1024);
    expect(caps.agentWeightMb).toBe(2048);
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(5);
  });

  it('honors positive cpu / count-cap / weight overrides verbatim', () => {
    const caps = deriveRuntimeCaps({
      totalMemMb: 16384,
      cpuCount: 16,
      overrides: { cpus: 8, maxConcurrent: 1, ddevWeightMb: 3000, agentWeightMb: 700 },
    });
    expect(caps.perRunnerCpus).toBe(8);
    expect(caps.maxConcurrentRuntimes).toBe(1);
    expect(caps.ddevWeightMb).toBe(3000);
    expect(caps.agentWeightMb).toBe(700);
    // The pinned count cap does not move the budget — both are enforced.
    expect(caps.runtimeBudgetMb).toBe(11469);
  });

  it('leaves the count cap off by default so only the budget governs', () => {
    expect(deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 }).maxConcurrentRuntimes).toBeNull();
  });

  it('treats zero/absent overrides as auto-derive', () => {
    const auto = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });
    const zeroed = deriveRuntimeCaps({
      totalMemMb: 16384,
      cpuCount: 16,
      overrides: {
        memoryMb: 0,
        cpus: 0,
        maxConcurrent: 0,
        ddevWeightMb: 0,
        appWeightMb: 0,
        agentWeightMb: 0,
        browserWeightMb: 0,
        agentFloor: 0,
      },
    });
    expect(zeroed).toEqual(auto);
  });
});

describe('deriveAgentConcurrency', () => {
  const caps = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });

  it('uses the headroom when no runtime is up', () => {
    // 11469 / 2048 = 5 — more than the fixed 3 the agent pool used to run at regardless.
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 0, cpuCount: 16 })).toBe(5);
  });

  it('shrinks as the runtime pool fills', () => {
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 4096, cpuCount: 16 })).toBe(3);
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 8192, cpuCount: 16 })).toBe(2);
  });

  it('never starves agents to zero, however full the pool is', () => {
    // A task holding a runtime needs an agent to finish it — zero agents deadlocks the pool.
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 11469, cpuCount: 16 })).toBe(
      caps.agentFloor,
    );
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 999_999, cpuCount: 16 })).toBe(
      caps.agentFloor,
    );
  });

  it('bounds by cores as well as RAM', () => {
    // An agent is a full CLI process tree; more of them than cores is thrash whatever the
    // free memory says.
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 0, cpuCount: 2 })).toBe(2);
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 0, cpuCount: 1 })).toBe(1);
  });
});

describe('deriveAgentConcurrency with a live measurement', () => {
  const caps = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });
  /** The jam this exists for: three DDEV runners charged 3072 each leave 1725 MB planned free,
   *  which floors the pool at 2 while the host really has ~7.9 GB available. */
  const JAMMED = 9216;
  const measure = (over: Partial<AgentPoolMeasurement> = {}): AgentPoolMeasurement => ({
    availableMb: 7900,
    pendingRuntimeMb: 0,
    liveAgents: 2,
    safetyMb: 3072,
    rampStep: DEFAULT_AGENT_RAMP_STEP,
    ...over,
  });

  it('grows past the planned floor when the host really is free', () => {
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: JAMMED, cpuCount: 16 })).toBe(
      caps.agentFloor,
    );
    // (7900 - 3072) / 2048 = 2 more than the 2 already running.
    expect(
      deriveAgentConcurrency({
        caps,
        liveRuntimeWeightMb: JAMMED,
        cpuCount: 16,
        measured: measure(),
      }),
    ).toBe(4);
  });

  it('adds at most rampStep per evaluation beyond what the plan already allowed', () => {
    // Planned on an idle 16 GB host is 5. Measured headroom would fit 11, but growth past the
    // plan is two at a time so each step is re-measured with the previous one resident.
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 0, cpuCount: 16 })).toBe(5);
    expect(
      deriveAgentConcurrency({
        caps,
        liveRuntimeWeightMb: 0,
        cpuCount: 16,
        measured: measure({ availableMb: 20_000, liveAgents: 5, rampStep: 2 }),
      }),
    ).toBe(7);
  });

  it('never starts a burst below what the plan alone would have allowed', () => {
    // The one case that was never broken: an idle host with capacity to spare used to open the
    // whole planned width at once, and ramping up to it two at a time would be a regression.
    expect(
      deriveAgentConcurrency({
        caps,
        liveRuntimeWeightMb: 0,
        cpuCount: 16,
        measured: measure({ availableMb: 20_000, liveAgents: 0, rampStep: 2 }),
      }),
    ).toBe(5);
  });

  it('clamps DOWN when the host is tighter than the plan believes', () => {
    // The dev-host case: nothing in the runtime pool, so the planned figure says 5, while the
    // base stack has already eaten the machine. Measurement is authoritative in both directions.
    expect(deriveAgentConcurrency({ caps, liveRuntimeWeightMb: 0, cpuCount: 16 })).toBe(5);
    expect(
      deriveAgentConcurrency({
        caps,
        liveRuntimeWeightMb: 0,
        cpuCount: 16,
        measured: measure({ availableMb: 3500, liveAgents: 5 }),
      }),
    ).toBe(5);
    expect(
      deriveAgentConcurrency({
        caps,
        liveRuntimeWeightMb: 0,
        cpuCount: 16,
        measured: measure({ availableMb: 3000, liveAgents: 0 }),
      }),
    ).toBe(caps.agentFloor);
  });

  it('never hands an agent the headroom a reserved boot is about to take', () => {
    // A live runner's RSS is already missing from availableMb; a reservation's is not.
    expect(
      deriveAgentConcurrency({
        caps,
        liveRuntimeWeightMb: JAMMED,
        cpuCount: 16,
        measured: measure({ pendingRuntimeMb: 3072 }),
      }),
    ).toBe(caps.agentFloor);
  });

  it('keeps the deadlock floor whatever the measurement says', () => {
    expect(
      deriveAgentConcurrency({
        caps,
        liveRuntimeWeightMb: JAMMED,
        cpuCount: 16,
        measured: measure({ availableMb: 0, liveAgents: 0 }),
      }),
    ).toBe(caps.agentFloor);
  });

  it('still bounds by cores', () => {
    expect(
      deriveAgentConcurrency({
        caps,
        liveRuntimeWeightMb: 0,
        cpuCount: 2,
        measured: measure({ availableMb: 64_000, liveAgents: 8, rampStep: 8 }),
      }),
    ).toBe(2);
  });
});

describe('deriveAgentSafetyMb', () => {
  it('reserves a fifth of the host, bounded at both ends', () => {
    expect(deriveAgentSafetyMb(16384)).toBe(3277);
    expect(deriveAgentSafetyMb(4096)).toBe(2048); // thin box: the floor binds
    expect(deriveAgentSafetyMb(131_072)).toBe(4096); // fat box: the ceiling binds
  });

  it('honours a positive override as-is', () => {
    expect(deriveAgentSafetyMb(16384, 6000)).toBe(6000);
    expect(deriveAgentSafetyMb(16384, 0)).toBe(3277);
  });
});

describe('readHostResources', () => {
  it('returns positive finite memory and cpu figures', () => {
    const h = readHostResources();
    expect(h.totalMemMb).toBeGreaterThan(0);
    expect(h.freeMemMb).toBeGreaterThanOrEqual(0);
    expect(h.cpuCount).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(h.totalMemMb)).toBe(true);
  });
});

describe('readHostAvailableMb', () => {
  it('reads more than MemFree on a Linux host, or null where it cannot', () => {
    const available = readHostAvailableMb();
    if (available === null) return; // non-Linux: the measured path stays off
    expect(available).toBeGreaterThanOrEqual(0);
    expect(available).toBeLessThanOrEqual(readHostResources().totalMemMb);
  });
});
