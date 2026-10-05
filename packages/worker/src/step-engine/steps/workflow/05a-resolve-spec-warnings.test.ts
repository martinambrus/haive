import { describe, it, expect } from 'vitest';
import { resolveSpecWarningsStep } from './05a-resolve-spec-warnings.js';
import type { StepContext } from '../../step-definition.js';

const ctx = {} as unknown as StepContext;
const base = {
  findings: ['[MEDIUM] documentation: minor'],
  blockingCount: 0,
  advisoryCount: 1,
  spec: 'SPEC',
  specFilePath: '/workspace/.haive/spec-review.md',
  hasAuditFindings: false,
};

describe('05a form auto-submit on a spec revise', () => {
  it('preserves explicit scope questions for the user gate', async () => {
    const out = await resolveSpecWarningsStep.apply(
      { logger: { info: () => undefined, warn: () => undefined } } as never,
      {
        detected: { ...base, revising: false },
        formValues: { action: 'agent' },
        iteration: 0,
        previousIterations: [],
        llmOutput: {
          amendedSpec: 'SPEC',
          scopeQuestions: ['May we remove Navigation despite the permission constraint?'],
        },
      },
    );
    expect(out.scopeQuestions).toEqual([
      'May we remove Navigation despite the permission constraint?',
    ]);
    expect(out.spec).toBe('SPEC');
  });

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
