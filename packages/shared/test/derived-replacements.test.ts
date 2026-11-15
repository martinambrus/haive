import { describe, expect, it } from 'vitest';
import {
  evaluateDerivedTaskType,
  type ComposableStepEntry,
  type DerivedChange,
} from '../src/modularity/index.js';
import {
  CODE_REVIEW_OUTPUT_CONTRACT,
  CODE_AUDIT_OUTPUT_CONTRACT,
  STEP_ROLES,
} from '../src/step-engine/output-contracts.js';

const role = STEP_ROLES.codeReview;
const payload = 'module.example.review';
const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
const entry = (stepId: string, extra: Partial<ComposableStepEntry> = {}): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'test',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...extra,
});
const target = entry(role, {
  outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
  provides: ['review'],
  requires: [{ needs: 'repository', reason: 'role input' }],
  precedes: ['approved'],
  loopTargetStepId: '07-phase-2-implement',
});
const replacement = entry(payload, {
  outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
  replaces: [role],
  provides: ['review'],
});
function evaluate(
  changes: DerivedChange[] = [{ replace: role, with: payload }],
  override: Partial<ComposableStepEntry> = {},
  omit: string[] = [],
) {
  const entries = [
    ...prefix.map((id) => entry(id)),
    entry('07-phase-2-implement'),
    target,
    { ...replacement, ...override },
    entry('consumer', {
      requires: [{ needs: 'review', reason: 'review required' }],
      provides: ['approved'],
    }),
  ];
  const catalog = new Map(
    entries.filter((e) => !omit.includes(e.stepId)).map((e) => [e.stepId, e]),
  );
  return evaluateDerivedTaskType({
    baseCandidates: [
      null,
      'quick_bugfix' as const,
      'plan_tasklist' as const,
      'full_workflow' as const,
    ].map((executionPath) => ({
      executionPath,
      stepIds: [...prefix, '07-phase-2-implement', role, 'consumer'],
    })),
    changes,
    catalog,
    installedStepIds: new Set(catalog.keys()),
  });
}
describe('contracted replacement admission', () => {
  it('applies the report-only audit role with its exact contract', () => {
    const auditRole = STEP_ROLES.codeAudit;
    const declarations = [
      ...prefix.map((id) => entry(id)),
      entry(auditRole, { outputContract: CODE_AUDIT_OUTPUT_CONTRACT, provides: ['code-audit'] }),
      entry(payload, {
        outputContract: CODE_AUDIT_OUTPUT_CONTRACT,
        replaces: [auditRole],
        provides: ['code-audit'],
      }),
    ];
    const catalog = new Map(declarations.map((e) => [e.stepId, e]));
    const result = evaluateDerivedTaskType({
      baseCandidates: [{ executionPath: null, stepIds: [...prefix, auditRole] }],
      changes: [{ replace: auditRole, with: payload }],
      catalog,
      installedStepIds: new Set(catalog.keys()),
    });
    expect(result.issues).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      roleBindings: {
        [auditRole]: { stepId: payload, outputContract: CODE_AUDIT_OUTPUT_CONTRACT },
      },
    });
  });

  it('applies on every candidate, pins bindings and effective role requirements without minting tokens', () => {
    const result = evaluate();
    expect(result.issues).toEqual([]);
    for (const candidate of result.candidates) {
      expect(candidate.stepIds).toEqual([...prefix, '07-phase-2-implement', payload, 'consumer']);
      expect(candidate).toMatchObject({
        roleBindings: { [role]: { stepId: payload, outputContract: CODE_REVIEW_OUTPUT_CONTRACT } },
        effectiveEntries: expect.arrayContaining([
          expect.objectContaining({
            stepId: payload,
            requires: target.requires,
            provides: ['review'],
            precedes: ['approved'],
            loopTargetStepId: '07-phase-2-implement',
          }),
        ]),
      });
    }
  });
  it.each([
    ['replacement-not-declared', { replaces: [] }],
    ['replacement-contract-mismatch', { outputContract: CODE_AUDIT_OUTPUT_CONTRACT }],
    ['replacement-policy-incompatible', { provides: [] }],
    ['replacement-policy-incompatible', { removes: ['review'] }],
    ['replacement-policy-incompatible', { closes: true }],
    ['replacement-policy-incompatible', { loopTargetStepId: 'consumer' }],
  ] as const)('names %s with path, operation, target, payload and contracts', (kind, override) => {
    const result = evaluate(undefined, override as Partial<ComposableStepEntry>);
    expect(result.issues).toHaveLength(4);
    expect(result.issues[0]).toMatchObject({
      kind,
      executionPath: null,
      operationIndex: 0,
      target: role,
      payload,
      expectedContract: CODE_REVIEW_OUTPUT_CONTRACT,
      actualContract:
        'outputContract' in override ? override.outputContract : CODE_REVIEW_OUTPUT_CONTRACT,
    });
    expect(result.candidates.every((c) => c.outcomes[0]?.outcome === 'refused')).toBe(true);
  });
  it('names missing host contracts and forbidden targets', () => {
    expect(evaluate(undefined, {}, [role]).issues).toContainEqual(
      expect.objectContaining({ kind: 'replacement-contract-unavailable' }),
    );
    expect(evaluate([{ replace: '07-phase-2-implement', with: payload }]).issues).toContainEqual(
      expect.objectContaining({ kind: 'replacement-target-forbidden' }),
    );
  });
  it('rejects role ambiguity, consumed targets and a second replacement hop', () => {
    expect(
      evaluate([
        { replace: role, with: payload },
        { insertAfter: payload, step: role },
      ]).issues,
    ).toContainEqual(expect.objectContaining({ kind: 'replacement-role-ambiguous' }));
    expect(
      evaluate([
        { insertAfter: role, step: payload },
        { replace: role, with: payload },
      ]).issues,
    ).toContainEqual(expect.objectContaining({ kind: 'replacement-role-ambiguous' }));
    expect(evaluate([{ replace: role, with: payload }, { remove: role }]).issues).toContainEqual(
      expect.objectContaining({ kind: 'target-removed-by-change' }),
    );
    expect(
      evaluate([
        { replace: role, with: payload },
        { replace: payload, with: role },
      ]).issues,
    ).toContainEqual(expect.objectContaining({ kind: 'replacement-target-forbidden' }));
  });
  it('removing a replacement drops the binding and checks the final composition', () => {
    const result = evaluate([{ replace: role, with: payload }, { remove: payload }]);
    expect(result.issues).toContainEqual(expect.objectContaining({ kind: 'invalid-composition' }));
    expect(result.candidates[0]).toMatchObject({ roleBindings: {} });
  });
});
