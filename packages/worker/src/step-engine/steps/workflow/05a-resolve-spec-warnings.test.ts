import { describe, it, expect } from 'vitest';
import { resolveSpecWarningsStep } from './05a-resolve-spec-warnings.js';
import type { StepContext } from '../../step-definition.js';

const ctx = {} as unknown as StepContext;
const base = {
  findings: ['[WARN] documentation: minor'],
  warnCount: 1,
  errorCount: 0,
  spec: 'SPEC',
  specFilePath: '/workspace/.haive/spec-review.md',
};

describe('05a form auto-submit on a spec revise', () => {
  it('auto-submits the default "continue as-is" when revising', () => {
    const schema = resolveSpecWarningsStep.form!(ctx, { ...base, revising: true })!;
    expect(schema.autoSubmit).toBe(true);
    const action = schema.fields.find((f) => f.id === 'action') as { default?: string };
    expect(action.default).toBe('continue');
  });

  it('gates on the first pass (no outstanding spec rejection)', () => {
    const schema = resolveSpecWarningsStep.form!(ctx, { ...base, revising: false })!;
    expect(schema.autoSubmit).toBeUndefined();
  });
});
