import { describe, expect, it } from 'vitest';
import { gate1SpecApprovalStep } from '../src/step-engine/steps/workflow/06-gate-1-spec-approval.js';
import { businessRequirementsReviewStep } from '../src/step-engine/steps/workflow/03c-business-requirements-review.js';
import { phase8LearningStep } from '../src/step-engine/steps/workflow/11-phase-8-learning.js';

// task-queue.ts handleResult('revise') keys on `targetStepId === sourceStepId` to decide
// whether a reviseLoop stays IN PLACE (same round, one mutating card — the learning loop)
// or FORKS a new round (forward-append history — the spec gates). Lock that classification
// in: flipping a gate to self-target (or the learning loop to an earlier target) silently
// changes which steps accumulate history vs overwrite in place — and with it the timer,
// terminal re-open, and scroll behaviour that depend on a fresh row id per attempt.
describe('reviseLoop routing: self-loop (in-place) vs fork (new round)', () => {
  const cases = [
    {
      name: 'gate-1 spec approval forks to the spec generator (04)',
      step: gate1SpecApprovalStep,
      input: { decision: 'reject', feedback: '' },
      expectedTarget: '04-phase-0b-pre-planning',
      expectSelfLoop: false,
    },
    {
      name: 'phase-1 business-requirements review forks to the generator (03b)',
      step: businessRequirementsReviewStep,
      input: { decision: 'reject', feedback: '' },
      expectedTarget: '03b-business-requirements',
      expectSelfLoop: false,
    },
    {
      name: 'phase-8 learning revises ITSELF in place',
      step: phase8LearningStep,
      input: { refineRequested: true },
      expectedTarget: '11-phase-8-learning',
      expectSelfLoop: true,
    },
  ] as const;

  for (const c of cases) {
    it(c.name, () => {
      const target = c.step.reviseLoop!.evaluate(c.input as never);
      expect(target).toEqual({ targetStepId: c.expectedTarget });
      // The discriminator handleResult uses to pick in-place vs fork.
      const selfLoop = target!.targetStepId === c.step.metadata.id;
      expect(selfLoop).toBe(c.expectSelfLoop);
    });
  }
});
