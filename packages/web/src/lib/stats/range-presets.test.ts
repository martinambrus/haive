import { describe, expect, it } from 'vitest';
import {
  isRangePresetId,
  MAX_RANGE_DAYS,
  parseCustomRange,
  presetDays,
  presetIsRedundant,
  RANGE_PRESETS,
  resolvePreset,
  toDatetimeLocal,
} from './range-presets';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-06T12:00:00Z');

describe('resolvePreset', () => {
  it('ends at now and spans the preset length', () => {
    expect(resolvePreset('7d', NOW)).toEqual({ fromMs: NOW - 7 * DAY, toMs: NOW });
    expect(resolvePreset('30d', NOW)).toEqual({ fromMs: NOW - 30 * DAY, toMs: NOW });
    expect(resolvePreset('1y', NOW)).toEqual({ fromMs: NOW - 365 * DAY, toMs: NOW });
  });

  it('caps "all" at what the API will serve in one request', () => {
    // Not unbounded, and the label says so: the timeline endpoint fetches one row per
    // invocation across the window, and the API rejects anything longer with a 400.
    const all = resolvePreset('all', NOW);
    expect((all.toMs - all.fromMs) / DAY).toBe(MAX_RANGE_DAYS);
  });

  it('never produces a range the API would reject', () => {
    for (const p of RANGE_PRESETS) {
      if (p.id === 'custom') continue;
      const r = resolvePreset(p.id as Exclude<typeof p.id, 'custom'>, NOW);
      expect((r.toMs - r.fromMs) / DAY).toBeLessThanOrEqual(MAX_RANGE_DAYS);
      expect(r.fromMs).toBeLessThanOrEqual(r.toMs);
    }
  });
});

describe('presetDays', () => {
  it('reports a length for every preset except custom', () => {
    expect(presetDays('7d')).toBe(7);
    expect(presetDays('custom')).toBeNull();
  });
});

describe('presetIsRedundant', () => {
  it('marks a preset longer than the data itself', () => {
    // The live install is five days old, so every preset above 7d shows the same thing.
    const oldest = NOW - 5 * DAY;
    expect(presetIsRedundant('7d', oldest, NOW)).toBe(true);
    expect(presetIsRedundant('1y', oldest, NOW)).toBe(true);
  });

  it('leaves a preset the data actually fills alone', () => {
    const oldest = NOW - 200 * DAY;
    expect(presetIsRedundant('7d', oldest, NOW)).toBe(false);
    expect(presetIsRedundant('90d', oldest, NOW)).toBe(false);
    expect(presetIsRedundant('1y', oldest, NOW)).toBe(true);
  });

  it('never marks custom, and stays quiet when the span is unknown', () => {
    // An unknown span must not blank the picker; the presets stay offered.
    expect(presetIsRedundant('custom', NOW - 5 * DAY, NOW)).toBe(false);
    expect(presetIsRedundant('1y', null, NOW)).toBe(false);
  });
});

describe('parseCustomRange', () => {
  it('reads the two datetime-local values as local time', () => {
    // A person picking "2026-09-01 00:00" means midnight where they are, which is exactly what
    // `new Date('2026-09-01T00:00')` gives.
    const r = parseCustomRange('2026-09-01T00:00', '2026-09-06T00:00');
    expect(r).not.toBeNull();
    expect(r!.fromMs).toBe(new Date('2026-09-01T00:00').getTime());
    expect(r!.toMs).toBe(new Date('2026-09-06T00:00').getTime());
  });

  it('refuses a half-filled, inverted or unparseable range', () => {
    // Returning null lets the caller keep the previous range rather than firing a request the
    // API will answer with a 400 the user cannot act on.
    expect(parseCustomRange('', '2026-09-06T00:00')).toBeNull();
    expect(parseCustomRange('2026-09-06T00:00', '')).toBeNull();
    expect(parseCustomRange('2026-09-06T00:00', '2026-09-01T00:00')).toBeNull();
    expect(parseCustomRange('nonsense', '2026-09-06T00:00')).toBeNull();
  });

  it('refuses a range past the cap the API enforces', () => {
    expect(parseCustomRange('2020-01-01T00:00', '2026-09-06T00:00')).toBeNull();
  });

  it('accepts a zero-length range', () => {
    const r = parseCustomRange('2026-09-06T00:00', '2026-09-06T00:00');
    expect(r).not.toBeNull();
    expect(r!.toMs - r!.fromMs).toBe(0);
  });
});

describe('toDatetimeLocal', () => {
  it('round-trips through parseCustomRange without shifting by the offset', () => {
    // toISOString() would render UTC and move the value the user sees by their offset.
    const from = Date.parse('2026-09-01T08:30:00Z');
    const to = Date.parse('2026-09-06T17:45:00Z');
    const r = parseCustomRange(toDatetimeLocal(from), toDatetimeLocal(to));
    expect(r).not.toBeNull();
    // datetime-local has minute precision, so compare at that granularity.
    expect(Math.floor(r!.fromMs / 60000)).toBe(Math.floor(from / 60000));
    expect(Math.floor(r!.toMs / 60000)).toBe(Math.floor(to / 60000));
  });

  it('emits the shape a datetime-local input accepts', () => {
    expect(toDatetimeLocal(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('isRangePresetId', () => {
  it('accepts every offered preset and nothing else', () => {
    for (const p of RANGE_PRESETS) expect(isRangePresetId(p.id)).toBe(true);
    for (const bad of ['14d', '', null, undefined, 7]) expect(isRangePresetId(bad)).toBe(false);
  });
});
