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

// recordBizReqDecision writes a task_event via ctx.db.insert(...).values(...);
// stub that chain so apply() can run without a real database.
const stubCtx = {
  logger: { info: () => {} },
  taskId: 'task-1',
  taskStepId: 'step-1',
  db: { insert: () => ({ values: async () => undefined }) },
} as unknown as StepContext;

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

  it('reject returns the decision without throwing (re-mine route)', async () => {
    const out = await businessRequirementsReviewStep.apply(
      stubCtx,
      applyArgs({ decision: 'reject', feedback: 'needs more detail' }),
    );
    expect(out.decision).toBe('reject');
    expect(out.feedback).toBe('needs more detail');
  });

  it('defaults a missing decision to approve (never silently rejects)', async () => {
    const out = await businessRequirementsReviewStep.apply(stubCtx, applyArgs({}));
    expect(out.decision).toBe('approve');
  });
});

describe('03c persists the review decision (so 03b can re-mine with the feedback)', () => {
  function capturingCtx() {
    const events: Array<{ eventType: string; payload: { feedback?: string } }> = [];
    const ctx = {
      logger: { info: () => {} },
      taskId: 'task-1',
      taskStepId: 'step-1',
      db: {
        insert: () => ({
          values: async (row: { eventType: string; payload: { feedback?: string } }) => {
            events.push({ eventType: row.eventType, payload: row.payload });
          },
        }),
      },
    } as unknown as StepContext;
    return { ctx, events };
  }

  it('records the rejection feedback as an event (no throw)', async () => {
    const { ctx, events } = capturingCtx();
    const out = await businessRequirementsReviewStep.apply(
      ctx,
      applyArgs({ decision: 'reject', feedback: 'add an ETA section' }),
    );
    expect(out.decision).toBe('reject');
    expect(events[0]?.eventType).toBe('business_requirements.rejected');
    expect(events[0]?.payload?.feedback).toBe('add an ETA section');
  });

  it('records an approval event so a later re-mine starts clean', async () => {
    const { ctx, events } = capturingCtx();
    await businessRequirementsReviewStep.apply(
      ctx,
      applyArgs({ decision: 'approve', feedback: '' }),
    );
    expect(events.map((e) => e.eventType)).toContain('business_requirements.approved');
  });
});

describe('03c reviseLoop (reject → re-mine 03b)', () => {
  it('routes a reject back to 03b and finalizes an approve', () => {
    const hook = businessRequirementsReviewStep.reviseLoop!;
    expect(
      hook.evaluate({ requirements: '', summary: '', decision: 'reject', feedback: '' }),
    ).toEqual({ targetStepId: '03b-business-requirements' });
    expect(
      hook.evaluate({ requirements: '', summary: '', decision: 'approve', feedback: '' }),
    ).toBeNull();
  });
});
