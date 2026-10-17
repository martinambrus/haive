import { beforeEach, describe, expect, it, vi } from 'vitest';

const CUSTOM_KEY = 'config:taskTypes:customEnabled';
const MODULE_KEY = 'config:taskTypes:moduleEnabled';

const h = vi.hoisted(() => ({
  role: 'admin',
  flags: new Map<string, boolean>(),
  stored: new Map<string, string>(),
  set: vi.fn(async (key: string, value: string) => {
    h.stored.set(key, value);
    h.flags.set(key, value === 'true');
  }),
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    transaction: async (run: (tx: unknown) => unknown) => {
      const tx = {
        execute: async () => [],
        insert: () => ({ values: async () => undefined }),
        transaction: (inner: (t: unknown) => unknown) => inner(tx),
      };
      return run(tx);
    },
  }),
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getFresh: async (key: string) => h.stored.get(key) ?? null,
    getBoolean: async (key: string, fallback: boolean) => h.flags.get(key) ?? fallback,
    set: h.set,
  },
}));

import { Hono } from 'hono';
import { schema, type Database } from '@haive/database';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { HttpError } from '../src/context.js';
import type { AppEnv } from '../src/context.js';
import { definitionForCreate } from '../src/lib/task-type-definition.js';

const defRow = (slug: string, source: string) => ({
  slug,
  enabled: true,
  selectable: true,
  source,
  runListStrategy: 'static',
  stepIds: ['00-a'],
  requiresRepository: true,
  preAnswerDefaults: {},
  stepLoopLimitDefaults: {},
});

const acme = { moduleId: 'acme', name: 'Acme', missingAt: null, deactivatedAt: null };

const handle = (rows: unknown[], modules: unknown[] = [acme]) =>
  ({
    select: () => ({
      from: (table: unknown) =>
        table === schema.stepCatalog
          ? Promise.resolve([])
          : table === schema.modules
            ? { where: () => ({ for: async () => modules }) }
            : { where: () => ({ limit: () => ({ for: async () => rows }) }) },
    }),
  }) as unknown as Pick<Database, 'select'>;

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

beforeEach(() => {
  h.role = 'admin';
  h.flags = new Map();
  h.stored = new Map();
  h.set.mockClear();
});

describe('definitionForCreate and the task type switches', () => {
  const create = (source: string) =>
    definitionForCreate(handle([defRow('x-type', source)]), 'x-type', { generic: false });

  it('refuses an admin-authored type while its switch is off, and allows it when on', async () => {
    const err = await refusal(create('admin'));
    expect([err.status, err.message]).toEqual([
      403,
      'Custom task types are disabled on this install',
    ]);

    h.flags.set(CUSTOM_KEY, true);
    await expect(create('admin')).resolves.toMatchObject({ runListSnapshot: ['00-a'] });
  });

  it('refuses a module type while its switch is off, and allows it when on', async () => {
    const err = await refusal(create('module:acme'));
    expect([err.status, err.message]).toEqual([
      403,
      'Module task types are disabled on this install',
    ]);

    h.flags.set(MODULE_KEY, true);
    await expect(create('module:acme')).resolves.toMatchObject({ runListSnapshot: ['00-a'] });
  });

  it('keeps the two switches apart', async () => {
    h.flags.set(MODULE_KEY, true);
    expect((await refusal(create('admin'))).status).toBe(403);

    h.flags = new Map([[CUSTOM_KEY, true]]);
    expect((await refusal(create('module:acme'))).status).toBe(403);
  });

  describe('a module the type uses', () => {
    const create = (modules: unknown[]) =>
      definitionForCreate(handle([defRow('x-type', 'module:acme')], modules), 'x-type', {
        generic: false,
      });

    beforeEach(() => h.flags.set(MODULE_KEY, true));

    it('refuses a deactivated one with a 409 naming it, and not an active one', async () => {
      const err = await refusal(create([{ ...acme, deactivatedAt: new Date() }]));
      expect([err.status, err.code]).toEqual([409, 'module-deactivated']);
      expect(err.message).toContain('Acme');

      await expect(create([acme])).resolves.toMatchObject({ runListSnapshot: ['00-a'] });
    });

    it('refuses a missing one with a 409 naming it', async () => {
      const err = await refusal(create([{ ...acme, missingAt: new Date() }]));
      expect([err.status, err.code]).toEqual([409, 'module-missing']);
      expect(err.message).toContain('Acme');
    });

    it('refuses one with no row with a 409 naming its id', async () => {
      const err = await refusal(create([]));
      expect([err.status, err.code]).toEqual([409, 'module-missing']);
      expect(err.message).toContain('acme');
    });

    it('reports a missing one before a deactivated one', async () => {
      const err = await refusal(
        create([{ ...acme, missingAt: new Date(), deactivatedAt: new Date() }]),
      );
      expect(err.code).toBe('module-missing');
    });
  });

  it('never touches a built-in, with a row or without', async () => {
    await expect(create('builtin')).resolves.toMatchObject({ runListSnapshot: ['00-a'] });
    await expect(
      definitionForCreate(handle([]), 'plan_merge', { generic: false }),
    ).resolves.toMatchObject({ runListSnapshot: null });
  });
});

describe('/admin/config/task-types', () => {
  const app = new Hono<AppEnv>();
  app.route('/admin', adminRoutes);
  app.onError(errorHandler);
  const send = (method: string, body?: unknown) =>
    app.request('/admin/config/task-types', {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('reports both switches off by default', async () => {
    const res = await send('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ customEnabled: false, moduleEnabled: false });
  });

  it('round-trips a PUT of both flags', async () => {
    const put = await send('PUT', { customEnabled: true, moduleEnabled: false });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ customEnabled: true, moduleEnabled: false });
    expect([...h.stored]).toEqual([
      [CUSTOM_KEY, 'true'],
      [MODULE_KEY, 'false'],
    ]);
    expect(await (await send('GET')).json()).toEqual({ customEnabled: true, moduleEnabled: false });
  });

  it('rejects a body missing a flag', async () => {
    expect((await send('PUT', { customEnabled: true })).status).toBeGreaterThanOrEqual(400);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('refuses a regular user on both verbs, writing nothing', async () => {
    h.role = 'user';
    expect((await send('GET')).status).toBe(403);
    expect((await send('PUT', { customEnabled: true, moduleEnabled: true })).status).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
  });
});
