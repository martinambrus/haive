import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { signTaskToken } from '@haive/shared/task-token';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../src/queues.js', () => ({
  getRuntimeEnsureQueue: () => ({ add: h.add }),
  getRuntimeEnsureQueueEvents: vi.fn(),
  getModuleSourceQueue: () => ({ add: h.add }),
  getDdevControlQueue: () => ({ add: h.add }),
  getDdevControlQueueEvents: vi.fn(),
}));
import { browserAccessRoutes } from '../src/routes/tasks/browser-access.js';
import { moduleSourceRoutes } from '../src/modules/sources.js';
import { ddevControlRoutes } from '../src/routes/ddev-control.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const ID = '00000000-0000-4000-8000-000000000001';
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', ID);
  await next();
});
app.route('/tasks', browserAccessRoutes);
app.route('/sources', moduleSourceRoutes());
app.route('/ddev', ddevControlRoutes);
app.onError(errorHandler);
let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
  vi.stubEnv('CONFIG_ENCRYPTION_KEY', 'queue-bound-test-key');
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  fake = createFakeDb({
    tasks: schema.tasks,
    moduleSources: schema.moduleSources,
    auditEvents: schema.auditEvents,
  });
  fake.insert(schema.tasks, { id: ID, userId: ID });
  fake.insert(schema.moduleSources, {
    id: ID,
    moduleId: 'alpha',
    kind: 'git',
    fetchStatus: 'fetched',
    updatedAt: new Date(),
  });
  h.db = fake.db;
  h.add.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(['hang', 'reject'])(
  'bounds a best-effort module fetch wake-up (%s), keeping its committed outbox and 202',
  async (mode) => {
    h.add.mockImplementation(() =>
      mode === 'hang' ? new Promise(() => {}) : Promise.reject(new Error('redis private host')),
    );
    let response: Response | undefined;
    const pending = Promise.resolve(
      app.request(`/sources/${ID}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ).then((r) => {
      response = r;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(response?.status).toBe(202);
    await pending;
    expect(fake.rows(schema.moduleSources)[0]).toMatchObject({ fetchStatus: 'queued' });
    expect(fake.rows(schema.auditEvents)).toHaveLength(1);
  },
);

it.each(['access-urls', 'db-access', 'open-mailpit'])(
  'bounds %s and preserves its 202 pending response',
  async (path) => {
    h.add.mockImplementation(() => new Promise(() => {}));
    let response: Response | undefined;
    const pending = Promise.resolve(app.request(`/tasks/${ID}/${path}`, { method: 'POST' })).then(
      (r) => {
        response = r;
      },
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(response?.status).toBe(202);
    expect(await response!.json()).toMatchObject({ pending: true });
    await pending;
  },
);

it.each(['hang', 'reject'])(
  'bounds an explicit ddev action (%s) and answers a safe 503 refusal',
  async (mode) => {
    h.add.mockImplementation(() =>
      mode === 'hang' ? new Promise(() => {}) : Promise.reject(new Error('redis private host')),
    );
    const token = signTaskToken({ aud: 'ddev', taskId: ID }, process.env.CONFIG_ENCRYPTION_KEY!);
    let response: Response | undefined;
    const pending = Promise.resolve(
      app.request('/ddev/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).then((r) => {
      response = r;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(response?.status).toBe(503);
    expect(await response!.json()).toEqual({
      error: 'Queue temporarily unavailable, try again shortly',
      code: 'queue_unavailable',
    });
    await pending;
  },
);
