import { describe, it, expect } from 'vitest';
import {
  computeBiasFactor,
  cosineSim,
  effortHoursFromSteps,
  estimateRange,
  heuristicEstimate,
  overlapRefinedEstimate,
  type EstimateAnchor,
} from './_estimate.js';
import type { TaskTimingStep } from '@haive/shared/timing';

function anchor(effortHours: number, over: Partial<EstimateAnchor> = {}): EstimateAnchor {
  return {
    title: 't',
    description: 'd',
    executionPath: null,
    fixRounds: 0,
    effortHours,
    aiEstimateHours: null,
    confirmedEstimateHours: null,
    changedPaths: [],
    crossRepo: false,
    ...over,
  };
}

describe('effortHoursFromSteps', () => {
  it('sums work + user-active across steps into hours (idle excluded)', () => {
    const steps: TaskTimingStep[] = [
      // 1h of pure work.
      {
        startedAt: new Date(0),
        endedAt: new Date(3_600_000),
        idleMs: 0,
        userActiveMs: 0,
        waitingStartedAt: null,
        status: 'done',
      },
      // 30m span that was all idle, but 30m of user-active time at the gate.
      {
        startedAt: new Date(10_000_000),
        endedAt: new Date(11_800_000),
        idleMs: 1_800_000,
        userActiveMs: 1_800_000,
        waitingStartedAt: null,
        status: 'done',
      },
    ];
    // work 1h + user-active 0.5h = 1.5h; the idle 0.5h is excluded.
    expect(effortHoursFromSteps(steps, 20_000_000)).toBe(1.5);
  });

  it('a task with no steps has zero effort', () => {
    expect(effortHoursFromSteps([], 1)).toBe(0);
  });
});

describe('heuristicEstimate', () => {
  it('no anchors -> per-path cold-start baseline', () => {
    expect(heuristicEstimate([], 'quick_bugfix').hours).toBe(0.5);
    expect(heuristicEstimate([], 'plan_tasklist').hours).toBe(2);
    expect(heuristicEstimate([], 'full_workflow').hours).toBe(6);
  });

  it('scales the median anchor effort by the path', () => {
    // median([2,4]) = 3; quick scales 0.5x -> 1.5.
    expect(heuristicEstimate([anchor(2), anchor(4)], 'quick_bugfix').hours).toBe(1.5);
    // median([2,4]) = 3; plan scales 1x -> 3.
    expect(heuristicEstimate([anchor(2), anchor(4)], 'plan_tasklist').hours).toBe(3);
    // full scales 1.5x -> 4.5.
    expect(heuristicEstimate([anchor(2), anchor(4)], 'full_workflow').hours).toBe(4.5);
  });

  it('ignores zero-effort anchors when computing the median', () => {
    expect(heuristicEstimate([anchor(0), anchor(4)], 'plan_tasklist').hours).toBe(4);
  });

  it('counts cross-repo anchors in the median (cold-start seed)', () => {
    // median([2,4]) = 3; cross-repo anchors DO feed the heuristic baseline.
    const anchors = [anchor(2, { crossRepo: true }), anchor(4, { crossRepo: true })];
    expect(heuristicEstimate(anchors, 'plan_tasklist').hours).toBe(3);
  });
});

describe('overlapRefinedEstimate', () => {
  it('returns null when no files are predicted', () => {
    expect(overlapRefinedEstimate([anchor(2, { changedPaths: ['a'] })], [])).toBeNull();
  });

  it('returns null with fewer than 2 overlapping anchors', () => {
    const anchors = [
      anchor(2, { changedPaths: ['a', 'b'] }),
      anchor(4, { changedPaths: ['x', 'y'] }), // no overlap with ['a']
    ];
    expect(overlapRefinedEstimate(anchors, ['a'])).toBeNull();
  });

  it('takes the median effort of the prior tasks that touched the predicted files', () => {
    const anchors = [
      anchor(2, { changedPaths: ['a', 'b'] }),
      anchor(4, { changedPaths: ['a', 'c'] }),
      anchor(99, { changedPaths: ['x'] }), // no overlap -> excluded
    ];
    const r = overlapRefinedEstimate(anchors, ['a']);
    expect(r).not.toBeNull();
    expect(r!.hours).toBe(3); // median([2,4])
    expect(r!.overlapAnchors).toBe(2);
    expect(r!.matchedFiles).toBe(1); // only 'a' matched
  });

  it('excludes overlapping anchors that have zero measured effort', () => {
    const anchors = [anchor(0, { changedPaths: ['a'] }), anchor(6, { changedPaths: ['a'] })];
    // Only one anchor has effort>0 AND overlap -> below the min, so null.
    expect(overlapRefinedEstimate(anchors, ['a'])).toBeNull();
  });

  it('excludes cross-repo anchors from file overlap (coincidental path match)', () => {
    const anchors = [
      anchor(2, { changedPaths: ['a'], crossRepo: true }),
      anchor(4, { changedPaths: ['a'], crossRepo: true }),
      anchor(6, { changedPaths: ['a'] }), // the only LOCAL overlap
    ];
    // The two cross-repo overlaps are ignored; one local overlap is below the min -> null.
    expect(overlapRefinedEstimate(anchors, ['a'])).toBeNull();
  });
});

describe('computeBiasFactor', () => {
  it('null with fewer than 2 anchors carrying both estimate and actual', () => {
    expect(computeBiasFactor([anchor(4, { aiEstimateHours: 2 })])).toBeNull();
    expect(computeBiasFactor([anchor(4), anchor(6)])).toBeNull(); // no aiEstimateHours
  });

  it('median ratio of actual to prior AI estimate', () => {
    // ratios 4/2=2 and 6/2=3 -> median 2.5.
    const anchors = [anchor(4, { aiEstimateHours: 2 }), anchor(6, { aiEstimateHours: 2 })];
    expect(computeBiasFactor(anchors)).toBe(2.5);
  });

  it('clamps an extreme ratio into [0.25, 4]', () => {
    const anchors = [anchor(100, { aiEstimateHours: 1 }), anchor(50, { aiEstimateHours: 1 })];
    expect(computeBiasFactor(anchors)).toBe(4);
  });

  it('excludes cross-repo anchors from the bias factor', () => {
    const anchors = [
      anchor(4, { aiEstimateHours: 2, crossRepo: true }),
      anchor(6, { aiEstimateHours: 2, crossRepo: true }),
      anchor(4, { aiEstimateHours: 2 }), // the only LOCAL (estimate, actual) pair
    ];
    // Two cross-repo pairs ignored; one local pair is below the min -> null.
    expect(computeBiasFactor(anchors)).toBeNull();
  });
});

describe('estimateRange', () => {
  it('null with fewer than 3 usable anchors', () => {
    expect(estimateRange([anchor(2), anchor(4)])).toBeNull();
  });

  it('p20/p80 band from the anchor efforts', () => {
    // sorted [1,2,3,4,5]: p20 -> index 1 (2h), p80 -> index 3 (4h).
    const anchors = [anchor(1), anchor(2), anchor(3), anchor(4), anchor(5)];
    expect(estimateRange(anchors)).toEqual({ low: 2, high: 4 });
  });

  it('null when the band would collapse (all equal)', () => {
    expect(estimateRange([anchor(3), anchor(3), anchor(3)])).toBeNull();
  });
});

describe('cosineSim', () => {
  it('identical direction -> 1', () => {
    expect(cosineSim([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it('orthogonal -> 0', () => {
    expect(cosineSim([1, 0], [0, 1])).toBe(0);
  });

  it('opposite direction -> -1', () => {
    expect(cosineSim([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it('length mismatch or a zero vector -> 0', () => {
    expect(cosineSim([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});
