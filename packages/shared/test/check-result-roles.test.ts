import { expect, it } from 'vitest';
import {
  STEP_ROLE_REGISTRY,
  isQuotableRole,
  safeParseStepOutput,
  type StepRoleId,
} from '../src/step-engine/output-contracts.js';
import { dataPortNodes } from '../src/step-engine/core-data-ports.js';
import { buildDataEdgePlan } from '../src/step-engine/data-edge-plan.js';
const cases = [
  ['haive.validation', '07b-phase-4-validate', 'validation'],
  ['haive.verify', '08-phase-5-verify', 'verify'],
  ['haive.test-management', '08b-test-management', 'test-management'],
] as const;
for (const [name, producer, input] of cases) {
  it(`${name}: exact mixed data contract, fail-closed payloads and immutable optional edge`, () => {
    const role = name as StepRoleId;
    const entry = STEP_ROLE_REGISTRY[role];
    expect(entry).toEqual({
      id: name,
      contract: { id: name, version: 1 },
      cardinality: 'one',
      authorship: 'mixed',
      legacyStepId: producer,
    });
    expect(isQuotableRole(role)).toBe(false);
    expect(safeParseStepOutput(entry.contract, {}).success).toBe(false);
    expect(safeParseStepOutput(entry.contract, { resultStatus: 'passed' }).success).toBe(false);
    const plan = (ids: string[]) =>
      buildDataEdgePlan('static', [{ executionPath: null, nodes: dataPortNodes(ids) }]);
    expect(
      plan([producer, '09-gate-2-verify-approval']).candidates[0]!.bindings[`1:${input}`]
        ?.producerStepId,
    ).toBe(producer);
    expect(plan(['09-gate-2-verify-approval']).candidates[0]!.bindings[`0:${input}`]).toBeNull();
  });
}

it('keeps unexecuted, partial, failed, manual and declined evidence distinct', () => {
  const verify = STEP_ROLE_REGISTRY['haive.verify'].contract;
  const idle = { ran: false, passed: false, command: null, output: '' };
  const output = {
    resultStatus: 'not-run',
    test: idle,
    lint: idle,
    typecheck: idle,
    passed: true,
    runtimeSmoke: null,
    declinedConfigs: [],
    declaredSlots: [],
    offSlots: [],
    slotWithoutRunner: true,
  };
  for (const resultStatus of ['not-run', 'skipped', 'incomplete', 'manual', 'declined'])
    expect(safeParseStepOutput(verify, { ...output, resultStatus }).success).toBe(true);
  expect(safeParseStepOutput(verify, { ...output, resultStatus: 'passed' }).success).toBe(false);
  expect(
    safeParseStepOutput(verify, {
      ...output,
      resultStatus: 'passed',
      test: { ...idle, ran: true, passed: true },
    }).success,
  ).toBe(true);
  expect(
    safeParseStepOutput(verify, {
      ...output,
      resultStatus: 'passed',
      test: { ...idle, ran: true, passed: false },
    }).success,
  ).toBe(false);
});
