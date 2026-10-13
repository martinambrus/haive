import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  workerValue: null as string | null,
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
    getFresh: async () => null,
    set: async () => undefined,
    setIfAbsent: async () => undefined,
  },
}));
vi.mock('../src/redis.js', () => ({
  getRedis: () => ({ get: async () => h.workerValue }),
}));

import { Hono } from 'hono';
import { moduleManifestSchema, MODULES_LOADED_WORKER_KEY } from '@haive/shared/modularity';
import { mountModules, moduleRoutes } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
import type { Database } from '@haive/database';
import { HttpError as ModuleHttpError } from '@haive/shared/module-host';

const manifestOf = (id: string) =>
  moduleManifestSchema.parse({ id, name: id, version: '1.2.3', schemaVersion: 1 });

async function buildApp() {
  const app = new Hono<AppEnv>();
  const loaded = await mountModules(
    app,
    [
      {
        packageName: '@haive/module-with-routes',
        manifest: manifestOf('with-routes'),
        routes: () => new Hono<AppEnv>(),
      },
      { packageName: '@haive/module-no-routes', manifest: manifestOf('no-routes') },
    ],
    { db: {} as Database },
  );
  app.route('/modules', moduleRoutes(loaded));
  app.onError(errorHandler);
  return app;
}

describe('module routes', () => {
  it('answers a module HttpError with its own status and hands routes the database', async () => {
    const db = { marker: 'host-db' } as unknown as Database;
    let seen: unknown;
    const app = new Hono<AppEnv>();
    await mountModules(
      app,
      [
        {
          packageName: '@haive/module-teapot',
          manifest: manifestOf('teapot'),
          routes: (ctx) => {
            seen = ctx.db;
            return new Hono<AppEnv>().get('/brew', () => {
              throw new ModuleHttpError(418, 'short and stout');
            });
          },
        },
      ],
      { db },
    );
    app.onError(errorHandler);
    const res = await app.request('/m/teapot/brew');
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'short and stout', code: null });
    expect(seen).toBe(db);
  });
});

describe('GET /modules/loaded', () => {
  it('shares the worker key through the contracts', () => {
    expect(MODULES_LOADED_WORKER_KEY).toBe('haive:modules:loaded:worker');
  });

  it('gives an admin both halves', async () => {
    h.role = 'admin';
    const worker = {
      at: '2026-10-12T00:00:00.000Z',
      modules: [{ id: 'with-routes', packageName: '@haive/module-with-routes', version: '1.2.3' }],
    };
    h.workerValue = JSON.stringify(worker);
    const res = await (await buildApp()).request('/modules/loaded');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      api: {
        modules: [
          {
            id: 'with-routes',
            packageName: '@haive/module-with-routes',
            version: '1.2.3',
            hasRoutes: true,
          },
          {
            id: 'no-routes',
            packageName: '@haive/module-no-routes',
            version: '1.2.3',
            hasRoutes: false,
          },
        ],
      },
      worker,
    });
  });

  it('refuses a user', async () => {
    h.role = 'user';
    h.workerValue = JSON.stringify({ at: 'x', modules: [] });
    const res = await (await buildApp()).request('/modules/loaded');
    expect(res.status).toBe(403);
  });

  it.each([null, 'not json'])('reports no worker half when the key holds %j', async (value) => {
    h.role = 'admin';
    h.workerValue = value;
    const res = await (await buildApp()).request('/modules/loaded');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { worker: unknown }).worker).toBeNull();
  });
});
