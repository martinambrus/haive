import { describe, it, expect } from 'vitest';
import { parseEstimateOutput, resolveEstimate, estimateStep } from './00b-estimate.js';

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
