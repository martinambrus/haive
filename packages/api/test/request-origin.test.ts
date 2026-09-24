import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/context.js';

const TASK = '11111111-2222-3333-4444-555555555555';

const ensure = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
}));
vi.mock('../src/db.js', () => ({
  getDb: () => ({ query: { tasks: { findFirst: async () => ({ id: TASK }) } } }),
}));
vi.mock('../src/queues.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues.js')>()),
  getRuntimeEnsureQueue: () => ensure,
  getRuntimeEnsureQueueEvents: () => ({}),
}));

const { createApiApp } = await import('../src/index.js');
const { browserAccessRoutes } = await import('../src/routes/tasks/browser-access.js');
const { errorHandler } = await import('../src/middleware/error-handler.js');

beforeEach(() => {
  ensure.add.mockReset();
  ensure.add.mockResolvedValue({
    waitUntilFinished: async () => ({ accessUrls: [{ kind: 'database', url: 'mysql://x' }] }),
  });
});

describe('a state-changing request', () => {
  const app = createApiApp('http://localhost:3000');
  const post = (origin?: string) =>
    app.request('/no-such-route', {
      method: 'POST',
      headers: { host: 'localhost:3001', ...(origin ? { origin } : {}) },
    });

  it('from another page is refused', async () => {
    for (const origin of ['http://localhost:5173', 'null']) {
      const res = await post(origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Refused a request from another page' });
    }
  });

  it('from the app, the api itself or no page goes through', async () => {
    for (const origin of ['http://localhost:3000', 'http://localhost:3001', undefined]) {
      expect((await post(origin)).status).toBe(404);
    }
  });

  it('is the only kind refused: a read from another page still answers', async () => {
    const res = await app.request('/health', { headers: { origin: 'http://localhost:5173' } });
    expect(res.status).toBe(200);
  });
});

describe('the runtime access routes', () => {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  app.route('/tasks', browserAccessRoutes);
  app.onError(errorHandler);

  for (const path of ['access-urls', 'db-access']) {
    it(`boot no runtime on a GET (${path})`, async () => {
      const res = await app.request(`/tasks/${TASK}/${path}`);
      expect(res.status).toBe(404);
      expect(ensure.add).not.toHaveBeenCalled();
    });

    it(`boot it on a POST (${path})`, async () => {
      const res = await app.request(`/tasks/${TASK}/${path}`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(ensure.add).toHaveBeenCalledTimes(1);
    });
  }
});
