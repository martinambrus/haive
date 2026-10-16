import { afterEach, describe, expect, it } from 'vitest';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  isProviderEnabled,
  listIntegrationModules,
  loadDeactivatedModuleIds,
  loadProviderEnablement,
  providerState,
  registerModuleIntegrations,
} from '../src/integrations/index.js';
import { asLoadedModule, fixtureManifest, without } from './module-integrations-fixtures.js';

const FX = 'module.fx.crm';
const GX = 'module.gx.crm';

function setup() {
  const fake = createFakeDb({
    integrationProviderConfigs: schema.integrationProviderConfigs,
    modules: schema.modules,
  });
  const reads: PgTable[] = [];
  const select = fake.db.select.bind(fake.db);
  fake.db.select = (fields) => {
    const query = select(fields);
    return { from: (table) => (reads.push(table), query.from(table)) };
  };
  const db = fake.db as unknown as Database;
  return {
    db,
    reads,
    setConfig: (providerId: string, enabled: boolean) =>
      fake.insert(schema.integrationProviderConfigs, { providerId, enabled }),
    setModule: (moduleId: string, deactivated: boolean) =>
      fake.insert(schema.modules, {
        moduleId,
        packageName: `@haive/module-${moduleId}`,
        name: `Module ${moduleId}`,
        installedVersion: '1.0.0',
        deactivatedAt: deactivated ? new Date() : null,
      }),
  };
}

const register = (...ids: string[]) =>
  registerModuleIntegrations(ids.map((id) => asLoadedModule(fixtureManifest(id))) as never);

afterEach(() => registerModuleIntegrations([]));

describe('the modules a process registered', () => {
  it('lists each with its name and what it declares, and defaults what the manifest leaves out', () => {
    registerModuleIntegrations([
      asLoadedModule(fixtureManifest('fx')),
      asLoadedModule(without(without(fixtureManifest('gx'), 'integrations'), 'categories')),
    ] as never);

    expect(listIntegrationModules().map((module) => [module.id, module.name])).toEqual([
      ['fx', 'Module fx'],
      ['gx', 'Module gx'],
    ]);
    expect(listIntegrationModules()[0]!.providers.map((provider) => provider.id)).toEqual([FX]);
    expect(listIntegrationModules()[0]!.categories.map((category) => category.id)).toEqual([
      'module.fx.docs',
    ]);
    expect(listIntegrationModules()[1]).toMatchObject({ providers: [], categories: [] });
  });

  it('lists none after an empty registration', () => {
    register('fx');
    registerModuleIntegrations([]);

    expect(listIntegrationModules()).toEqual([]);
  });
});

describe('what reads the modules table', () => {
  it('is nothing while no module is registered: not one provider, not the list of deactivated ids', async () => {
    const { db, reads } = setup();

    await isProviderEnabled(db, 'github');
    await providerState(db, 'github');
    await loadProviderEnablement(db);
    expect(await loadDeactivatedModuleIds(db)).toEqual(new Set());

    expect(reads).not.toContain(schema.modules);
  });

  it('is nothing for a core provider while modules are registered', async () => {
    const { db, reads } = setup();
    register('fx');

    expect(await isProviderEnabled(db, 'github')).toBe(true);
    expect(await providerState(db, 'github')).toBe('enabled');

    expect(reads).not.toContain(schema.modules);
  });

  it('is one query for the whole map, and one for a single module provider', async () => {
    const { db, reads, setConfig } = setup();
    register('fx', 'gx');
    setConfig(FX, true);

    await loadProviderEnablement(db);
    expect(reads.filter((table) => table === schema.modules)).toHaveLength(1);

    reads.length = 0;
    await isProviderEnabled(db, FX);
    expect(reads.filter((table) => table === schema.modules)).toHaveLength(1);
  });

  it('is nothing for a module provider the admin switch already leaves off', async () => {
    const { db, reads } = setup();
    register('fx');

    expect(await isProviderEnabled(db, FX)).toBe(false);

    expect(reads).not.toContain(schema.modules);
  });
});

describe('the deactivated modules', () => {
  it('are read at each call, so a module deactivated after the first read is seen', async () => {
    const { db, setModule } = setup();
    register('fx', 'gx');

    expect(await loadDeactivatedModuleIds(db)).toEqual(new Set());
    setModule('fx', true);
    setModule('gx', false);

    expect(await loadDeactivatedModuleIds(db)).toEqual(new Set(['fx']));
  });
});

describe('the state of a module provider', () => {
  it('reads module-deactivated before the admin switch: off or on, with a row or without', async () => {
    const { db, setConfig, setModule } = setup();
    register('fx', 'gx');
    setModule('fx', true);
    setModule('gx', true);
    setConfig(GX, false);

    expect(await providerState(db, FX)).toBe('module-deactivated');
    expect(await providerState(db, GX)).toBe('module-deactivated');
    setConfig(FX, true);
    expect(await providerState(db, FX)).toBe('module-deactivated');
  });

  it('keeps a deactivated module registered, with its providers off in every reader', async () => {
    const { db, setConfig, setModule } = setup();
    register('fx');
    setConfig(FX, true);
    setModule('fx', true);

    expect(await isProviderEnabled(db, FX)).toBe(false);
    expect((await loadProviderEnablement(db)).get(FX)).toBe(false);
    expect(listIntegrationModules().map((module) => module.id)).toEqual(['fx']);
  });

  it('reads module-missing for a module id nothing registered and unknown for anything else', async () => {
    const { db, setConfig } = setup();
    register('fx');
    setConfig('module.zz.crm', true);

    expect(await providerState(db, 'module.zz.crm')).toBe('module-missing');
    expect(await providerState(db, 'nosuchforge')).toBe('unknown');
    expect(await providerState(db, 'Not A Provider')).toBe('unknown');
  });
});
