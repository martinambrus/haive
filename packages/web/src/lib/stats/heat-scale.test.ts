import { describe, expect, it } from 'vitest';
import type { StatsTimelineDay } from '@/lib/api-client';
import {
  calendarMonths,
  heatStep,
  heatThresholds,
  heatValue,
  isHeatMetric,
  localDayRange,
  WEEKDAY_LABELS,
} from './heat-scale';

/** The real agent-hours series from the dev install, 2026-09-01..07, most recent first. */
const REAL_AGENT_HOURS = [44.76, 13.19, 15.87, 20.78, 16.36, 12.61, 8.35];

const day = (bucket: string, over: Partial<StatsTimelineDay> = {}): StatsTimelineDay => ({
  bucket,
  realUsd: 0,
  notionalUsd: 0,
  invocations: 0,
  agentMs: 0,
  busyMs: 0,
  tasksStarted: 0,
  tasksCompleted: 0,
  freshInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  ...over,
});

describe('heatValue', () => {
  it('reads each metric off the field the API already ships', () => {
    const d = day('2026-09-01', {
      agentMs: 3_600_000,
      invocations: 249,
      tasksCompleted: 4,
      realUsd: 1.5,
      notionalUsd: 8.5,
    });
    expect(heatValue(d, 'agent')).toBe(3_600_000);
    expect(heatValue(d, 'invocations')).toBe(249);
    expect(heatValue(d, 'completed')).toBe(4);
  });

  it('counts spend as billed plus counterfactual', () => {
    // On a flat plan the real figure is 0.00 and the whole cost of running the day is the
    // counterfactual, so a heatmap keyed on real spend alone would be blank on exactly the
    // installs the page exists for.
    const d = day('2026-09-01', { realUsd: 0, notionalUsd: 93.93 });
    expect(heatValue(d, 'spend')).toBe(93.93);
  });
});

describe('heatThresholds', () => {
  it('splits the worked days at observed values, not at fractions of the maximum', () => {
    // Nearest-rank quartiles of the measured week. Every cut point is a day that happened.
    expect(heatThresholds(REAL_AGENT_HOURS)).toEqual([12.61, 15.87, 20.78]);
  });

  it('ignores days on which nothing ran', () => {
    // A zero day is not the bottom quartile of anything, and letting zeros into the quantiles
    // would drag every cut point down until a quiet day rendered as a busy one.
    expect(heatThresholds([0, 0, 0, ...REAL_AGENT_HOURS])).toEqual([12.61, 15.87, 20.78]);
  });

  it('reports no thresholds at all when nothing ran in the window', () => {
    expect(heatThresholds([])).toEqual([]);
    expect(heatThresholds([0, 0, 0])).toEqual([]);
  });

  it('drops values that are not finite rather than propagating NaN through the ramp', () => {
    expect(heatThresholds([Number.NaN, 5, 5, 5, 5])).toEqual([5, 5, 5]);
  });
});

describe('heatStep', () => {
  const thresholds = heatThresholds(REAL_AGENT_HOURS);

  it('gives the busiest day the darkest step', () => {
    expect(heatStep(44.76, thresholds)).toBe(4);
  });

  it('spreads the measured week across the whole ramp', () => {
    // The point of quantiles over max-normalisation: dividing by 44.76 puts five of these
    // seven days under 0.37 and collapses them into one or two shades.
    expect(REAL_AGENT_HOURS.map((v) => heatStep(v, thresholds)).sort()).toEqual([
      1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  it('keeps "nothing ran" separate from the lowest worked step', () => {
    // Step 0 has its own colour. A day with no work and a day with the least work are
    // different claims and must not render as the same square.
    expect(heatStep(0, thresholds)).toBe(0);
    expect(heatStep(8.35, thresholds)).toBe(1);
  });

  it('treats a negative or non-finite value as no work rather than as an extreme', () => {
    expect(heatStep(-1, thresholds)).toBe(0);
    expect(heatStep(Number.NaN, thresholds)).toBe(0);
  });

  it('gives every worked day the same step when they all carry the same value', () => {
    // Uniformity is the invariant that matters here: two identical days rendering as two
    // different shades would be a bug, whereas all four reading as "the busiest day in this
    // window" is simply true.
    const flat = heatThresholds([3, 3, 3, 3]);
    expect([3, 3, 3, 3].map((v) => heatStep(v, flat))).toEqual([4, 4, 4, 4]);
  });

  it('still colours a worked day when the window has too few days to form quartiles', () => {
    expect(heatStep(1, [])).toBe(4);
  });
});

describe('isHeatMetric', () => {
  it('rejects anything that did not come from the metric list', () => {
    // It guards a URL parameter, so the input is whatever someone typed.
    expect(isHeatMetric('agent')).toBe(true);
    expect(isHeatMetric('tokens')).toBe(false);
    expect(isHeatMetric(null)).toBe(false);
  });
});

describe('calendarMonths', () => {
  it('lays a partial month out as a real calendar, not as a ragged run of squares', () => {
    const [sep] = calendarMonths(['2026-09-01', '2026-09-04', '2026-09-07']);
    expect(sep!.key).toBe('2026-09');
    // September 2026 has 30 days and the 1st is a Tuesday, so one Monday pad cell leads.
    expect(sep!.weeks[0]![0]).toEqual({ bucket: null, dayOfMonth: 0 });
    expect(sep!.weeks[0]![1]).toEqual({ bucket: '2026-09-01', dayOfMonth: 1 });
    // Every day of a touched month gets a cell, including the ones the window never covered —
    // the caller tells them apart by looking the bucket up in its own day map.
    const allDays = sep!.weeks.flat().filter((c) => c.bucket !== null);
    expect(allDays).toHaveLength(30);
  });

  it('emits whole weeks so a month block is a rectangle', () => {
    for (const month of calendarMonths(['2026-01-15', '2026-02-15', '2026-03-15'])) {
      for (const week of month.weeks) expect(week).toHaveLength(WEEKDAY_LABELS.length);
    }
  });

  it('orders months chronologically even when the buckets arrive unsorted', () => {
    const months = calendarMonths(['2026-11-02', '2026-09-30', '2026-10-01']);
    expect(months.map((m) => m.key)).toEqual(['2026-09', '2026-10', '2026-11']);
  });

  it('spans a year boundary without reordering it lexically wrong', () => {
    const months = calendarMonths(['2025-12-31', '2026-01-01']);
    expect(months.map((m) => m.key)).toEqual(['2025-12', '2026-01']);
  });

  it('gets February right in a leap year', () => {
    const [feb] = calendarMonths(['2028-02-01']);
    expect(feb!.weeks.flat().filter((c) => c.bucket !== null)).toHaveLength(29);
  });

  it('places a day correctly in a month containing a DST transition', () => {
    // Europe/Bratislava springs forward on 2026-03-29. The bucket key is already a local
    // calendar day, so the grid must place the 29th on its real weekday (a Sunday, the last
    // column of a Monday-first week) rather than letting an offset shift it.
    const [mar] = calendarMonths(['2026-03-29']);
    const cell = mar!.weeks.flat().find((c) => c.bucket === '2026-03-29');
    const week = mar!.weeks.find((w) => w.some((c) => c.bucket === '2026-03-29'))!;
    expect(cell!.dayOfMonth).toBe(29);
    expect(week.indexOf(cell!)).toBe(6);
  });

  it('returns nothing rather than an empty grid when there are no days', () => {
    expect(calendarMonths([])).toEqual([]);
  });

  it('ignores a malformed key instead of rendering a month named NaN', () => {
    expect(calendarMonths(['not-a-day'])).toEqual([]);
    expect(calendarMonths(['not-a-day', '2026-09-01']).map((m) => m.key)).toEqual(['2026-09']);
  });
});

describe('localDayRange', () => {
  const HOUR = 3_600_000;

  it('covers exactly 24 hours on an ordinary day', () => {
    const r = localDayRange('2026-09-04', 'Europe/Bratislava')!;
    expect(r.toMs - r.fromMs).toBe(24 * HOUR);
    // CEST is UTC+2, so the local day starts at 22:00 UTC the evening before.
    expect(new Date(r.fromMs).toISOString()).toBe('2026-09-03T22:00:00.000Z');
  });

  it('is 23 hours long on the day the clocks go forward', () => {
    // Europe/Bratislava springs forward at 02:00 local on 2026-03-29. A range built from a
    // single naive offset guess would be 24 hours here and would swallow an hour of the 30th.
    const r = localDayRange('2026-03-29', 'Europe/Bratislava')!;
    expect(r.toMs - r.fromMs).toBe(23 * HOUR);
  });

  it('is 25 hours long on the day the clocks go back', () => {
    const r = localDayRange('2026-10-25', 'Europe/Bratislava')!;
    expect(r.toMs - r.fromMs).toBe(25 * HOUR);
  });

  it('agrees with UTC when the zone is UTC', () => {
    // `longOffset` renders zero as a bare "GMT", so this is the case a naive parse gets wrong.
    const r = localDayRange('2026-09-04', 'UTC')!;
    expect(new Date(r.fromMs).toISOString()).toBe('2026-09-04T00:00:00.000Z');
    expect(new Date(r.toMs).toISOString()).toBe('2026-09-05T00:00:00.000Z');
  });

  it('rolls over a month and a year boundary', () => {
    expect(new Date(localDayRange('2026-12-31', 'UTC')!.toMs).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('returns nothing rather than a range built from NaN for a malformed key', () => {
    expect(localDayRange('not-a-day', 'UTC')).toBeNull();
  });
});
