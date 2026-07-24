import { describe, it, expect } from 'vitest';
import {
  deriveAgentConcurrency,
  deriveRuntimeCaps,
  readHostResources,
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

describe('readHostResources', () => {
  it('returns positive finite memory and cpu figures', () => {
    const h = readHostResources();
    expect(h.totalMemMb).toBeGreaterThan(0);
    expect(h.freeMemMb).toBeGreaterThanOrEqual(0);
    expect(h.cpuCount).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(h.totalMemMb)).toBe(true);
  });
});
