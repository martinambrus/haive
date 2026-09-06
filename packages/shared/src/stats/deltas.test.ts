import { describe, expect, it } from 'vitest';
import {
  computeDelta,
  hasEnoughSamples,
  MIN_SAMPLES_FOR_TREND,
  previousWindow,
  sampledRatio,
} from './deltas.js';

describe('computeDelta', () => {
  it('reports the ratio and the direction for an ordinary comparison', () => {
    expect(computeDelta(150, 100)).toEqual({
      current: 150,
      previous: 100,
      changeRatio: 0.5,
      direction: 'up',
    });
    expect(computeDelta(75, 100).changeRatio).toBe(-0.25);
    expect(computeDelta(75, 100).direction).toBe('down');
  });

  it('reports no ratio when there is no baseline, but still reports the direction', () => {
    // Growth from zero is not "infinite percent" and not "+100%". It has no ratio; the
    // direction is the only honest thing to render.
    const d = computeDelta(42, 0);
    expect(d.changeRatio).toBeNull();
    expect(d.direction).toBe('up');
  });

  it('calls an unchanged figure flat, including zero against zero', () => {
    expect(computeDelta(100, 100).direction).toBe('flat');
    expect(computeDelta(100, 100).changeRatio).toBe(0);
    expect(computeDelta(0, 0)).toMatchObject({ direction: 'flat', changeRatio: null });
  });

  it('handles a drop to zero, which does have a ratio', () => {
    expect(computeDelta(0, 80)).toMatchObject({ changeRatio: -1, direction: 'down' });
  });

  it('coerces a non-finite input to zero rather than propagating NaN into a tile', () => {
    expect(computeDelta(Number.NaN, 10).current).toBe(0);
    expect(computeDelta(10, Number.NaN)).toMatchObject({ previous: 0, changeRatio: null });
  });
});

describe('previousWindow', () => {
  it('returns the equal-length window ending where the current one begins', () => {
    // Equal LENGTH, not "the previous calendar month": comparing 31 days against 28 reports a
    // 10% swing that is nothing but the calendar.
    const from = Date.parse('2026-09-01T00:00:00Z');
    const to = Date.parse('2026-09-11T00:00:00Z');
    const prev = previousWindow({ fromMs: from, toMs: to });
    expect(prev.toMs).toBe(from);
    expect(prev.toMs - prev.fromMs).toBe(to - from);
    expect(new Date(prev.fromMs).toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });

  it('is a no-op window for a zero-length or inverted range', () => {
    const at = Date.parse('2026-09-01T00:00:00Z');
    expect(previousWindow({ fromMs: at, toMs: at })).toEqual({ fromMs: at, toMs: at });
    // An inverted range clamps to zero span rather than producing a window in the future.
    const inverted = previousWindow({ fromMs: at, toMs: at - 1000 });
    expect(inverted.toMs).toBe(at);
    expect(inverted.fromMs).toBe(at);
  });
});

describe('sampledRatio', () => {
  it('carries the sample count alongside the ratio', () => {
    const r = sampledRatio(3, 10);
    expect(r).toEqual({ ratio: 0.3, n: 10, sufficient: true });
  });

  it('marks a ratio built from too few observations as insufficient', () => {
    // The live install's real shape: 1 review finding. "100% of findings were critical" from
    // one row reads exactly like it does from a thousand.
    const r = sampledRatio(1, 1);
    expect(r.ratio).toBe(1);
    expect(r.sufficient).toBe(false);
    expect(r.n).toBe(1);
  });

  it('keeps the ratio available even when under-sampled', () => {
    // A tooltip or an export may still want the number; only the headline gates on it.
    expect(sampledRatio(1, 2).ratio).toBe(0.5);
  });

  it('reports no ratio for an empty denominator', () => {
    expect(sampledRatio(0, 0)).toEqual({ ratio: null, n: 0, sufficient: false });
    expect(sampledRatio(5, -1)).toMatchObject({ ratio: null, n: 0 });
  });

  it('honours a caller-supplied threshold', () => {
    expect(sampledRatio(1, 3, 2).sufficient).toBe(true);
    expect(sampledRatio(1, 3, 50).sufficient).toBe(false);
  });
});

describe('hasEnoughSamples', () => {
  it('gates exactly at the threshold', () => {
    expect(hasEnoughSamples(MIN_SAMPLES_FOR_TREND - 1)).toBe(false);
    expect(hasEnoughSamples(MIN_SAMPLES_FOR_TREND)).toBe(true);
    expect(hasEnoughSamples(Number.NaN)).toBe(false);
  });
});
