import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { registerModuleIntegrations } from '@haive/shared/integrations';
import { requireValidChoice } from '../src/lib/integration-choice.js';
import type { Database } from '../src/db.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const DOCS = 'module.fx.docs';
const CRM = 'module.fx.crm';

const FX = {
  manifest: {
    id: 'fx',
    name: 'Module fx',
    categories: [{ id: DOCS, label: 'Docs' }],
    integrations: [{ id: CRM, displayName: 'Fx crm', categories: [DOCS, 'rich-documents'] }],
  },
};

function setup() {
  const fake = createFakeDb({
    integrationProviderConfigs: schema.integrationProviderConfigs,
    modules: schema.modules,
  });
  registerModuleIntegrations([FX] as never);
  return {
    db: fake.db as unknown as Database,
    switchOn: () =>
      fake.insert(schema.integrationProviderConfigs, { providerId: CRM, enabled: true }),
    deactivate: () =>
      fake.insert(schema.modules, {
        moduleId: 'fx',
        packageName: '@haive/module-fx',
        name: 'Module fx',
        installedVersion: '1.0.0',
        deactivatedAt: new Date(),
      }),
  };
}

const pick = (categoryId: string, providerId: string) => ({
  categoryId,
  providerId,
  connectionId: null,
});

describe('requireValidChoice and the categories of the modules', () => {
  afterEach(() => registerModuleIntegrations([]));

  it('takes a module category with an enabled provider of that module', async () => {
    const { db, switchOn } = setup();
    switchOn();

    await expect(requireValidChoice(db, USER, pick(DOCS, CRM))).resolves.toBeNull();
  });

  it('takes a provider of a module for a core category it serves', async () => {
    const { db, switchOn } = setup();
    switchOn();

    await expect(requireValidChoice(db, USER, pick('rich-documents', CRM))).resolves.toBeNull();
  });

  it('refuses a module provider no admin switched on, and that of a deactivated module, with 409', async () => {
    const { db, switchOn, deactivate } = setup();

    await expect(requireValidChoice(db, USER, pick(DOCS, CRM))).rejects.toMatchObject({
      status: 409,
    });

    switchOn();
    deactivate();

    await expect(requireValidChoice(db, USER, pick(DOCS, CRM))).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a provider that does not serve the module category, with 400', async () => {
    const { db } = setup();

    await expect(requireValidChoice(db, USER, pick(DOCS, 'github'))).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('does not serve this category'),
    });
  });

  it('refuses the category of a module nothing registered, with 400', async () => {
    const { db, switchOn } = setup();
    switchOn();
    registerModuleIntegrations([]);

    await expect(requireValidChoice(db, USER, pick(DOCS, CRM))).rejects.toMatchObject({
      status: 400,
      message: 'Unknown integration category',
    });
  });
});
