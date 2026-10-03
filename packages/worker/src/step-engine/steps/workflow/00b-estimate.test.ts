import { describe, it, expect } from 'vitest';
import { parseEstimateOutput, resolveEstimate, estimateStep } from './00b-estimate.js';
import type { EstimateAnchor } from './_estimate.js';

const history: EstimateAnchor[] = [1, 2, 3].map((effortHours) => ({
  title: `fix-${effortHours}`,
  description: '',
  executionPath: 'quick_bugfix',
  fixRounds: 0,
  effortHours,
  aiEstimateHours: effortHours * 2,
  confirmedEstimateHours: null,
  changedPaths: [],
  crossRepo: false,
}));

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
  const detected: Parameters<typeof resolveEstimate>[1] = {
    title: 'Task',
    description: '',
    manualEstimateHours: null,
    biasFactor: null,
    anchors: [],
    executionPath: 'plan_tasklist',
    heuristicHours: 2,
    heuristicReason: 'because',
  };

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

  it('recomputes a persisted fallback rather than reusing its old path-scaled baseline', () => {
    const r = resolveEstimate(null, {
      ...detected,
      anchors: history,
      executionPath: 'quick_bugfix',
      heuristicHours: 1,
    });
    expect(r.hours).toBe(2);
    expect(r.rationale).toContain('no path scaling needed');
  });

  it('recomputes the explanation when valid AI output omits its rationale', () => {
    const r = resolveEstimate(
      { estimatedHours: 5 },
      {
        ...detected,
        anchors: history,
        executionPath: 'quick_bugfix',
        heuristicReason: 'old mixed-path explanation',
      },
    );
    expect(r.hours).toBe(5);
    expect(r.source).toBe('llm');
    expect(r.rationale).toContain('prior quick_bugfix task(s)');
    expect(r.rationale).toContain('no path scaling needed');
    expect(r.rationale).not.toContain('old mixed-path explanation');
  });
});

describe('estimateStep.llm', () => {
  it('instructs same-path comparison and recomputes calibration on persisted detect output', () => {
    const detected = {
      title: 'Fix a bug',
      description: '',
      executionPath: 'quick_bugfix',
      anchors: history,
      biasFactor: 4,
      heuristicHours: 1,
      heuristicReason: 'old mixed baseline',
    };
    const prompt = estimateStep.llm!.buildPrompt({ detected, formValues: {} });
    expect(prompt).toContain('SAME execution path with similar scope');
    expect(prompt).toContain('weaker fallback');
    expect(prompt).toContain('prior quick_bugfix tasks in this repository');
    expect(prompt).toContain('about 0.5x');
    expect(prompt).toContain('baseline suggests 2h');
    expect(prompt).not.toContain('about 4x');
  });

  it('does not advertise mixed-path calibration when same-path pairs are insufficient', () => {
    const anchors = history.map((a) => ({ ...a, executionPath: 'full_workflow' }));
    const prompt = estimateStep.llm!.buildPrompt({
      detected: {
        title: 'Fix',
        description: '',
        executionPath: 'quick_bugfix',
        anchors,
        biasFactor: 0.5,
      },
      formValues: {},
    });
    expect(prompt).not.toContain('Calibration:');
    expect(prompt).toContain('broader prior task(s)');
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
    biasFactor: null,
  } as Parameters<NonNullable<typeof estimateStep.form>>[1];

  it('defaults the number field to the AI estimate when no manual estimate is set', () => {
    const schema = estimateStep.form!(null as never, baseDetect, { estimatedHours: 4 })!;
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
    )!;
    const num = schema.fields.find((f) => f.id === 'estimatedHours') as { default?: number };
    expect(num.default).toBe(3);
    expect(schema.fields.some((f) => f.id === 'priorEstimateNote')).toBe(true);
  });
});
