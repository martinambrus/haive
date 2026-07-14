import { describe, it, expect } from 'vitest';
import { buildEstimationAccuracy, type EstimationDatum } from './estimation-accuracy.js';

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
