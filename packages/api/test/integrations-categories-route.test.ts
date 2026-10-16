import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

import { Hono } from 'hono';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { secretsService } from '@haive/shared';
import { registerModuleIntegrations } from '@haive/shared/integrations';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { integrationsRoutes } from '../src/routes/integrations.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';

const app = new Hono<AppEnv>();
app.route('/integrations', integrationsRoutes);
app.onError(errorHandler);

const CORE = CORE_INTEGRATION_CATEGORY_SPECS.map((spec) => ({
  id: spec.id,
  label: spec.label,
  moduleId: null,
  moduleName: null,
}));

const moduleOf = (id: string, categoryIds: string[] = [`module.${id}.docs`]) => ({
  manifest: {
    id,
    name: `Module ${id}`,
    categories: categoryIds.map((categoryId) => ({
      id: categoryId,
      label: `Label of ${categoryId}`,
      ...(categoryId.endsWith('.docs') ? { description: `What ${id} files` } : {}),
    })),
  },
});
const register = (...modules: ReturnType<typeof moduleOf>[]) =>
  registerModuleIntegrations(modules as never);

function setup(options: { withModules: boolean }) {
  const fake = createFakeDb({
    users: schema.users,
    ...(options.withModules ? { modules: schema.modules } : {}),
  });
  fake.insert(schema.users, { id: USER, role: 'user', status: 'active', tokenVersion: 0 });
  const reads: PgTable[] = [];
  const select = fake.db.select.bind(fake.db);
  fake.db.select = (fields) => {
    const query = select(fields);
    return { from: (table) => (reads.push(table), query.from(table)) };
  };
  h.db = fake.db;
  const setModule = (moduleId: string, deactivated: boolean) =>
    fake.insert(schema.modules, {
      moduleId,
      packageName: `@haive/module-${moduleId}`,
      name: `Module ${moduleId}`,
      installedVersion: '1.0.0',
      deactivatedAt: deactivated ? new Date() : null,
    });
  return { fake, reads, setModule };
}

async function get(signedIn = true) {
  const token = signedIn ? await signAccessToken({ sub: USER, role: 'user', tv: 0 }) : null;
  const res = await app.request('/integrations/categories', {
    headers: token ? { cookie: `${ACCESS_COOKIE}=${token}` } : {},
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('GET /integrations/categories', () => {
  beforeEach(() => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    registerModuleIntegrations([]);
  });

  it('answers 401 to a caller with no session', async () => {
    setup({ withModules: false });

    expect((await get(false)).status).toBe(401);
    expect((await get()).status).toBe(200);
  });

  it('lists the core categories alone, with no owner, and reads no modules table, while no module is registered', async () => {
    const { reads } = setup({ withModules: false });

    const reply = await get();

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ categories: CORE });
    expect(reads).not.toContain(schema.modules);
  });

  it('lists the categories of the registered modules after the core ones, each with its module', async () => {
    setup({ withModules: true });
    register(moduleOf('gx', ['module.gx.docs', 'module.gx.mail']), moduleOf('fx'));

    const reply = await get();

    expect(reply.status).toBe(200);
    expect(reply.body.categories.slice(0, CORE.length)).toEqual(CORE);
    expect(reply.body.categories.slice(CORE.length)).toEqual([
      {
        id: 'module.gx.docs',
        label: 'Label of module.gx.docs',
        description: 'What gx files',
        moduleId: 'gx',
        moduleName: 'Module gx',
      },
      {
        id: 'module.gx.mail',
        label: 'Label of module.gx.mail',
        moduleId: 'gx',
        moduleName: 'Module gx',
      },
      {
        id: 'module.fx.docs',
        label: 'Label of module.fx.docs',
        description: 'What fx files',
        moduleId: 'fx',
        moduleName: 'Module fx',
      },
    ]);
  });

  it('leaves out the categories of a deactivated module only, and lists them again once it is active', async () => {
    const { fake, setModule } = setup({ withModules: true });
    register(moduleOf('fx'), moduleOf('gx'));
    const off = setModule('fx', true);
    setModule('gx', false);
    const ids = async () => (await get()).body.categories.map((category: any) => category.id);

    expect(await ids()).toEqual([...CORE.map((core) => core.id), 'module.gx.docs']);

    fake.patch(schema.modules, off.id as string, { deactivatedAt: null });

    expect(await ids()).toEqual([
      ...CORE.map((core) => core.id),
      'module.fx.docs',
      'module.gx.docs',
    ]);
  });

  it('lists the categories of a registered module the modules table does not know yet', async () => {
    setup({ withModules: true });
    register(moduleOf('fx'));

    const reply = await get();

    expect(reply.body.categories.at(-1)).toMatchObject({ id: 'module.fx.docs', moduleId: 'fx' });
  });
});
