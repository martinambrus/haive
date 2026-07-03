import { describe, expect, it } from 'vitest';
import {
  maxConsumedPct,
  constrainingResetAt,
  allowanceVerdict,
  RECOVERED_PCT,
  type UsageWindows,
} from './allowance-watch.js';

const win = (o: Partial<UsageWindows> = {}): UsageWindows => ({
  fiveHourPct: null,
  fiveHourResetAt: null,
  sevenDayPct: null,
  sevenDayResetAt: null,
  dailyPct: null,
  dailyResetAt: null,
  ...o,
});

describe('maxConsumedPct', () => {
  it('returns the max across exposed windows', () => {
    expect(maxConsumedPct(win({ fiveHourPct: 30, sevenDayPct: 95, dailyPct: 10 }))).toBe(95);
  });
  it('ignores null windows', () => {
    expect(maxConsumedPct(win({ fiveHourPct: 42 }))).toBe(42);
  });
  it('returns null when no window is exposed', () => {
    expect(maxConsumedPct(win())).toBeNull();
  });
});

describe('constrainingResetAt', () => {
  const t5 = new Date('2026-07-03T05:00:00Z');
  const t7 = new Date('2026-07-10T00:00:00Z');
  it('picks the LATEST reset among windows at/over EXHAUSTED_PCT (blocked until the later one)', () => {
    const r = constrainingResetAt(
      win({ fiveHourPct: 100, fiveHourResetAt: t5, sevenDayPct: 96, sevenDayResetAt: t7 }),
    );
    expect(r).toEqual(t7);
  });
  it('ignores windows below EXHAUSTED_PCT', () => {
    const r = constrainingResetAt(
      win({ fiveHourPct: 100, fiveHourResetAt: t5, sevenDayPct: 40, sevenDayResetAt: t7 }),
    );
    expect(r).toEqual(t5);
  });
  it('returns null when no window is exhausted', () => {
    expect(constrainingResetAt(win({ fiveHourPct: 50, fiveHourResetAt: t5 }))).toBeNull();
  });
  it('returns null when the exhausted window exposes no reset (e.g. zai)', () => {
    expect(constrainingResetAt(win({ fiveHourPct: 100, fiveHourResetAt: null }))).toBeNull();
  });
});

describe('allowanceVerdict', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  it('reports back via reset once the captured reset has passed (authoritative)', () => {
    const v = allowanceVerdict({
      resetAt: new Date(now - 1000),
      windows: win({ fiveHourPct: 100 }),
      snapshotOk: true,
      now,
    });
    expect(v).toEqual({ back: true, via: 'reset' });
  });
  it('reports back via usage_dropped when max consumed falls below RECOVERED_PCT', () => {
    const v = allowanceVerdict({
      resetAt: null,
      windows: win({ fiveHourPct: RECOVERED_PCT - 1 }),
      snapshotOk: true,
      now,
    });
    expect(v).toEqual({ back: true, via: 'usage_dropped' });
  });
  it('is not back while the reset is in the future and usage stays high', () => {
    const v = allowanceVerdict({
      resetAt: new Date(now + 3_600_000),
      windows: win({ fiveHourPct: 99 }),
      snapshotOk: true,
      now,
    });
    expect(v).toEqual({ back: false });
  });
  it('ignores the %-path on a non-ok snapshot but still honours a passed reset', () => {
    const stale = allowanceVerdict({
      resetAt: null,
      windows: win({ fiveHourPct: 10 }),
      snapshotOk: false,
      now,
    });
    expect(stale).toEqual({ back: false });
    const reset = allowanceVerdict({
      resetAt: new Date(now - 1),
      windows: win({ fiveHourPct: 99 }),
      snapshotOk: false,
      now,
    });
    expect(reset).toEqual({ back: true, via: 'reset' });
  });
  it('is not back when nothing is known (no reset, no windows)', () => {
    expect(allowanceVerdict({ resetAt: null, windows: null, snapshotOk: true, now })).toEqual({
      back: false,
    });
  });
});
