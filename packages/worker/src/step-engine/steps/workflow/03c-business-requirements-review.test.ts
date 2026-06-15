import { describe, it, expect } from 'vitest';
import {
  businessRequirementsReviewStep,
  hasRequirements,
} from './03c-business-requirements-review.js';
import type { StepContext, StepApplyArgs } from '../../step-definition.js';

const detected = {
  taskTitle: 'Add a logout button',
  requirements: '# Business requirements\n\nUsers need to log out.',
  summary: 'logout requirements',
};

const stubCtx = { logger: { info: () => {} } } as unknown as StepContext;

function applyArgs(formValues: Record<string, unknown>): StepApplyArgs<typeof detected> {
  return { detected, formValues, iteration: 0, previousIterations: [] };
}

describe('03c hasRequirements (skip-both gate)', () => {
  it('is true only when 03b produced a non-empty doc', () => {
    // 03c.shouldRun returns this, so a skipped/empty 03b auto-skips the review.
    expect(hasRequirements({ requirements: '# R\n\nbody' })).toBe(true);
    expect(hasRequirements({ requirements: '   ' })).toBe(false);
    expect(hasRequirements({ requirements: '' })).toBe(false);
    expect(hasRequirements({})).toBe(false);
  });
});

describe('03c review form', () => {
  it('shows the drafted requirements and an approve/reject decision', () => {
    const schema = businessRequirementsReviewStep.form!(stubCtx, detected);
    expect(schema).not.toBeNull();
    expect(schema!.infoSections?.[0]?.body ?? '').toContain('Users need to log out.');
    const decision = schema!.fields.find((f) => f.id === 'decision') as
      | { type?: string; required?: boolean }
      | undefined;
    expect(decision?.type).toBe('radio');
    expect(decision?.required).toBe(true);
  });
});

describe('03c apply (decision handling)', () => {
  it('approve passes the requirements through with the decision', async () => {
    const out = await businessRequirementsReviewStep.apply(
      stubCtx,
      applyArgs({ decision: 'approve', feedback: '' }),
    );
    expect(out.decision).toBe('approve');
    expect(out.requirements).toContain('Users need to log out.');
  });

  it('reject throws to halt the task', async () => {
    await expect(
      businessRequirementsReviewStep.apply(
        stubCtx,
        applyArgs({ decision: 'reject', feedback: 'needs more detail' }),
      ),
    ).rejects.toThrow(/rejected/i);
  });

  it('defaults a missing decision to approve (never silently rejects)', async () => {
    const out = await businessRequirementsReviewStep.apply(stubCtx, applyArgs({}));
    expect(out.decision).toBe('approve');
  });
});
