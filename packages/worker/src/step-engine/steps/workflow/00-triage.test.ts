import { describe, it, expect } from 'vitest';
import { heuristicTriage, parseTriageOutput, resolveTriage } from './00-triage.js';

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
