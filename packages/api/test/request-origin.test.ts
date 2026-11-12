import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/context.js';

const TASK = '11111111-2222-3333-4444-555555555555';

const ensure = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
}));
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: async () => ({ id: TASK }) },
      users: {
        findFirst: async () => ({
          id: 'u1',
          role: 'user',
          status: 'active',
          tokenVersion: 0,
          mustChangePassword: false,
        }),
      },
    },
  }),
}));
vi.mock('../src/auth/jwt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/jwt.js')>()),
  verifyAccessToken: async () => ({ sub: 'u1', role: 'user', tv: 0 }),
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
  vi.stubEnv('HAIVE_PUBLIC_API_URL', '');
  vi.stubEnv('HAIVE_API_PORT', '3001');
  ensure.add.mockReset();
  ensure.add.mockResolvedValue({
    waitUntilFinished: async () => ({ accessUrls: [{ kind: 'database', url: 'mysql://x' }] }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it('from the app or no page goes through', async () => {
    for (const origin of ['http://localhost:3000', undefined]) {
      expect((await post(origin)).status).toBe(404);
    }
  });

  it('from the editor is refused even when Host matches', async () => {
    expect((await post('http://localhost:3001')).status).toBe(403);
  });

  it('under /ide still reaches its handler from the editor', async () => {
    const res = await app.request('/ide/not-an-id/resource', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:3001',
        cookie: 'haive_access=session',
      },
    });
    expect(res.status).toBe(404);
  });

  it('does not exempt /ide-like app paths', async () => {
    expect(
      (
        await app.request('/ide-other', {
          method: 'POST',
          headers: { host: 'localhost:3001', origin: 'http://localhost:3001' },
        })
      ).status,
    ).toBe(403);
  });

  it('is the only kind refused: a read from another page still answers', async () => {
    const res = await app.request('/health', { headers: { origin: 'http://localhost:5173' } });
    expect(res.status).toBe(200);
  });
});

describe('behind a proxy that rewrites Host', () => {
  const post = (app: ReturnType<typeof createApiApp>, origin: string) =>
    app.request('/no-such-route', { method: 'POST', headers: { host: 'api:3001', origin } });

  it("the editor's configured public origin is refused while the app goes through", async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://api.example.com/base/');
    const app = createApiApp('https://haive.example.com');
    expect((await post(app, 'https://haive.example.com')).status).toBe(404);
    expect((await post(app, 'https://api.example.com')).status).toBe(403);
    expect((await post(app, 'https://evil.example.com')).status).toBe(403);
  });

  it("with no public URL, the app's host on the api's published port is refused", async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', '');
    vi.stubEnv('HAIVE_API_PORT', '3001');
    const app = createApiApp('https://haive.example.com');
    expect((await post(app, 'https://haive.example.com:3001')).status).toBe(403);
    expect((await post(app, 'https://haive.example.com:8080')).status).toBe(403);
  });

  it('a whitespace public URL counts as unset and falls through to the published port', async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', '   ');
    vi.stubEnv('HAIVE_API_PORT', ' 3001 ');
    const app = createApiApp('https://haive.example.com');
    expect((await post(app, 'https://haive.example.com:3001')).status).toBe(403);
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
