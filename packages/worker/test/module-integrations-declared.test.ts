import { afterEach, describe, expect, it } from 'vitest';
import { registerModuleIntegrations } from '@haive/shared/integrations';
import type { ComposableStepEntry, IntegrationRequirement } from '@haive/shared/modularity';
import { assertModuleIntegrationsDeclared } from '../src/step-engine/step-integrations.js';

const FX = {
  manifest: {
    id: 'fx',
    name: 'Module fx',
    categories: [{ id: 'module.fx.docs', label: 'Docs' }],
    integrations: [{ id: 'module.fx.crm', categories: ['module.fx.docs'] }],
  },
};

const catalog = (...entries: Array<[string, IntegrationRequirement[]?]>) =>
  new Map(
    entries.map(([stepId, integrations]) => [
      stepId,
      {
        stepId,
        label: stepId,
        group: 'g',
        dispatchesCli: true,
        requires: [],
        provides: [],
        ...(integrations === undefined ? {} : { integrations }),
      } satisfies ComposableStepEntry,
    ]),
  );
const need = (target: { category: string } | { provider: string }): IntegrationRequirement[] => [
  { id: 'need', access: 'read', ...target },
];

describe('a catalog entry requiring a module category or provider', () => {
  afterEach(() => registerModuleIntegrations([]));

  it('is accepted when a registered module declares it, and when it names a core category or provider', () => {
    registerModuleIntegrations([FX] as never);

    expect(() =>
      assertModuleIntegrationsDeclared(
        catalog(
          ['a-step', need({ category: 'module.fx.docs' })],
          ['b-step', need({ provider: 'module.fx.crm' })],
          ['c-step', need({ category: 'mail' })],
          ['d-step', need({ provider: 'github' })],
          ['e-step'],
        ),
      ),
    ).not.toThrow();
  });

  it.each([
    ['a category', { category: 'module.fx.docs' }, 'module.fx.docs'],
    ['a provider', { provider: 'module.fx.crm' }, 'module.fx.crm'],
  ] as const)(
    'is refused with no module registered, naming the step and %s',
    (_kind, target, id) => {
      expect(() =>
        assertModuleIntegrationsDeclared(catalog(['a-step'], ['b-step', need(target)])),
      ).toThrow(new RegExp(`b-step.*${id.replaceAll('.', '\\.')}`));
    },
  );

  it('is refused when only another module declares it', () => {
    registerModuleIntegrations([FX] as never);

    expect(() =>
      assertModuleIntegrationsDeclared(catalog(['a-step', need({ category: 'module.gx.docs' })])),
    ).toThrow(/a-step.*module\.gx\.docs/);
    expect(() =>
      assertModuleIntegrationsDeclared(catalog(['a-step', need({ provider: 'module.gx.crm' })])),
    ).toThrow(/a-step.*module\.gx\.crm/);
  });

  it('is refused for a category the module names but does not declare', () => {
    registerModuleIntegrations([FX] as never);

    expect(() =>
      assertModuleIntegrationsDeclared(catalog(['a-step', need({ category: 'module.fx.other' })])),
    ).toThrow(/a-step.*module\.fx\.other/);
  });
});
