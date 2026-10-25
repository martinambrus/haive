import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/auth/jwt.js', async (original) => ({
  ...(await original<typeof import('../src/auth/jwt.js')>()),
  verifyAccessToken: h.verify,
}));
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      users: {
        findFirst: async () => ({
          id: 'synthetic-user',
          role: 'user',
          status: 'active',
          tokenVersion: 0,
          mustChangePassword: false,
        }),
      },
    },
  }),
}));
import type { AppEnv } from '../src/context.js';
import { requireAuth } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { authenticateUpgrade } from '../src/lib/upgrade-auth.js';

const app = new Hono<AppEnv>()
  .onError(errorHandler)
  .get('/', requireAuth, (c) => c.json({ ok: true }));
afterEach(() => {
  h.verify.mockReset();
});

describe('HTTP and WebSocket access-cookie readers', () => {
  it.each([
    ['haive_access=synthetic-session', 200],
    ['other=x; haive_access\t=synthetic-session', 200],
    ['other=x; \u00a0haive_access=synthetic-session', 401],
    ['haive_access="synthetic-session"', 200],
    ['haive_access=%73ynthetic-session', 200],
    ['haive_access=wrong; haive_access=synthetic-session', 401],
    ['haive_access=synthetic-session; haive_access=wrong', 200],
    ['haive_access=%E0%A4%A', 401],
    ['haive_access=', 401],
    ['other=synthetic-session', 401],
  ] as const)('read %j alike (%i)', async (cookie, status) => {
    h.verify.mockImplementation(async (token: string) => {
      if (token !== 'synthetic-session') throw new Error('synthetic invalid JWT');
      return { sub: 'synthetic-user', role: 'user', tv: 0 };
    });
    const http = await app.request('/', { headers: { cookie } });
    expect(http.status).toBe(status);
    const httpTokens = h.verify.mock.calls.map(([token]) => token);
    h.verify.mockClear();
    const req = { headers: { cookie }, socket: new EventEmitter() } as unknown as IncomingMessage;
    const upgrade = await authenticateUpgrade(req);
    try {
      expect(upgrade ? 200 : 401).toBe(http.status);
      expect(h.verify.mock.calls.map(([token]) => token)).toEqual(httpTokens);
    } finally {
      upgrade?.session.dispose();
    }
  });
});
