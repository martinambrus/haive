import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const OFF = new Date('2026-10-14T08:00:00.000Z');
const DOWN = '2026-10-14T09:30:00.000Z';

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  rows: [] as unknown[],
  report: null as string | null,
  added: [] as unknown[][],
  waits: [] as unknown[][],
  settle: (async () => ({})) as () => Promise<unknown>,
  state: 'active' as string,
  audits: [] as unknown[],
}));

vi.mock('../src/middleware/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...original,
    requireAuth: async (
      c: { set: (key: string, value: string) => void },
      next: () => Promise<void>,
    ) => {
      c.set('userId', ACTOR);
      c.set('userRole', h.role);
      await next();
    },
  };
});
vi.mock('../src/db.js', () => ({
  getDb: () => ({ select: () => ({ from: async () => h.rows }) }),
}));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ get: async () => h.report }) }));
vi.mock('../src/lib/audit.js', () => ({
  recordAuditEvent: async (_db: unknown, event: unknown) => void h.audits.push(event),
  insertAuditEvent: async (_db: unknown, event: unknown) => void h.audits.push(event),
  logAuditEvent: () => {},
}));
vi.mock('../src/modules/activation.js', () => ({
  deactivatedModuleIds: async () => new Set<string>(),
  isModuleDeactivated: async () => false,
  setModuleActive: async () => ({ kind: 'missing' }),
}));
vi.mock('../src/queues.js', () => ({
  getModuleControlQueue: () => ({
    add: async (...args: unknown[]) => {
      h.added.push(args);
      return {
        id: 'job-1',
        waitUntilFinished: (...wait: unknown[]) => {
          h.waits.push(wait);
          return h.settle();
        },
        getState: async () => h.state,
      };
    },
  }),
  getModuleControlQueueEvents: () => 'events',
}));

import { Hono } from 'hono';
import { moduleRoutes, type LoadedApiModule } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const intent = (id: string, over: Record<string, unknown> = {}) => ({
  moduleId: id,
  packageName: `@haive/module-${id}`,
  name: id,
  source: 'local',
  installedVersion: '1.0.0',
  entitlementId: null,
  firstLoadedAt: OFF,
  lastLoadedAt: OFF,
  missingAt: null,
  deactivatedAt: OFF,
  tornDownAt: null,
  updatedAt: OFF,
  ...over,
});
const report = (...ids: string[]) =>
  JSON.stringify({
    at: '2026-10-14T08:30:00.000Z',
    modules: ids.map((id) => ({ id, version: '1.0.0' })),
  });
const apiModule = (id: string): LoadedApiModule => ({
  packageName: `@haive/module-${id}`,
  manifest: { id, name: id, version: '1.0.0', schemaVersion: 1 } as LoadedApiModule['manifest'],
  hasRoutes: false,
});

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route('/modules', moduleRoutes(['alpha', 'beta'].map(apiModule)));
  app.onError(errorHandler);
  return app;
}
const teardown = (id: string) => buildApp().request(`/modules/${id}/teardown`, { method: 'POST' });

it('does not return a structured DB error from a failed teardown', async () => {
  const secret = randomBytes(24).toString('base64url');
  h.state = 'failed';
  h.settle = async () => {
    throw new DrizzleQueryError('select $1', [secret], new Error(secret));
  };
  const res = await teardown('alpha');
  const text = await res.text();
  expect(res.status).toBe(502);
  expect(
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
      text.includes(part),
    ),
  ).toBe(false);
});
const body = async (res: Response) => (await res.json()) as Record<string, unknown>;
const refused = async (res: Response, status: number, code: string | null) => {
  expect([res.status, (await body(res)).code]).toEqual([status, code]);
  expect(h.added).toEqual([]);
  expect(h.audits).toEqual([]);
};

beforeEach(() => {
  h.role = 'admin';
  h.rows = [intent('alpha'), intent('beta', { deactivatedAt: null })];
  h.report = report('alpha', 'beta');
  h.added = [];
  h.waits = [];
  h.settle = async () => ({ moduleId: 'alpha', tornDownAt: DOWN });
  h.state = 'active';
  h.audits = [];
});

describe('POST /modules/:id/teardown, before anything is queued', () => {
  it('refuses a user', async () => {
    h.role = 'user';
    await refused(await teardown('alpha'), 403, null);
  });

  it('answers 404 for a module with no recorded row', async () => {
    await refused(await teardown('ghost'), 404, null);
  });

  it('answers 404 for a module the processes load but nothing recorded', async () => {
    h.rows = [];
    await refused(await teardown('alpha'), 404, null);
  });

  it('answers 409 module_active for a module that is not deactivated', async () => {
    await refused(await teardown('beta'), 409, 'module_active');
  });

  it.each<[string, () => unknown, string?]>([
    ['its missing_at is set', () => (h.rows = [intent('alpha', { missingAt: OFF })])],
    ['the worker has not reported', () => (h.report = null)],
    ['the worker report does not list it', () => (h.report = report('beta'))],
    ['the api does not load it', () => (h.rows = [intent('gamma')]), 'gamma'],
  ])('answers 409 module_missing when %s', async (_label, arrange, id = 'alpha') => {
    arrange();
    await refused(await teardown(id), 409, 'module_missing');
  });
});

describe('POST /modules/:id/teardown, once the module is eligible', () => {
  it('queues one teardown job for the module and answers 200 with the stamp', async () => {
    const res = await teardown('alpha');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moduleId: 'alpha', tornDownAt: DOWN });
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toEqual([
      'teardown',
      { moduleId: 'alpha' },
      expect.objectContaining({ deduplication: { id: 'module-teardown-alpha' } }),
    ]);
    expect(h.waits).toEqual([['events', 120_000]]);
  });

  it('keeps the finished job, so a result that lands before the wait starts is still read', async () => {
    await teardown('alpha');
    const opts = h.added[0]![2] as { removeOnComplete?: unknown; removeOnFail?: unknown };
    expect([typeof opts.removeOnComplete, typeof opts.removeOnFail]).not.toContain('boolean');
    expect(opts.removeOnComplete).toBeDefined();
    expect(opts.removeOnFail).toBeDefined();
  });

  it('audits the request once, with the module id, as soon as the job is queued', async () => {
    await teardown('alpha');
    expect(h.audits).toEqual([
      {
        actorUserId: ACTOR,
        action: 'module.teardown',
        targetType: 'module',
        targetId: null,
        metadata: { moduleId: 'alpha' },
      },
    ]);
  });

  it('answers 409 module_active, and says nothing was recorded, when the module came back meanwhile', async () => {
    h.settle = async () => ({ moduleId: 'alpha', tornDownAt: null });
    const res = await teardown('alpha');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.stringContaining('alpha'),
      code: 'module_active',
    });
    expect(h.audits).toHaveLength(1);
  });

  it("answers 502 with the job's own message when the job failed", async () => {
    h.settle = async () => {
      throw new Error('drop failed: boom');
    };
    h.state = 'failed';
    const res = await teardown('alpha');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'drop failed: boom',
      code: 'module_teardown_failed',
    });
    expect(h.audits).toHaveLength(1);
  });

  it.each(['active', 'waiting', 'prioritized', 'delayed'])(
    'answers 202 running when the wait ends with the job still %s',
    async (state) => {
      h.settle = async () => {
        throw new Error('Job wait teardown timed out before finishing');
      };
      h.state = state;
      const res = await teardown('alpha');
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: 'running' });
      expect(h.audits).toHaveLength(1);
    },
  );
});

describe('GET /modules/loaded', () => {
  it('carries when the teardown ran on each row', async () => {
    h.rows = [intent('alpha', { tornDownAt: new Date(DOWN) }), intent('beta')];
    const res = await buildApp().request('/modules/loaded');
    expect(res.status).toBe(200);
    const { modules } = (await res.json()) as {
      modules: { rows: { id: string; tornDownAt: string | null }[] };
    };
    expect(modules.rows.map((r) => [r.id, r.tornDownAt])).toEqual([
      ['alpha', DOWN],
      ['beta', null],
    ]);
  });
});
