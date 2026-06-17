import { describe, it, expect } from 'vitest';
import type { StepContext } from '../../step-definition.js';
import { businessRequirementsStep, parseBizReqOutput } from './03b-business-requirements.js';

describe('parseBizReqOutput', () => {
  it('parses a fenced requirements doc', () => {
    const raw =
      'drafted\n```json\n{"requirements":"# Requirements\\n\\nUsers want X.","summary":"add X"}\n```';
    const p = parseBizReqOutput(raw);
    expect(p).not.toBeNull();
    expect(p!.requirements).toContain('Users want X.');
    expect(p!.summary).toBe('add X');
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseBizReqOutput({ requirements: '# R\n\nbody', summary: 's' });
    expect(p).not.toBeNull();
    expect(p!.summary).toBe('s');
  });

  it('returns null on empty requirements or garbled output', () => {
    expect(parseBizReqOutput('```json\n{"requirements":"","summary":"x"}\n```')).toBeNull();
    expect(parseBizReqOutput('no json')).toBeNull();
    expect(parseBizReqOutput(null)).toBeNull();
  });
});

describe('03b form autoSubmit on revise', () => {
  const base = {
    taskTitle: 'T',
    taskDescription: 'D',
    discoverySummary: '',
    priorRejectionFeedback: '',
  };
  const ctx = {} as unknown as StepContext;

  it('auto-submits with the pre-filled feedback when revising (03c rejected)', () => {
    const schema = businessRequirementsStep.form!(ctx, {
      ...base,
      priorRejectionFeedback: 'add ETA',
    });
    expect(schema!.autoSubmit).toBe(true);
    const guidance = schema!.fields.find((f) => f.id === 'guidance') as { default?: string };
    expect(guidance.default).toBe('add ETA');
  });

  it('does not auto-submit on the first run (opt-in gate preserved)', () => {
    const schema = businessRequirementsStep.form!(ctx, base);
    expect(schema!.autoSubmit).toBeUndefined();
  });
});
