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
  it('sizes a 16 GB / 16-CPU host conservatively', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });
    expect(caps).toEqual({
      perRunnerMemoryMb: 4096,
      perRunnerCpus: 4,
      perRunnerPidsLimit: 8192,
      maxConcurrentRuntimes: null,
      runtimeBudgetMb: 11469,
      ddevWeightMb: 3072,
      appWeightMb: 2048,
      agentWeightMb: 2048,
      browserWeightMb: 1024,
      agentFloor: 2,
    });
    // Same two DDEV runners as the previous count-based governor when they run the browser
    // desktop — the ceiling that governor divided by was sized for exactly that.
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(2);
    // A DDEV that never starts Chromium stops paying for it...
    expect(admits(caps, caps.ddevWeightMb)).toBe(3);
    // ...and a light runner no longer costs a DDEV-sized slot at all.
    expect(admits(caps, caps.appWeightMb)).toBe(5);
  });

  it('carves the browser surcharge out of the ddev weight, never adds to the ceiling', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });
    expect(caps.ddevWeightMb + caps.browserWeightMb).toBe(caps.perRunnerMemoryMb);
  });

  it('allows one DDEV runner on an 8 GB host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 8192, cpuCount: 4 });
    expect(caps.perRunnerMemoryMb).toBe(4096);
    expect(caps.perRunnerCpus).toBe(2);
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(1);
    expect(admits(caps, caps.appWeightMb)).toBe(2);
  });

  it('scales up on a 32 GB host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 32768, cpuCount: 16 });
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(6);
    expect(admits(caps, caps.ddevWeightMb)).toBe(8);
    expect(caps.perRunnerCpus).toBe(4);
  });

  it('floors per-runner memory (never below what DDEV needs) on a tiny host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 2048, cpuCount: 2 });
    expect(caps.perRunnerMemoryMb).toBe(1536);
    expect(caps.perRunnerCpus).toBe(1);
    expect(admits(caps, caps.ddevWeightMb + caps.browserWeightMb)).toBe(1);
  });

  it('always leaves room for one runtime, one CPU and a weight floor', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 512, cpuCount: 1 });
    expect(admits(caps, caps.ddevWeightMb)).toBeGreaterThanOrEqual(1);
    expect(caps.ddevWeightMb).toBeGreaterThanOrEqual(512);
    expect(caps.perRunnerCpus).toBeGreaterThanOrEqual(1);
    expect(caps.perRunnerMemoryMb).toBeGreaterThanOrEqual(1536);
    expect(caps.agentWeightMb).toBeGreaterThanOrEqual(512);
  });

  it('derives the ddev weight from the ceiling, so a memory override moves both', () => {
    const caps = deriveRuntimeCaps({
      totalMemMb: 16384,
      cpuCount: 16,
      overrides: { memoryMb: 2048 },
    });
    expect(caps.perRunnerMemoryMb).toBe(2048);
    expect(caps.ddevWeightMb).toBe(1536);
    expect(caps.browserWeightMb).toBe(512);
    expect(caps.appWeightMb).toBe(1024);
    // budget (11469) / 2048 => 5 browser-testing runners when per-runner is halved.
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
