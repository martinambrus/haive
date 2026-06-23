import { describe, it, expect } from 'vitest';
import { heuristicTriage, parseTriageOutput, resolveTriage, triageStep } from './00-triage.js';

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
});
