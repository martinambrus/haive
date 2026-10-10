import { describe, expect, it } from 'vitest';
import { summarizeThroughput } from './throughput.js';

describe('summarizeThroughput', () => {
  it('divides summed tokens by summed time on each side', () => {
    const s = summarizeThroughput([
      { outputTokens: 100, wallMs: 4000, apiMs: 1000 },
      { outputTokens: 300, wallMs: 6000, apiMs: 3000 },
    ]);
    expect(s.wall.tps).toBe(40);
    expect(s.api.tps).toBe(100);
    expect(s.api.medianTps).toBe(100);
    expect(s.wall.n).toBe(2);
    expect(s.api.n).toBe(2);
  });

  it('keeps a run without model time on the wall side only', () => {
    const s = summarizeThroughput([
      { outputTokens: 100, wallMs: 1000, apiMs: 500 },
      { outputTokens: 900, wallMs: 9000, apiMs: null },
    ]);
    expect(s.wall).toMatchObject({ tps: 100, n: 2 });
    expect(s.api).toMatchObject({ tps: 200, n: 1 });
  });

  it('leaves out a run with no recorded usage on both sides', () => {
    const s = summarizeThroughput([{ outputTokens: null, wallMs: 1000, apiMs: 1000 }]);
    expect(s.wall).toEqual({ tps: null, n: 0, sufficient: false });
    expect(s.api).toEqual({ tps: null, medianTps: null, n: 0, sufficient: false });
  });

  it('skips a zero duration instead of dividing by it', () => {
    const s = summarizeThroughput([{ outputTokens: 50, wallMs: 0, apiMs: 0 }]);
    expect(s.wall.tps).toBeNull();
    expect(s.api.tps).toBeNull();
  });

  it('counts a run that produced no output as a zero rate, not as missing', () => {
    const s = summarizeThroughput([
      { outputTokens: 0, wallMs: 1000, apiMs: 1000 },
      { outputTokens: 100, wallMs: 1000, apiMs: 1000 },
    ]);
    expect(s.api.tps).toBe(50);
    expect(s.api.medianTps).toBe(50);
  });

  it('reports the median of per-run rates apart from the aggregate', () => {
    const s = summarizeThroughput([
      { outputTokens: 10, wallMs: 1000, apiMs: 1000 },
      { outputTokens: 20, wallMs: 1000, apiMs: 1000 },
      { outputTokens: 9000, wallMs: 100_000, apiMs: 100_000 },
    ]);
    expect(s.api.medianTps).toBe(20);
    expect(s.api.tps).toBeCloseTo((9030 / 102_000) * 1000);
  });

  it('flags a side as sufficient only from five runs', () => {
    const run = { outputTokens: 1, wallMs: 1, apiMs: 1 };
    expect(summarizeThroughput(Array(4).fill(run)).api.sufficient).toBe(false);
    expect(summarizeThroughput(Array(5).fill(run)).api.sufficient).toBe(true);
  });
});
