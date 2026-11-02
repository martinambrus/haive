import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  choices: new Map<string, { providerId: string; connectionId: string | null }>(),
  grants: new Map<string, string>(),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/integrations')>();
  return {
    ...actual,
    // This unit fixture supplies account context; keep real registry/state reads so the
    // category filters and no-modules-table-read control still exercise production code.
    // Real context SQL and ownership remain covered by integration-choice-routes-db.test.ts.
    loadResolverContext: async (db: Database): Promise<ResolverContext> => {
      const states = await actual.loadIntegrationStates(db);
      return {
        ownerUserId: USER,
        repository: null,
        providers: actual.listIntegrationProviders().map((provider) => ({
          id: provider.id,
          categories: provider.categories,
          state: states.providers.get(provider.id) ?? 'disabled',
        })),
        categoryStates: states.categories,
        connections: [],
        choices: h.choices,
        grants: h.grants,
        preferences: new Map(),
        defaults: new Map(),
      };
    },
  };
});

import { Hono } from 'hono';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { registerModuleIntegrations, type ResolverContext } from '@haive/shared/integrations';
import { errorHandler } from '../src/middleware/error-handler.js';
import { taskIntegrationRoutes } from '../src/routes/tasks/integrations.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/tasks', taskIntegrationRoutes);
app.onError(errorHandler);

const moduleOf = (id: string, providers: Record<string, string[]>, categoryIds: string[] = []) => ({
  manifest: {
    id,
    name: `Module ${id}`,
    categories: categoryIds.map((categoryId) => ({ id: categoryId, label: categoryId })),
    integrations: Object.entries(providers).map(([providerId, categories]) => ({
      id: providerId,
      categories,
    })),
  },
});

function setup(options: { withModules: boolean; chosen?: string[]; granted?: string[] }) {
  h.choices = new Map(
    (options.chosen ?? []).map((categoryId) => [
      categoryId,
      { providerId: 'module.fx.crm', connectionId: null },
    ]),
  );
  h.grants = new Map(
    (options.granted ?? []).map((categoryId) => [
      categoryId,
      '00000000-0000-4000-8000-0000000000c1',
    ]),
  );
  const fake = createFakeDb({
    tasks: schema.tasks,
    integrationProviderConfigs: schema.integrationProviderConfigs,
    ...(options.withModules ? { modules: schema.modules } : {}),
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running' });
  const reads: PgTable[] = [];
  const select = fake.db.select.bind(fake.db);
  fake.db.select = (fields) => {
    const query = select(fields);
    return { from: (table) => (reads.push(table), query.from(table)) };
  };
  h.db = fake.db;
  return {
    reads,
    deactivate: (moduleId: string) =>
      fake.insert(schema.modules, {
        moduleId,
        packageName: `@haive/module-${moduleId}`,
        name: `Module ${moduleId}`,
        installedVersion: '1.0.0',
        deactivatedAt: new Date(),
      }),
  };
}

async function listed(): Promise<string[]> {
  const res = await app.request(`/tasks/${TASK}/integrations`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { categories: Array<{ categoryId: string }> };
  return body.categories.map((entry) => entry.categoryId);
}

describe('GET /tasks/:id/integrations', () => {
  afterEach(() => registerModuleIntegrations([]));

  it('lists the categories a core provider serves, and reads no modules table, while no module is registered', async () => {
    const { reads } = setup({ withModules: false });

    expect(await listed()).toEqual(['forge']);
    expect(reads).not.toContain(schema.modules);
  });

  it('lists the categories the providers of a registered module serve, in sorted order', async () => {
    setup({ withModules: true });
    registerModuleIntegrations([
      moduleOf('fx', { 'module.fx.crm': ['module.fx.docs', 'rich-documents'] }, ['module.fx.docs']),
    ] as never);

    expect(await listed()).toEqual(['forge', 'module.fx.docs', 'rich-documents']);
  });

  it('does not list a category a module declares and no provider serves', async () => {
    setup({ withModules: true });
    registerModuleIntegrations([
      moduleOf('fx', { 'module.fx.crm': ['rich-documents'] }, ['module.fx.docs']),
    ] as never);

    expect(await listed()).toEqual(['forge', 'rich-documents']);
  });

  it('leaves out the categories only a deactivated module serves, and keeps those another module or the core serves', async () => {
    const { deactivate } = setup({ withModules: true });
    registerModuleIntegrations([
      moduleOf('fx', { 'module.fx.crm': ['module.fx.docs', 'rich-documents'] }, ['module.fx.docs']),
      moduleOf('gx', { 'module.gx.crm': ['rich-documents', 'mail'] }),
    ] as never);
    deactivate('fx');

    expect(await listed()).toEqual(['forge', 'mail', 'rich-documents']);
  });

  it('keeps the category of a retained grant after its module provider disappears', async () => {
    setup({ withModules: false, granted: ['module.gone.docs'] });

    expect(await listed()).toEqual(['forge', 'module.gone.docs']);
  });

  it('keeps the category of an existing choice, whoever served it', async () => {
    const { deactivate } = setup({ withModules: true, chosen: ['module.fx.docs', 'mail'] });
    registerModuleIntegrations([
      moduleOf('fx', { 'module.fx.crm': ['module.fx.docs'] }, ['module.fx.docs']),
    ] as never);
    deactivate('fx');

    expect(await listed()).toEqual(['forge', 'mail', 'module.fx.docs']);
  });
});
