import { logger } from '@haive/shared';
import { requireAuth } from '../src/middleware/auth.js';
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
describe('editor Fetch Metadata isolation', () => {
  function authenticatedApp(web = 'http://localhost:3000') {
    const app = createApiApp(web);
    app.get('/origin-auth-test', requireAuth, (c) => c.json({ userId: c.get('userId') }));
    return app;
  }
  it('refuses same-origin metadata on every method, including CORS preflights', async () => {
    const app = authenticatedApp();
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/health', {
        method,
        headers: {
          origin: 'http://localhost:3000',
          'sec-fetch-site': 'same-origin',
          'access-control-request-method': 'POST',
        },
      });
      expect(res.status).toBe(403);
    }
  });
  it('refuses same-origin session reads with 403 before authentication', async () => {
    const app = authenticatedApp();
    for (const cookie of ['haive_access=session', '']) {
      const res = await app.request('/origin-auth-test', {
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
      });
      expect(res.status).toBe(403);
    }
    expect(
      (await app.request('/auth/me', { headers: { 'sec-fetch-site': 'same-origin' } })).status,
    ).toBe(403);
  });
  for (const site of [
    'same-site',
    'cross-site',
    'none',
    undefined,
    'same-origin-other',
    'Same-Origin',
  ]) {
    it(`leaves ${site ?? 'absent'} metadata unchanged`, async () => {
      const res = await authenticatedApp().request('/origin-auth-test', {
        headers: { cookie: 'haive_access=session', ...(site ? { 'sec-fetch-site': site } : {}) },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: 'u1' });
    });
  }
  it('exempts only /ide and /ide/ descendants for reads and writes', async () => {
    const app = authenticatedApp();
    for (const path of ['/ide', '/ide/not-an-id', '/ide/not-an-id/resource']) {
      for (const method of ['GET', 'POST']) {
        const headers = { cookie: 'haive_access=session' };
        const baseline = await app.request(path, { method, headers });
        const res = await app.request(path, {
          method,
          headers: { ...headers, 'sec-fetch-site': 'same-origin' },
        });
        expect(res.status).toBe(baseline.status);
      }
    }
    expect(
      (await app.request('/ide-other', { headers: { 'sec-fetch-site': 'same-origin' } })).status,
    ).toBe(403);
  });
  it('recognises one origin when WEB_ORIGIN is spelled differently from the browser Origin', async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://haive.example.com/base');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const app = authenticatedApp('HTTPS://Haive.Example.com:443/');
    app.post('/origin-auth-test', requireAuth, (c) => c.json({ ok: true }));
    const read = await app.request('/origin-auth-test', {
      headers: { cookie: 'haive_access=session', 'sec-fetch-site': 'same-origin' },
    });
    expect(read.status).toBe(200);
    const write = await app.request('/origin-auth-test', {
      method: 'POST',
      headers: { cookie: 'haive_access=session', origin: 'https://haive.example.com' },
    });
    expect(write.status).toBe(200);
  });
  it('lets the app read its api on one origin when the editor has its own hostname', async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://haive.example.com');
    vi.stubEnv('HAIVE_EDITOR_ORIGIN', 'https://ide.example.com');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const app = authenticatedApp('https://haive.example.com');
    const res = await app.request('/origin-auth-test', {
      headers: { cookie: 'haive_access=session', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
  it('keeps one-origin installs working and logs one structured startup warning', async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://haive.example.com/base');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const app = authenticatedApp('https://haive.example.com');
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await app.request('/origin-auth-test', {
            headers: { cookie: 'haive_access=session', 'sec-fetch-site': 'same-origin' },
          })
        ).status,
      ).toBe(200);
    }
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { webOrigin: 'https://haive.example.com', editorOrigin: 'https://haive.example.com' },
      'The editor cannot be isolated without a separate editor hostname',
    );
  });
});
