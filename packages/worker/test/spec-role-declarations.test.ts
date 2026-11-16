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
      if (entry.stepId === '06c-dag-execute') {
        expect(provider.role).toBe('haive.implementation.summary');
      } else expect(role.legacyStepId).toBe(entry.stepId);
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

it('checks discovery/requirements providers and optional inputs at boot', async () => {
  const { assertDiscoveryRequirementsPortDeclarations } =
    await import('../src/step-engine/composable-core.js');
  const { DISCOVERY_ROLE, REQUIREMENTS_ROLES } = await import('@haive/shared/step-outputs');
  expect(() => assertDiscoveryRequirementsPortDeclarations()).not.toThrow();
  for (const role of [DISCOVERY_ROLE, ...Object.values(REQUIREMENTS_ROLES)]) {
    const id = STEP_ROLE_REGISTRY[role].legacyStepId;
    const entry = CORE_COMPOSABLE_STEPS.find((e) => e.stepId === id)!;
    expect(() =>
      assertDiscoveryRequirementsPortDeclarations(
        CORE_COMPOSABLE_STEPS.map((e) => (e.stepId === id ? { ...e, providesRoles: [] } : e)),
      ),
    ).toThrow('port-provider-invalid');
    expect(() =>
      assertDiscoveryRequirementsPortDeclarations([
        ...CORE_COMPOSABLE_STEPS,
        { ...entry, stepId: 'other' },
      ]),
    ).toThrow('port-provider-invalid');
  }
  for (const change of [{ input: 'renamed' }, { optional: false }]) {
    expect(() =>
      assertDiscoveryRequirementsPortDeclarations(
        CORE_COMPOSABLE_STEPS.map((e) =>
          e.stepId === '04-phase-0b-pre-planning'
            ? {
                ...e,
                consumesRoles: e.consumesRoles!.map((p, i) => (i === 0 ? { ...p, ...change } : p)),
              }
            : e,
        ),
      ),
    ).toThrow('port-input-invalid');
  }
});

it('checks both implementation-summary providers and its one optional consumer at boot', async () => {
  const { assertImplementationSummaryPortDeclarations } =
    await import('../src/step-engine/composable-core.js');
  expect(() => assertImplementationSummaryPortDeclarations()).not.toThrow();
  for (const stepId of ['06c-dag-execute', '07-phase-2-implement']) {
    expect(() =>
      assertImplementationSummaryPortDeclarations(
        CORE_COMPOSABLE_STEPS.map((e) => (e.stepId === stepId ? { ...e, providesRoles: [] } : e)),
      ),
    ).toThrow('port-provider-invalid');
  }
  expect(() =>
    assertImplementationSummaryPortDeclarations(
      CORE_COMPOSABLE_STEPS.map((e) =>
        e.stepId === '11-phase-8-learning' ? { ...e, consumesRoles: [] } : e,
      ),
    ),
  ).toThrow('port-input-invalid');
});

it('keeps check-result executable and serialized declarations aligned, with only optional inputs', async () => {
  const { CHECK_RESULT_ROLES } = await import('@haive/shared/step-outputs');
  const { CHECK_RESULT_INPUTS } = await import('@haive/shared/step-ports');
  const { StepRegistry } = await import('../src/step-engine/registry.js');
  const { registerAllSteps } = await import('../src/step-engine/steps/index.js');
  const registry = new StepRegistry();
  registerAllSteps(registry);
  for (const role of Object.values(CHECK_RESULT_ROLES)) {
    const expected = STEP_ROLE_REGISTRY[role];
    const entry = CORE_COMPOSABLE_STEPS.find((e) => e.stepId === expected.legacyStepId)!;
    expect(entry.providesRoles?.find((p) => p.role === role)).toEqual({
      role,
      contract: expected.contract,
    });
    expect(registry.require(entry.stepId).providesRoles?.find((p) => p.role === role)).toEqual({
      role,
      contract: expected.contract,
    });
  }
  for (const [id, expected] of Object.entries(CHECK_RESULT_INPUTS)) {
    const onlyChecks = (ports: readonly { role: string }[] | undefined) =>
      (ports ?? []).filter((p) => Object.values(CHECK_RESULT_ROLES).some((r) => r === p.role));
    expect(onlyChecks(CORE_COMPOSABLE_STEPS.find((e) => e.stepId === id)?.consumesRoles)).toEqual(
      expected,
    );
    expect(onlyChecks(registry.require(id).consumesRoles)).toEqual(expected);
    expect(expected.every((p) => p.optional)).toBe(true);
  }
});
