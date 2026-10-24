import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  compare: vi.fn(),
  hash: vi.fn(),
}));
vi.mock('../src/auth/password.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/password.js')>()),
  verifyPassword: h.compare,
  hashPassword: h.hash,
}));
vi.mock('../src/lib/auth-throttle.js', () => ({
  reserveAuthAttempt: async () => ({ refund: async () => {} }),
}));
vi.mock('../src/db.js', () => {
  const tx = {
    insert: () => ({ values: async () => {} }),
    execute: async () => {},
    query: { users: { findFirst: async () => h.user } },
  };
  return { getDb: () => ({ ...tx, transaction: async (fn: (t: unknown) => unknown) => fn(tx) }) };
});
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  decryptEmail: () => 'synthetic@login.test.local',
  configService: { getEncryptionKey: async () => 'ab'.repeat(32), get: async () => null },
  secretsService: {
    getJwtSecret: async () => 'cd'.repeat(32),
    getEmailBlindIndexPepper: async () => 'ef'.repeat(32),
  },
}));
import { SALT_ROUNDS } from '../src/auth/password.js';
import type { AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { authRoutes } from '../src/routes/auth.js';

const app = new Hono<AppEnv>().onError(errorHandler).route('/auth', authRoutes);
const send = (route: string) =>
  app.request(`/auth/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'synthetic@login.test.local', password: 'synthetic-password-1' }),
  });

beforeEach(() => {
  h.user = undefined;
  h.compare.mockReset().mockResolvedValue(false);
  h.hash.mockReset().mockResolvedValue('synthetic-hash');
});

describe('login password work without timing assertions', () => {
  it('an unknown account compares exactly once against a fixed dummy hash at the configured bcrypt cost', async () => {
    const res = await send('login');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials', code: null });
    expect(h.compare).toHaveBeenCalledTimes(1);
    const [password, dummy] = h.compare.mock.calls[0]!;
    expect(password).toBe('synthetic-password-1');
    expect(bcrypt.getRounds(dummy)).toBe(SALT_ROUNDS);
    h.compare.mockClear();
    await send('login');
    expect(h.compare).toHaveBeenCalledExactlyOnceWith(password, dummy);
    expect(h.hash).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('even a matching dummy comparison cannot authenticate a missing user', async () => {
    h.compare.mockResolvedValue(true);
    const res = await send('login');
    expect(res.status).toBe(401);
    expect(h.compare).toHaveBeenCalledTimes(1);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it.each(['active', 'deactivated'])('a known %s account compares exactly once', async (status) => {
    h.user = { status, passwordHash: 'stored-password-hash' };
    const res = await send('login');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials', code: null });
    expect(h.compare).toHaveBeenCalledExactlyOnceWith(
      'synthetic-password-1',
      'stored-password-hash',
    );
  });

  it('a deactivated account with the correct password still receives the same 401 and no cookies', async () => {
    h.user = {
      id: 'synthetic-id',
      role: 'user',
      tokenVersion: 0,
      createdAt: new Date(),
      status: 'deactivated',
      passwordHash: 'stored-password-hash',
    };
    h.compare.mockResolvedValue(true);
    const res = await send('login');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials', code: null });
    expect(h.compare).toHaveBeenCalledExactlyOnceWith(
      'synthetic-password-1',
      'stored-password-hash',
    );
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('duplicate registration already pays for one bcrypt hash before its unchanged 409', async () => {
    h.user = { id: 'synthetic-existing-user' };
    const res = await send('register');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Email already registered', code: null });
    expect(h.hash).toHaveBeenCalledExactlyOnceWith('synthetic-password-1');
    expect(h.compare).not.toHaveBeenCalled();
  });
});
