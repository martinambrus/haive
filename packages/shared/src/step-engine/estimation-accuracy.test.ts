import { describe, it, expect } from 'vitest';
import {
  buildEstimationAccuracy,
  recordedEstimateHours,
  type EstimationDatum,
} from './estimation-accuracy.js';

function datum(ai: number, actual: number, over: Partial<EstimationDatum> = {}): EstimationDatum {
  return {
    taskId: 't',
    title: 'title',
    completedAt: null,
    aiEstimatedHours: ai,
    confirmedHours: null,
    actualHours: actual,
    ...over,
  };
}

describe('buildEstimationAccuracy', () => {
  it('empty input -> zeroed summary, no rows', () => {
    const { rows, summary } = buildEstimationAccuracy([]);
    expect(rows).toEqual([]);
    expect(summary).toEqual({
      taskCount: 0,
      mapePct: 0,
      medianBiasFactor: null,
      underestimateCount: 0,
      overestimateCount: 0,
    });
  });

  it('computes signed/abs error and under vs over counts', () => {
    // ai 2, actual 4 -> signed (4-2)/4 = +50% (under-estimate).
    // ai 4, actual 2 -> signed (2-4)/2 = -100% (over-estimate).
    const { rows, summary } = buildEstimationAccuracy([datum(2, 4), datum(4, 2)]);
    expect(rows[0]!.signedErrorPct).toBe(50);
    expect(rows[0]!.absErrorPct).toBe(50);
    expect(rows[1]!.signedErrorPct).toBe(-100);
    expect(rows[1]!.absErrorPct).toBe(100);
    // MAPE = mean(50, 100) = 75.
    expect(summary.mapePct).toBe(75);
    expect(summary.underestimateCount).toBe(1);
    expect(summary.overestimateCount).toBe(1);
    // ratios actual/ai: 4/2=2, 2/4=0.5 -> median 1.25.
    expect(summary.medianBiasFactor).toBe(1.25);
  });

  it('drops data with a non-positive estimate or actual', () => {
    const { rows, summary } = buildEstimationAccuracy([
      datum(0, 4), // no estimate
      datum(2, 0), // no actual
      datum(2, 3), // usable
    ]);
    expect(rows).toHaveLength(1);
    expect(summary.taskCount).toBe(1);
  });

  it('counts an exact hit as neither under nor over', () => {
    const { summary } = buildEstimationAccuracy([datum(3, 3)]);
    expect(summary.underestimateCount).toBe(0);
    expect(summary.overestimateCount).toBe(0);
    expect(summary.mapePct).toBe(0);
    expect(summary.medianBiasFactor).toBe(1);
  });
});

describe('recordedEstimateHours', () => {
  const event = (taskId: string, aiHours: unknown, at: number) => ({
    taskId,
    payload: { aiHours },
    createdAt: new Date(at),
  });

  it.each([false, true])(
    'selects the latest event without caller sorting (reverse=%s)',
    (reverse) => {
      const events = [event('a', 3, 1), event('a', 6.5, 2), event('b', 4, 1)];
      expect(recordedEstimateHours(reverse ? events.reverse() : events)).toEqual(
        new Map([
          ['a', 6.5],
          ['b', 4],
        ]),
      );
    },
  );

  it.each(['6.5', 0, -1, NaN, Infinity, undefined])(
    'does not revive an older valid estimate when the latest aiHours is %s',
    (invalid) => {
      const events = [event('a', 6.5, 1), event('a', invalid, 2)];
      expect(recordedEstimateHours(events).has('a')).toBe(false);
      expect(recordedEstimateHours(events.reverse()).has('a')).toBe(false);
      expect(recordedEstimateHours([event('a', invalid, 2)]).has('a')).toBe(false);
    },
  );

  it('handles missing, null and malformed payloads and empty history', () => {
    expect(recordedEstimateHours([]).size).toBe(0);
    for (const payload of [null, {}, 'bad', [], 6.5]) {
      expect(recordedEstimateHours([{ taskId: 'a', payload, createdAt: new Date() }]).size).toBe(0);
    }
  });

  it('includes heuristic estimates', () => {
    expect(
      recordedEstimateHours([
        {
          taskId: 'a',
          payload: { aiHours: 2, source: 'heuristic' },
          createdAt: new Date(),
        },
      ]).get('a'),
    ).toBe(2);
  });
});
