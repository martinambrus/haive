import { describe, it, expect } from 'vitest';
import {
  heuristicTriage,
  parsePlanCandidate,
  parseTriageOutput,
  resolveBroadAudit,
  resolveTriage,
  triageStep,
} from './00-triage.js';

describe('heuristicTriage', () => {
  it('an explicit bug with a short description -> quick_bugfix', () => {
    expect(heuristicTriage('Fix login crash', 'users get a crash on login', null).path).toBe(
      'quick_bugfix',
    );
  });

  it('category=bugfix (creation flag) -> quick_bugfix', () => {
    expect(heuristicTriage('Adjust the thing', 'small tweak', 'bugfix').path).toBe('quick_bugfix');
  });

  it('feature/implement keywords -> full_workflow', () => {
    expect(
      heuristicTriage('Implement billing system', 'a new subscription feature', null).path,
    ).toBe('full_workflow');
  });

  it('even a bug with a very long description escalates off the quick path', () => {
    expect(heuristicTriage('Fix bug', 'x'.repeat(700), null).path).toBe('full_workflow');
  });

  it('a moderate non-bug change -> plan_tasklist', () => {
    expect(
      heuristicTriage(
        'Update the export to include totals',
        'show a totals column in the export',
        null,
      ).path,
    ).toBe('plan_tasklist');
  });
});

describe('parseTriageOutput', () => {
  it('parses a fenced JSON object', () => {
    const raw = 'sure thing\n```json\n{"recommended":"plan_tasklist","rationale":"medium"}\n```';
    expect(parseTriageOutput(raw)?.recommended).toBe('plan_tasklist');
  });

  it('accepts an already-parsed object', () => {
    expect(parseTriageOutput({ recommended: 'quick_bugfix', rationale: 'x' })?.recommended).toBe(
      'quick_bugfix',
    );
  });

  it('rejects an invalid recommended value', () => {
    expect(parseTriageOutput({ recommended: 'nonsense' })).toBeNull();
  });

  it('null / empty -> null', () => {
    expect(parseTriageOutput(null)).toBeNull();
    expect(parseTriageOutput('')).toBeNull();
  });
});

describe('resolveTriage', () => {
  const detected = {
    title: 't',
    description: 'd',
    heuristicPath: 'plan_tasklist' as const,
    heuristicReason: 'because',
    repositoryId: null,
    fromPlanChat: false,
  };

  it('uses the LLM recommendation when valid', () => {
    const r = resolveTriage({ recommended: 'quick_bugfix', rationale: 'small' }, detected);
    expect(r.recommended).toBe('quick_bugfix');
    expect(r.source).toBe('llm');
  });

  it('falls back to the heuristic when the LLM output is unusable', () => {
    const r = resolveTriage(null, detected);
    expect(r.recommended).toBe('plan_tasklist');
    expect(r.source).toBe('heuristic');
  });
});

describe('triageStep.form', () => {
  const detected = {
    title: 'fix thing',
    description: 'desc',
    heuristicPath: 'plan_tasklist' as const,
    heuristicReason: 'because',
  };

  function buildForm(llmOutput: unknown) {
    const schema = triageStep.form!(null as never, detected, llmOutput);
    const field = schema.fields[0] as {
      type: string;
      options: Array<{ value: string; label: string; description?: string; info?: string }>;
    };
    return { schema, field };
  }

  it('puts "(recommended)" in the chosen label and the rationale in its info tooltip', () => {
    const { field } = buildForm({ recommended: 'quick_bugfix', rationale: 'a small focused fix' });
    const rec = field.options.find((o) => o.value === 'quick_bugfix')!;
    expect(rec.label).toMatch(/\(recommended\)$/);
    expect(rec.info).toContain('a small focused fix');
    for (const o of field.options.filter((opt) => opt.value !== 'quick_bugfix')) {
      expect(o.label).not.toContain('(recommended)');
      expect(o.info).toBeUndefined();
    }
  });

  it('gives every option a gray description and renders no collapsible infoSections', () => {
    const { schema, field } = buildForm(null);
    expect(field.type).toBe('radio');
    expect(field.options).toHaveLength(3);
    for (const o of field.options) {
      expect(typeof o.description).toBe('string');
      expect((o.description ?? '').length).toBeGreaterThan(0);
    }
    expect(schema.infoSections).toBeUndefined();
  });

  it('adds a broadAudit checkbox (fields[1]) hidden on quick_bugfix, default on', () => {
    const { schema } = buildForm(null);
    expect((schema.fields[0] as { type: string }).type).toBe('radio');
    const cb = schema.fields[1] as {
      type: string;
      id: string;
      label: string;
      default?: boolean;
      visibleWhen?: { field: string; notEquals?: string; equals?: string };
    };
    expect(cb.type).toBe('checkbox');
    expect(cb.id).toBe('broadAudit');
    expect(cb.default).toBe(true);
    expect(cb.label).toContain('Extended results validation');
    expect(cb.label).toContain('(Recommended)');
    expect(cb.visibleWhen).toEqual({ field: 'path', notEquals: 'quick_bugfix' });
  });
});

describe('resolveBroadAudit', () => {
  it('forces off on quick_bugfix regardless of the submitted value', () => {
    expect(resolveBroadAudit('quick_bugfix', true)).toBe(false);
    expect(resolveBroadAudit('quick_bugfix', undefined)).toBe(false);
  });

  it('defaults on for non-quick paths when unset, honors an explicit untick', () => {
    expect(resolveBroadAudit('plan_tasklist', undefined)).toBe(true);
    expect(resolveBroadAudit('plan_tasklist', false)).toBe(false);
    expect(resolveBroadAudit('full_workflow', true)).toBe(true);
  });
});

describe('parsePlanCandidate', () => {
  const good = { reason: 'three separate capabilities', parts: ['comms', 'ux', 'workflow'] };

  it('accepts a candidate with a reason and two or more parts', () => {
    expect(parsePlanCandidate(good)).toEqual(good);
  });

  it('rejects one with a single part — that is one task, not several', () => {
    expect(parsePlanCandidate({ reason: 'r', parts: ['just this'] })).toBeNull();
  });

  it('rejects one with no reason to give the user', () => {
    expect(parsePlanCandidate({ parts: ['a', 'b'] })).toBeNull();
    expect(parsePlanCandidate({ reason: '   ', parts: ['a', 'b'] })).toBeNull();
  });

  it('drops blank parts rather than rendering empty bullets', () => {
    expect(parsePlanCandidate({ reason: 'r', parts: ['a', '', '  ', 'b'] })?.parts).toEqual([
      'a',
      'b',
    ]);
  });

  it('treats anything that is not a candidate as absent', () => {
    expect(parsePlanCandidate(undefined)).toBeNull();
    expect(parsePlanCandidate(null)).toBeNull();
    expect(parsePlanCandidate('should be a plan')).toBeNull();
    expect(parsePlanCandidate({ reason: 'r', parts: 'a, b' })).toBeNull();
  });
});

describe('the plan-candidate note', () => {
  const base = {
    title: 't',
    description: 'd',
    heuristicPath: 'plan_tasklist' as const,
    heuristicReason: 'because',
    repositoryId: 'repo-1',
    fromPlanChat: false,
  };
  const withCandidate = JSON.stringify({
    recommended: 'full_workflow',
    rationale: 'big',
    plan_candidate: { reason: 'three separate capabilities', parts: ['comms', 'ux', 'workflow'] },
  });

  it('carries the candidate through when the agent emitted one', () => {
    expect(resolveTriage(withCandidate, base).planCandidate?.parts).toHaveLength(3);
  });

  it('is SUPPRESSED for a task a plan chat proposed — else the two bounce forever', () => {
    expect(resolveTriage(withCandidate, { ...base, fromPlanChat: true }).planCandidate).toBeNull();
  });

  it('is absent, not false, on the heuristic fallback', () => {
    // The heuristic classifies on keywords and length. It cannot tell separate
    // capabilities from one large one, and a fabricated "no" reads as a check
    // that was made and passed.
    expect(resolveTriage(null, base).planCandidate).toBeNull();
    expect(resolveTriage('unparseable', base).source).toBe('heuristic');
  });

  it('renders as an info section beside the radios, never as a fourth option', () => {
    const form = triageStep.form!({} as never, base, withCandidate)!;
    const paths = form.fields.find((f) => f.id === 'path');
    expect(paths && 'options' in paths ? paths.options : []).toHaveLength(3);
    expect(form.infoSections?.[0]?.title).toContain('several separate pieces');
    expect(form.infoSections?.[0]?.body).toContain('/repos/repo-1/plan');
    expect(form.infoSections?.[0]?.body).toContain('ignore this entirely');
  });

  it('renders no info section at all when the agent offered nothing', () => {
    const form = triageStep.form!(
      {} as never,
      base,
      JSON.stringify({ recommended: 'quick_bugfix', rationale: 'small' }),
    )!;
    expect(form.infoSections).toBeUndefined();
  });
});
