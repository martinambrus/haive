import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CORE_FORGE_PROVIDER_SPECS } from '../src/forge/provider-specs.js';
import {
  getIntegrationProvider,
  isProviderEnabled,
  listIntegrationCategories,
  listIntegrationProviders,
  loadProviderEnablement,
} from '../src/integrations/index.js';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '../src/modularity/index.js';
import { asLoadedModule, fixtureManifest, type Raw } from './module-integrations-fixtures.js';

const registry = (await import('../src/integrations/index.js')) as {
  registerModuleIntegrations?: (modules: readonly unknown[]) => void;
};

function register(...manifests: Raw[]): void {
  expect(
    typeof registry.registerModuleIntegrations,
    '@haive/shared/integrations does not export registerModuleIntegrations',
  ).toBe('function');
  registry.registerModuleIntegrations!(manifests.map(asLoadedModule));
}

const FX = fixtureManifest('fx');
const GX = fixtureManifest('gx');
const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);
const CORE_PROVIDER_IDS = ids(CORE_FORGE_PROVIDER_SPECS);
const CORE_CATEGORY_IDS = ids(CORE_INTEGRATION_CATEGORY_SPECS);

afterEach(() => registry.registerModuleIntegrations?.([]));

describe('the integration registry of the modules a process loaded', () => {
  describe('with nothing registered', () => {
    it('[K0] lists the core providers and categories alone', () => {
      expect(listIntegrationProviders()).toEqual(CORE_FORGE_PROVIDER_SPECS);
      expect(listIntegrationCategories()).toEqual(CORE_INTEGRATION_CATEGORY_SPECS);
      expect(getIntegrationProvider('module.fx.crm')).toBeUndefined();
    });
  });

  describe('enablement with nothing registered', () => {
    it('[K0] reads the provider configs and no other table, for one provider and for all', async () => {
      const fake = createFakeDb({ integrationProviderConfigs: schema.integrationProviderConfigs });
      fake.insert(schema.integrationProviderConfigs, { providerId: 'gitea', enabled: false });
      const db = fake.db as never;

      expect(await isProviderEnabled(db, 'github')).toBe(true);
      expect(await isProviderEnabled(db, 'gitea')).toBe(false);
      expect(Object.fromEntries(await loadProviderEnablement(db))).toEqual({
        ...Object.fromEntries(CORE_PROVIDER_IDS.map((id) => [id, true])),
        gitea: false,
      });
    });
  });

  describe('listings', () => {
    it('[K2] lists the core providers first, then those of the module in the order it declares', () => {
      const second = { ...FX.integrations[0], id: 'module.fx.mail', categories: ['mail'] };
      register({ ...FX, integrations: [...FX.integrations, second] });

      const listed = listIntegrationProviders();
      expect(ids(listed)).toEqual([...CORE_PROVIDER_IDS, 'module.fx.crm', 'module.fx.mail']);
      expect(listed.slice(0, CORE_PROVIDER_IDS.length)).toEqual(CORE_FORGE_PROVIDER_SPECS);
      expect(listed[CORE_PROVIDER_IDS.length]).toMatchObject(FX.integrations[0]);
      expect(listed[CORE_PROVIDER_IDS.length + 1]).toMatchObject(second);
    });

    it('[K2] finds a provider of the module by id, and the core ones still', () => {
      expect(
        getIntegrationProvider('module.fx.crm'),
        'found before it was registered',
      ).toBeUndefined();

      register(FX);

      expect(getIntegrationProvider('module.fx.crm')).toMatchObject(FX.integrations[0]);
      expect(getIntegrationProvider('github')).toEqual(CORE_FORGE_PROVIDER_SPECS[0]);
      expect(getIntegrationProvider('module.fx.nothing')).toBeUndefined();
    });

    it('[K2] lists the core categories first, then those of the module', () => {
      register(FX);

      const listed = listIntegrationCategories();
      expect(ids(listed)).toEqual([...CORE_CATEGORY_IDS, 'module.fx.docs']);
      expect(listed.slice(0, CORE_CATEGORY_IDS.length)).toMatchObject(
        CORE_INTEGRATION_CATEGORY_SPECS,
      );
      expect(listed[CORE_CATEGORY_IDS.length]).toMatchObject(FX.categories[0]);
    });

    it('[K2+] lists the modules in the order they were registered, each with its own entries', () => {
      register(GX, FX);

      expect(ids(listIntegrationProviders()).slice(CORE_PROVIDER_IDS.length)).toEqual([
        'module.gx.crm',
        'module.fx.crm',
      ]);
      expect(ids(listIntegrationCategories()).slice(CORE_CATEGORY_IDS.length)).toEqual([
        'module.gx.docs',
        'module.fx.docs',
      ]);
    });
  });

  describe('registering again', () => {
    it('[K2] lists the same entries once when the same modules are registered twice', () => {
      register(FX, GX);
      const providers = [...listIntegrationProviders()];
      const categories = [...listIntegrationCategories()];

      register(FX, GX);

      expect(listIntegrationProviders()).toEqual(providers);
      expect(listIntegrationCategories()).toEqual(categories);
      expect(ids(providers).filter((id) => id === 'module.fx.crm')).toHaveLength(1);
      expect(ids(categories).filter((id) => id === 'module.gx.docs')).toHaveLength(1);
    });

    it('[K2] replaces the modules of an earlier registration, none is added to it', () => {
      register(FX);
      register(GX);

      expect(ids(listIntegrationProviders())).toEqual([...CORE_PROVIDER_IDS, 'module.gx.crm']);
      expect(ids(listIntegrationCategories())).toEqual([...CORE_CATEGORY_IDS, 'module.gx.docs']);
      expect(getIntegrationProvider('module.fx.crm')).toBeUndefined();
    });

    it('[K2] registering no module leaves the core entries alone', () => {
      register(FX);
      register();

      expect(listIntegrationProviders()).toEqual(CORE_FORGE_PROVIDER_SPECS);
      expect(listIntegrationCategories()).toEqual(CORE_INTEGRATION_CATEGORY_SPECS);
    });
  });
});
