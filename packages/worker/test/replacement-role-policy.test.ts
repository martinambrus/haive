import { describe, expect, it, vi } from 'vitest';
import {
  rolePin as sharedRolePin,
  rolePlan,
  REVIEW,
  AUDIT,
  PRODUCER,
} from './replacement-fixtures.js';
import {
  CODE_REVIEW_OUTPUT_CONTRACT,
  CODE_AUDIT_OUTPUT_CONTRACT,
} from '@haive/shared/step-outputs';
import { parseDerivedRunPlan, type DerivedRunPlanV2 } from '@haive/shared/modularity';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { StepRegistry, PinnedStepSupportError } from '../src/step-engine/registry.js';
import { resolveTaskStep, assertPinnedCandidateSupport } from '../src/queues/run-list.js';
import { deadTaskResolution } from '../src/queues/dead-task-boot.js';
import { codeReviewStep } from '../src/step-engine/steps/workflow/08c-code-review.js';
import { codeAuditStep } from '../src/step-engine/steps/workflow/08c2-code-audit.js';
const rolePin = (version: 1 | 2 = 2) => {
  const pin = sharedRolePin(version);
  return { ...pin, runListSnapshot: [...pin.runListSnapshot] };
};
const replacement = (): StepDefinition => ({
  metadata: { ...codeReviewStep.metadata, id: PRODUCER },
  outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
  replaces: [REVIEW],
  apply: async () => null,
});
function registry(def: StepDefinition = replacement()) {
  const r = new StepRegistry();
  r.register(codeReviewStep);
  r.register(codeAuditStep);
  r.register(def);
  return r;
}
describe('pinned effective host role policy', () => {
  it('inherits the canonical review evaluator, preserves physical identity and no dispatch seats', () => {
    const own = replacement();
    const r = registry(own);
    const effective = resolveTaskStep(rolePin(2), PRODUCER, r)!;
    expect(effective.fixLoop).toBe(codeReviewStep.fixLoop);
    expect(effective.metadata.id).toBe(PRODUCER);
    expect(effective.agentMining).toBeUndefined();
    expect(own.fixLoop).toBeUndefined();
    expect(effective.fixLoop!.evaluate({ blocking: false })).toBeNull();
    expect(
      effective.fixLoop!.evaluate({
        blocking: true,
        peer: { findings: [{ severity: 'high', path: 'src/a.ts', issue: 'bug', fix: 'fix' }] },
        security: { findings: [] },
        extraLenses: [],
      }),
    ).toMatchObject({ diagnosis: expect.stringContaining('bug') });
    expect(resolveTaskStep({}, PRODUCER, r)).toBe(own);
    expect(resolveTaskStep(rolePin(1), REVIEW, r)).toBe(codeReviewStep);
  });
  it('keeps audit report-only and broadAudit=false skips without calling the replacement', async () => {
    const plan = rolePlan(2) as DerivedRunPlanV2;
    plan.overlay.changes = [{ replace: AUDIT, with: PRODUCER }];
    plan.composableEntries[0]!.outputContract = CODE_AUDIT_OUTPUT_CONTRACT;
    plan.composableEntries[0]!.replaces = [AUDIT];
    plan.candidates = plan.candidates.map((c) => ({
      ...c,
      stepIds: c.stepIds.map((id) => (id === PRODUCER ? REVIEW : id === AUDIT ? PRODUCER : id)),
      outcomes: c.outcomes.map((o) => ({ ...o, change: plan.overlay.changes[0]! })),
      roleBindings: { [AUDIT]: { stepId: PRODUCER, outputContract: CODE_AUDIT_OUTPUT_CONTRACT } },
    }));
    parseDerivedRunPlan(plan);
    const ownShouldRun = vi.fn(() => true);
    const own = {
      ...replacement(),
      outputContract: CODE_AUDIT_OUTPUT_CONTRACT,
      replaces: [AUDIT] as const,
      shouldRun: ownShouldRun,
    };
    const r = registry(own);
    const effective = resolveTaskStep(
      {
        derivedRunPlan: plan,
        executionPath: 'full_workflow',
        runListSnapshot: [...plan.candidates[3]!.stepIds],
      },
      PRODUCER,
      r,
    )!;
    expect(effective.fixLoop).toBeUndefined();
    expect(
      await effective.shouldRun!({
        taskId: 'task',
        db: { query: { tasks: { findFirst: async () => ({ broadAudit: false }) } } },
      } as never),
    ).toBe(false);
    expect(ownShouldRun).not.toHaveBeenCalled();
  });
  it.each(['fixLoop', 'restartLoop', 'reviseLoop', 'loop', 'fixLoopOnError'])(
    'refuses conflicting %s at registration',
    (hook) => {
      expect(() => registry({ ...replacement(), [hook]: true })).toThrow(
        'step-output-role-policy-incompatible',
      );
    },
  );
  it('missing executable contract or host policy is a named dead condition without remapping', () => {
    const r = registry();
    r.override({ ...replacement(), outputContract: undefined, replaces: undefined });
    expect(() => resolveTaskStep(rolePin(2), PRODUCER, r)).toThrow(PinnedStepSupportError);
    expect(() =>
      assertPinnedCandidateSupport((rolePlan(2) as DerivedRunPlanV2).candidates[0]!, r),
    ).toThrow(expect.objectContaining({ code: 'pinned-step-support-unavailable' }));
    const dead = deadTaskResolution(
      { id: 'task', type: 'derived', currentStepId: PRODUCER, customSteps: null, ...rolePin(2) },
      'derived',
      r,
    );
    expect(dead).toMatchObject({
      unresolved: [PRODUCER],
      supportReason: expect.stringContaining('pinned-step-support-unavailable'),
    });
  });
});
