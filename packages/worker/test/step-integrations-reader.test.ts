import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposableStepEntry, IntegrationRequirement } from '@haive/shared/modularity';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import {
  stepIntegrationsUnderTest,
  type StepIntegrations,
} from './support/step-integrations-contract.js';

const REQUIRED: IntegrationRequirement = { id: 'pull-requests', category: 'forge', access: 'read' };
const OPTIONAL: IntegrationRequirement = {
  id: 'tracker',
  category: 'issues',
  access: 'write',
  optional: true,
};
const MODULE_A = 'module.fx.audit-a';
const MODULE_B = 'module.fx.audit-b';
const CORE = '07-phase-2-implement';
const CUSTOM = 'custom.audit.list-todos';

const stepDef = (id: string) =>
  ({
    metadata: { id, workflowType: 'x', index: 0, title: id, description: id, requiresCli: true },
  }) as unknown as StepDefinition;

const entry = (stepId: string, integrations?: IntegrationRequirement[]): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'g',
  dispatchesCli: true,
  requires: [],
  provides: [],
  ...(integrations === undefined ? {} : { integrations }),
});

describe("[D1] the one reader of a step's declared integrations", () => {
  let mod: StepIntegrations;

  beforeEach(async () => {
    mod = await stepIntegrationsUnderTest();
    mod.setComposableCatalog(new Map());
  });

  it('[D1] returns the integrations a module composable entry declares, in order', () => {
    mod.setComposableCatalog(new Map([[MODULE_A, entry(MODULE_A, [REQUIRED, OPTIONAL])]]));

    const read = mod.stepIntegrationRequirements(stepDef(MODULE_A));

    expect(Array.isArray(read)).toBe(true);
    expect(read).toEqual([REQUIRED, OPTIONAL]);
  });

  it('[D1] reads the entry of the step it is given, not another one', () => {
    mod.setComposableCatalog(
      new Map([
        [MODULE_A, entry(MODULE_A, [REQUIRED])],
        [MODULE_B, entry(MODULE_B, [OPTIONAL])],
      ]),
    );

    expect(mod.stepIntegrationRequirements(stepDef(MODULE_A))).toEqual([REQUIRED]);
    expect(mod.stepIntegrationRequirements(stepDef(MODULE_B))).toEqual([OPTIONAL]);
  });

  it('[D1] returns nothing for a core step that declares none, listed in the catalog or not', () => {
    mod.setComposableCatalog(
      new Map([
        [MODULE_A, entry(MODULE_A, [REQUIRED])],
        [CORE, entry(CORE)],
      ]),
    );
    expect(mod.stepIntegrationRequirements(stepDef(CORE))).toEqual([]);

    mod.setComposableCatalog(new Map([[MODULE_A, entry(MODULE_A, [REQUIRED])]]));
    expect(mod.stepIntegrationRequirements(stepDef('01-declare-deps'))).toEqual([]);
  });

  it('[D1] returns nothing for a module entry that declares none, or an empty list', () => {
    mod.setComposableCatalog(
      new Map([
        [MODULE_A, entry(MODULE_A)],
        [MODULE_B, entry(MODULE_B, [])],
      ]),
    );

    expect(mod.stepIntegrationRequirements(stepDef(MODULE_A))).toEqual([]);
    expect(mod.stepIntegrationRequirements(stepDef(MODULE_B))).toEqual([]);
  });

  it('[D1] returns nothing for a custom.* step', () => {
    mod.setComposableCatalog(new Map([[MODULE_A, entry(MODULE_A, [REQUIRED])]]));

    expect(mod.stepIntegrationRequirements(stepDef(CUSTOM))).toEqual([]);
  });

  it('[D1+] returns nothing for a custom.* step even when the catalog holds an entry under its id', () => {
    mod.setComposableCatalog(new Map([[CUSTOM, entry(CUSTOM, [REQUIRED])]]));

    expect(mod.stepIntegrationRequirements(stepDef(CUSTOM))).toEqual([]);
  });

  it('[D1+] setComposableCatalog replaces the catalog it had', () => {
    mod.setComposableCatalog(new Map([[MODULE_A, entry(MODULE_A, [REQUIRED])]]));
    expect(mod.stepIntegrationRequirements(stepDef(MODULE_A))).toEqual([REQUIRED]);

    mod.setComposableCatalog(new Map([[MODULE_B, entry(MODULE_B, [OPTIONAL])]]));

    expect(mod.stepIntegrationRequirements(stepDef(MODULE_A))).toEqual([]);
    expect(mod.stepIntegrationRequirements(stepDef(MODULE_B))).toEqual([OPTIONAL]);
  });

  it('[D1+] reads nothing before any catalog was set, as the unit tests of the step runner never boot', async () => {
    vi.resetModules();
    const fresh = await stepIntegrationsUnderTest();

    expect(fresh.stepIntegrationRequirements(stepDef(MODULE_A))).toEqual([]);
    expect(fresh.stepIntegrationRequirements(stepDef(CORE))).toEqual([]);
  });

  it('[D1+] exports the four reasons a failure text starts with, with their documented values', () => {
    expect(mod.INTEGRATION_UNRESOLVED_REASON).toBe('integration-unresolved');
    expect(mod.INTEGRATION_PROVIDER_PINNED_REASON).toBe('integration-provider-pinned');
    expect(mod.INTEGRATION_TOOLS_UNLISTABLE_REASON).toBe('integration-tools-unlistable');
    expect(mod.INTEGRATIONS_NO_SIGNING_KEY_REASON).toBe('integrations-no-signing-key');
  });
});
