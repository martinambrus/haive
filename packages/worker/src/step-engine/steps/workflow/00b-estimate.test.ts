import { describe, it, expect } from 'vitest';
import {
  effortHoursFromSteps,
  heuristicEstimate,
  parseEstimateOutput,
  resolveEstimate,
  estimateStep,
  type EstimateAnchor,
} from './00b-estimate.js';
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
});

describe('parseEstimateOutput', () => {
  it('parses a fenced JSON object', () => {
    const raw =
      'here you go\n```json\n{"estimatedHours":3.5,"confidence":"high","rationale":"x","similarPriorTasks":["a"]}\n```';
    const r = parseEstimateOutput(raw);
    expect(r?.estimatedHours).toBe(3.5);
    expect(r?.confidence).toBe('high');
    expect(r?.similarPriorTasks).toEqual(['a']);
  });

  it('accepts an already-parsed object and a numeric string', () => {
    expect(parseEstimateOutput({ estimatedHours: 2 })?.estimatedHours).toBe(2);
    expect(parseEstimateOutput({ estimatedHours: '2.25' })?.estimatedHours).toBe(2.25);
  });

  it('rejects non-positive or non-numeric estimates', () => {
    expect(parseEstimateOutput({ estimatedHours: 0 })).toBeNull();
    expect(parseEstimateOutput({ estimatedHours: -1 })).toBeNull();
    expect(parseEstimateOutput({ estimatedHours: 'abc' })).toBeNull();
    expect(parseEstimateOutput({})).toBeNull();
  });

  it('null / empty -> null', () => {
    expect(parseEstimateOutput(null)).toBeNull();
    expect(parseEstimateOutput('')).toBeNull();
  });

  it('clamps an absurd estimate into the allowed envelope', () => {
    expect(parseEstimateOutput({ estimatedHours: 99999 })?.estimatedHours).toBe(1000);
  });
});

describe('resolveEstimate', () => {
  const detected = {
    heuristicHours: 2,
    heuristicReason: 'because',
  } as Parameters<typeof resolveEstimate>[1];

  it('uses the LLM estimate when valid', () => {
    const r = resolveEstimate({ estimatedHours: 5, confidence: 'high' }, detected);
    expect(r.hours).toBe(5);
    expect(r.source).toBe('llm');
  });

  it('falls back to the heuristic when the LLM output is unusable', () => {
    const r = resolveEstimate(null, detected);
    expect(r.hours).toBe(2);
    expect(r.source).toBe('heuristic');
  });
});

describe('estimateStep.form', () => {
  const baseDetect = {
    title: 'x',
    description: 'y',
    executionPath: 'full_workflow',
    manualEstimateHours: null,
    anchors: [],
    heuristicHours: 6,
    heuristicReason: 'baseline',
  } as Parameters<NonNullable<typeof estimateStep.form>>[1];

  it('defaults the number field to the AI estimate when no manual estimate is set', () => {
    const schema = estimateStep.form!(null as never, baseDetect, { estimatedHours: 4 });
    const num = schema.fields.find((f) => f.id === 'estimatedHours') as { default?: number };
    expect(num.default).toBe(4);
    // No prior-estimate note when the user never set one.
    expect(schema.fields.some((f) => f.id === 'priorEstimateNote')).toBe(false);
  });

  it('respects an explicit manual estimate as the field default and shows a note', () => {
    const schema = estimateStep.form!(
      null as never,
      { ...baseDetect, manualEstimateHours: 3 },
      { estimatedHours: 4 },
    );
    const num = schema.fields.find((f) => f.id === 'estimatedHours') as { default?: number };
    expect(num.default).toBe(3);
    expect(schema.fields.some((f) => f.id === 'priorEstimateNote')).toBe(true);
  });
});
