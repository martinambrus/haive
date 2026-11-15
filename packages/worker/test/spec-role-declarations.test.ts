import { expect, it } from 'vitest';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import {
  assertSpecPortDeclarations,
  CORE_COMPOSABLE_STEPS,
} from '../src/step-engine/composable-core.js';

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

it('requires exactly one canonical provider for each spec role, including absent declarations', () => {
  expect(() => assertSpecPortDeclarations()).not.toThrow();
  for (const role of Object.values(SPEC_ROLES)) {
    const id = STEP_ROLE_REGISTRY[role].legacyStepId;
    expect(() =>
      assertSpecPortDeclarations(
        CORE_COMPOSABLE_STEPS.map((e) => (e.stepId === id ? { ...e, providesRoles: [] } : e)),
      ),
    ).toThrow('spec-port-provider-invalid');
    expect(() =>
      assertSpecPortDeclarations([
        ...CORE_COMPOSABLE_STEPS,
        { ...CORE_COMPOSABLE_STEPS.find((e) => e.stepId === id)!, stepId: 'other' },
      ]),
    ).toThrow('spec-port-provider-invalid');
  }
});
it('refuses drift in input names and optional flags', () => {
  for (const change of [{ input: 'renamed' }, { optional: false }]) {
    expect(() =>
      assertSpecPortDeclarations(
        CORE_COMPOSABLE_STEPS.map((e) =>
          e.stepId === '06-run-config'
            ? {
                ...e,
                consumesRoles: e.consumesRoles!.map((p, i) => (i === 0 ? { ...p, ...change } : p)),
              }
            : e,
        ),
      ),
    ).toThrow('spec-port-input-invalid');
  }
});
