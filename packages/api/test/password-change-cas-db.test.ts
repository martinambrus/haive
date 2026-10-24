import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.AUTH_HARDENING_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/auth_hardening_test'))
  throw new Error('Use a dedicated auth_hardening_test database');
const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  return { db: undefined as unknown, close: vi.fn() };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/user-sockets.js', () => ({ closeUserSockets: h.close }));
import { secretsService } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { verifyAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { verifyPassword } from '../src/auth/password.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { userSettingsRoutes } from '../src/routes/user-settings.js';
import {
  PASSWORD,
  concurrentReads,
  createDatabase,
  instrumentDb,
  makeUser,
  schema,
} from './auth-hardening-db.js';

describe.skipIf(!url)('password change compare-and-set on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  let userId: string;
  let cookie: string;
  let release = () => {};
  const app = new Hono<AppEnv>().onError(errorHandler).route('/user-settings', userSettingsRoutes);
  const change = (newPassword: string) =>
    app.request('/user-settings/password', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword }),
    });
  beforeAll(() => {
    db = createDatabase(url!);
  });
  beforeEach(async () => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    h.close.mockClear();
    h.db = db;
    const made = await makeUser(db);
    userId = made.user.id;
    cookie = made.cookie;
  });
  afterEach(async () => {
    release();
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  it('signs with the pool before holding a transaction connection', async () => {
    let inTransaction = false;
    h.db = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction')
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              inTransaction = true;
              try {
                return await fn(tx);
              } finally {
                inTransaction = false;
              }
            });
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    vi.mocked(secretsService.getJwtSecret).mockImplementation(async () => {
      expect(inTransaction, 'pool-backed signing must not hold a transaction connection').toBe(
        false,
      );
      return 'cd'.repeat(32);
    });
    expect((await change('synthetic-next-password-2')).status).toBe(200);
  });

  it('one concurrent change wins, advances the version and closes sockets only once', async () => {
    const gate = concurrentReads('users', true);
    release = gate.release;
    h.db = instrumentDb(db, gate.afterRead);
    const passwords = ['synthetic-next-password-2', 'synthetic-next-password-3'];
    const replies = await Promise.all(passwords.map(change));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = replies.findIndex((r) => r.status === 200);
    const loser = replies[1 - winner]!;
    expect(await loser.json()).toMatchObject({ code: 'password_change_conflict' });
    expect(loser.headers.getSetCookie()).toEqual([]);
    expect(h.close).toHaveBeenCalledExactlyOnceWith(userId);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
    expect(user!.tokenVersion).toBe(1);
    expect(await verifyPassword(passwords[winner]!, user!.passwordHash)).toBe(true);
    expect(await verifyPassword(passwords[1 - winner]!, user!.passwordHash)).toBe(false);
    const tokens = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, userId));
    expect(tokens).toHaveLength(1);
    const access = replies[winner]!.headers.getSetCookie()
      .find((s) => s.startsWith(`${ACCESS_COOKIE}=`))!
      .split(';')[0]!
      .slice(ACCESS_COOKIE.length + 1);
    expect(await verifyAccessToken(access)).toMatchObject({ sub: userId, tv: 1 });
  });

  it('a session insert failure rolls back the password and version, without closing sockets', async () => {
    h.db = instrumentDb(db, async () => {}, true);
    const res = await change('synthetic-next-password-2');
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(h.close).not.toHaveBeenCalled();
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
    expect(user!.tokenVersion).toBe(0);
    expect(await verifyPassword(PASSWORD, user!.passwordHash)).toBe(true);
  });
});
