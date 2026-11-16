import { expect, it } from 'vitest';
import {
  STEP_ROLE_REGISTRY,
  isQuotableRole,
  safeParseStepOutput,
  type StepRoleId,
} from '../src/step-engine/output-contracts.js';
import { dataPortNodes } from '../src/step-engine/core-data-ports.js';
import { buildDataEdgePlan } from '../src/step-engine/data-edge-plan.js';
for (const [name, producer, input] of [
  ['haive.browser-verification', '08a-browser-verify', 'browser'],
  ['haive.adversarial-qa', '08d-adversarial-qa', 'adversarial-qa'],
] as const)
  it(`${name} exact mixed contract and pinned gate input`, () => {
    const entry = STEP_ROLE_REGISTRY[name as StepRoleId];
    expect(entry).toEqual({
      id: name,
      contract: { id: name, version: 1 },
      cardinality: 'one',
      authorship: 'mixed',
      legacyStepId: producer,
    });
    expect(isQuotableRole(name)).toBe(false);
    expect(safeParseStepOutput(entry.contract, {}).success).toBe(false);
    const plan = buildDataEdgePlan('static', [
      { executionPath: null, nodes: dataPortNodes([producer, '09-gate-2-verify-approval']) },
    ]);
    expect(plan.candidates[0]!.bindings[`1:${input}`]?.producerStepId).toBe(producer);
  });
