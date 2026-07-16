import { describe, it, expect } from 'vitest';
import { deriveRuntimeCaps, readHostResources } from './host-resources.js';

describe('deriveRuntimeCaps', () => {
  it('sizes a 16 GB / 16-CPU host conservatively', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });
    expect(caps).toEqual({
      perRunnerMemoryMb: 4096,
      perRunnerCpus: 4,
      perRunnerPidsLimit: 8192,
      maxConcurrentRuntimes: 2,
    });
  });

  it('allows one runner on an 8 GB host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 8192, cpuCount: 4 });
    expect(caps.perRunnerMemoryMb).toBe(4096);
    expect(caps.perRunnerCpus).toBe(2);
    expect(caps.maxConcurrentRuntimes).toBe(1);
  });

  it('scales up on a 32 GB host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 32768, cpuCount: 16 });
    expect(caps.maxConcurrentRuntimes).toBe(6);
    expect(caps.perRunnerCpus).toBe(4);
  });

  it('floors per-runner memory (never below what DDEV needs) on a tiny host', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 2048, cpuCount: 2 });
    expect(caps.perRunnerMemoryMb).toBe(1536);
    expect(caps.perRunnerCpus).toBe(1);
    expect(caps.maxConcurrentRuntimes).toBe(1);
  });

  it('always admits at least one runtime and one CPU', () => {
    const caps = deriveRuntimeCaps({ totalMemMb: 512, cpuCount: 1 });
    expect(caps.maxConcurrentRuntimes).toBeGreaterThanOrEqual(1);
    expect(caps.perRunnerCpus).toBeGreaterThanOrEqual(1);
    expect(caps.perRunnerMemoryMb).toBeGreaterThanOrEqual(1536);
  });

  it('honors a positive memory override and re-derives concurrency from it', () => {
    const caps = deriveRuntimeCaps({
      totalMemMb: 16384,
      cpuCount: 16,
      overrides: { memoryMb: 2048 },
    });
    expect(caps.perRunnerMemoryMb).toBe(2048);
    // budget (11469) / 2048 => 5 concurrent when per-runner is halved.
    expect(caps.maxConcurrentRuntimes).toBe(5);
  });

  it('honors positive cpu and maxConcurrent overrides verbatim', () => {
    const caps = deriveRuntimeCaps({
      totalMemMb: 16384,
      cpuCount: 16,
      overrides: { cpus: 8, maxConcurrent: 1 },
    });
    expect(caps.perRunnerCpus).toBe(8);
    expect(caps.maxConcurrentRuntimes).toBe(1);
  });

  it('treats zero/absent overrides as auto-derive', () => {
    const auto = deriveRuntimeCaps({ totalMemMb: 16384, cpuCount: 16 });
    const zeroed = deriveRuntimeCaps({
      totalMemMb: 16384,
      cpuCount: 16,
      overrides: { memoryMb: 0, cpus: 0, maxConcurrent: 0 },
    });
    expect(zeroed).toEqual(auto);
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
