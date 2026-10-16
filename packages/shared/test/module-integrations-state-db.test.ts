import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  isProviderEnabled,
  listIntegrationProviders,
  loadProviderEnablement,
} from '../src/integrations/index.js';
import { asLoadedModule, fixtureManifest } from './module-integrations-fixtures.js';

const url = process.env.MODULE_INTEGRATIONS_STATE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_integrations_state_test'))
  throw new Error(
    'Use a dedicated module_integrations_state_test database for the module integration state tests',
  );

type ProviderState = 'enabled' | 'disabled' | 'module-deactivated' | 'module-missing' | 'unknown';

const shared = (await import('../src/integrations/index.js')) as {
  registerModuleIntegrations?: (modules: readonly unknown[]) => void;
  providerState?: (db: Database, providerId: string) => Promise<ProviderState>;
};

function register(...ids: string[]): void {
  expect(
    typeof shared.registerModuleIntegrations,
    '@haive/shared/integrations does not export registerModuleIntegrations',
  ).toBe('function');
  shared.registerModuleIntegrations!(ids.map((id) => asLoadedModule(fixtureManifest(id))));
}

function providerState(): NonNullable<typeof shared.providerState> {
  expect(
    typeof shared.providerState,
    '@haive/shared/integrations does not export providerState',
  ).toBe('function');
  return shared.providerState!;
}

const FX = 'module.fx.crm';
const GX = 'module.gx.crm';
const CORE_IDS = ['github', 'gitea', 'gitlab', 'bitbucket_cloud', 'bitbucket_server'];

describe.skipIf(!url)('the state of a module provider, on Postgres', () => {
  let db: Database;

  const setConfig = (providerId: string, enabled: boolean) =>
    db
      .insert(schema.integrationProviderConfigs)
      .values({ providerId, enabled })
      .onConflictDoUpdate({
        target: schema.integrationProviderConfigs.providerId,
        set: { enabled },
      });
  const setModule = (moduleId: string, deactivatedAt: Date | null) =>
    db
      .insert(schema.modules)
      .values({
        moduleId,
        packageName: `@haive/module-${moduleId}`,
        name: `Module ${moduleId}`,
        installedVersion: '1.0.0',
        deactivatedAt,
      })
      .onConflictDoUpdate({ target: schema.modules.moduleId, set: { deactivatedAt } });
  const reactivate = (moduleId: string) =>
    db
      .update(schema.modules)
      .set({ deactivatedAt: null })
      .where(eq(schema.modules.moduleId, moduleId));

  async function clean() {
    await db.delete(schema.integrationProviderConfigs);
    await db.delete(schema.modules).where(inArray(schema.modules.moduleId, ['fx', 'gx', 'zz']));
  }

  beforeAll(async () => {
    db = createDatabase(url as string);
    await clean();
  });

  beforeEach(clean);

  afterEach(() => shared.registerModuleIntegrations?.([]));

  afterAll(async () => {
    await clean();
    await db.$client.end({ timeout: 5 });
  });

  describe('with no config row', () => {
    it('[K3] is off: disabled, not enabled, and mapped to false', async () => {
      register('fx', 'gx');
      await setModule('fx', null);

      expect(await providerState()(db, FX)).toBe('disabled');
      expect(await isProviderEnabled(db, FX)).toBe(false);
      expect((await loadProviderEnablement(db)).get(FX)).toBe(false);
    });

    it('[K3+] treats a module with no modules row as not deactivated', async () => {
      register('fx', 'gx');
      expect(await providerState()(db, FX)).toBe('disabled');
      await setConfig(FX, true);
      expect(await providerState()(db, FX)).toBe('enabled');
      expect(await isProviderEnabled(db, FX)).toBe(true);
    });
  });

  describe('with a config row', () => {
    it('[K3] is enabled under a row switched on, in all three readers', async () => {
      register('fx', 'gx');
      await setModule('fx', null);
      await setConfig(FX, true);

      expect(await providerState()(db, FX)).toBe('enabled');
      expect(await isProviderEnabled(db, FX)).toBe(true);
      expect((await loadProviderEnablement(db)).get(FX)).toBe(true);
    });

    it('[K3] is disabled under a row switched off, in all three readers', async () => {
      register('fx', 'gx');
      await setModule('fx', null);
      await setConfig(FX, false);

      expect(await providerState()(db, FX)).toBe('disabled');
      expect(await isProviderEnabled(db, FX)).toBe(false);
      expect((await loadProviderEnablement(db)).get(FX)).toBe(false);
    });
  });

  describe('when its module is deactivated', () => {
    it('[K3] reads module-deactivated under a row switched on, and is not enabled', async () => {
      register('fx', 'gx');
      await setConfig(FX, true);
      await setModule('fx', new Date());

      expect(await providerState()(db, FX)).toBe('module-deactivated');
      expect(await isProviderEnabled(db, FX)).toBe(false);
      expect((await loadProviderEnablement(db)).get(FX)).toBe(false);
    });

    it('[K3] reads the deactivation live: reactivating the module turns the provider on again', async () => {
      register('fx', 'gx');
      await setConfig(FX, true);
      await setModule('fx', new Date());
      expect(await providerState()(db, FX)).toBe('module-deactivated');

      await reactivate('fx');

      expect(await providerState()(db, FX)).toBe('enabled');
      expect(await isProviderEnabled(db, FX)).toBe(true);
      expect((await loadProviderEnablement(db)).get(FX)).toBe(true);

      await setModule('fx', new Date());
      expect(await providerState()(db, FX)).toBe('module-deactivated');
      expect(await isProviderEnabled(db, FX)).toBe(false);
    });

    it('[K3] turns off the providers of that module only', async () => {
      register('fx', 'gx');
      await setConfig(FX, true);
      await setConfig(GX, true);
      await setModule('fx', new Date());
      await setModule('gx', null);

      expect(await providerState()(db, GX)).toBe('enabled');
      expect(await isProviderEnabled(db, GX)).toBe(true);
      const enablement = await loadProviderEnablement(db);
      expect(enablement.get(FX)).toBe(false);
      expect(enablement.get(GX)).toBe(true);
    });
  });

  describe('when no loaded module declares it', () => {
    it('[K3] reads module-missing for a module id nothing registered, row or no row', async () => {
      register('fx', 'gx');
      const ghost = 'module.zz.crm';
      expect(await providerState()(db, ghost)).toBe('module-missing');

      await setConfig(ghost, true);
      await setModule('zz', null);

      expect(await providerState()(db, ghost)).toBe('module-missing');
    });

    it('[K3+] reads module-missing for a module id that an empty registration dropped', async () => {
      register('fx', 'gx');
      await setConfig(FX, true);
      expect(await providerState()(db, FX)).toBe('enabled');

      shared.registerModuleIntegrations!([]);

      expect(await providerState()(db, FX)).toBe('module-missing');
    });

    it('[K3+] reads unknown for an id of the core grammar that nothing registers', async () => {
      expect(await providerState()(db, 'nosuchforge')).toBe('unknown');
    });
  });

  describe('core providers', () => {
    it('[K3+] read enabled with no row and disabled under a row switched off, whatever the modules table holds', async () => {
      await setModule('fx', new Date());
      expect(await providerState()(db, 'github')).toBe('enabled');

      await setConfig('github', false);
      expect(await providerState()(db, 'github')).toBe('disabled');
      expect(await providerState()(db, 'gitea')).toBe('enabled');
    });

    it('[K0] keep the switch they had: on with no row, off under a row switched off', async () => {
      await setConfig('gitlab', false);

      expect(await isProviderEnabled(db, 'github')).toBe(true);
      expect(await isProviderEnabled(db, 'gitlab')).toBe(false);
      const enablement = await loadProviderEnablement(db);
      expect(CORE_IDS.map((id) => [id, enablement.get(id)])).toEqual([
        ['github', true],
        ['gitea', true],
        ['gitlab', false],
        ['bitbucket_cloud', true],
        ['bitbucket_server', true],
      ]);
    });
  });

  describe('loadProviderEnablement', () => {
    it('[K3] maps every registered provider, core then module, with the deactivation folded in', async () => {
      register('fx', 'gx');
      await setConfig(FX, true);
      await setConfig(GX, true);
      await setModule('fx', new Date());
      await setModule('gx', null);

      const enablement = await loadProviderEnablement(db);

      expect([...enablement.keys()].sort()).toEqual(
        listIntegrationProviders()
          .map((spec) => spec.id)
          .sort(),
      );
      expect(Object.fromEntries(enablement)).toEqual({
        ...Object.fromEntries(CORE_IDS.map((id) => [id, true])),
        [FX]: false,
        [GX]: true,
      });
    });
  });
});
