import { expect, it } from 'vitest';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';

it('keeps every core role declaration aligned with its registry entry', () => {
  for (const entry of CORE_COMPOSABLE_STEPS) {
    for (const provider of entry.providesRoles ?? []) {
      const role = STEP_ROLE_REGISTRY[provider.role];
      expect(role, `${entry.stepId} provider`).toBeDefined();
      expect(role.legacyStepId).toBe(entry.stepId);
      expect(provider.contract).toEqual(role.contract);
    }
    for (const consumer of entry.consumesRoles ?? []) {
      const role = STEP_ROLE_REGISTRY[consumer.role];
      expect(role, `${entry.stepId}.${consumer.input}`).toBeDefined();
      expect(consumer.contract).toEqual(role.contract);
    }
  }
});
it('declares 05 draft input optional, matching its tolerant historical read', () => {
  expect(
    CORE_COMPOSABLE_STEPS.find(
      (e) => e.stepId === '05-phase-0b5-spec-quality',
    )!.consumesRoles!.find((input) => input.role === SPEC_ROLES.draft)!.optional,
  ).toBe(true);
});
