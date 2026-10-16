import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared/integrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/integrations')>()),
  resolveTaskCategories: async (_db: unknown, args: { categories: readonly string[] }) =>
    args.categories.map((category) => ({ category, status: 'unresolved', reason: 'no-provider' })),
}));

import { Hono } from 'hono';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { registerModuleIntegrations } from '@haive/shared/integrations';
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

function setup(options: { withModules: boolean; chosen?: string[] }) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskIntegrationChoices: schema.taskIntegrationChoices,
    ...(options.withModules ? { modules: schema.modules } : {}),
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running' });
  for (const categoryId of options.chosen ?? []) {
    fake.insert(schema.taskIntegrationChoices, {
      taskId: TASK,
      categoryId,
      providerId: 'module.fx.crm',
    });
  }
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
  const body = (await res.json()) as { categories: Array<{ category: string }> };
  return body.categories.map((entry) => entry.category);
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

  it('keeps the category of an existing choice, whoever served it', async () => {
    const { deactivate } = setup({ withModules: true, chosen: ['module.fx.docs', 'mail'] });
    registerModuleIntegrations([
      moduleOf('fx', { 'module.fx.crm': ['module.fx.docs'] }, ['module.fx.docs']),
    ] as never);
    deactivate('fx');

    expect(await listed()).toEqual(['forge', 'mail', 'module.fx.docs']);
  });
});
