import { eq, isNull, and, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.AUTH_HARDENING_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/auth_hardening_test'))
  throw new Error('Use a dedicated auth_hardening_test database');

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  return { db: undefined as unknown };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

import { secretsService } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { REFRESH_COOKIE } from '../src/auth/cookies.js';
import { hashRefreshToken, signRefreshToken } from '../src/auth/jwt.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { authRoutes } from '../src/routes/auth.js';
import {
  concurrentReads,
  createDatabase,
  instrumentDb,
  makeUser,
  schema,
} from './auth-hardening-db.js';

describe.skipIf(!url)('refresh rotation on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  let userId: string;
  let cookie: string;
  let tokenHash: string;
  let release = () => {};
  const app = new Hono<AppEnv>().onError(errorHandler).route('/auth', authRoutes);
  const refresh = () => app.request('/auth/refresh', { method: 'POST', headers: { cookie } });

  beforeAll(() => {
    db = createDatabase(url!);
  });
  beforeEach(async () => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    h.db = db;
    const { user } = await makeUser(db);
    userId = user.id;
    const { token, expiresAt } = await signRefreshToken(userId, 0);
    tokenHash = hashRefreshToken(token);
    await db.insert(schema.refreshTokens).values({ userId, tokenHash, expiresAt });
    cookie = `${REFRESH_COOKIE}=${token}`;
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
    expect((await refresh()).status).toBe(200);
  });

  it('only one concurrent redemption issues cookies and a live successor', async () => {
    const gate = concurrentReads('refreshTokens');
    release = gate.release;
    h.db = instrumentDb(db, gate.afterRead);
    const replies = await Promise.all([refresh(), refresh()]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 401]);
    const loser = replies.find((r) => r.status === 401)!;
    expect(loser.headers.getSetCookie()).toEqual([]);
    const loserBody = await loser.text();
    const live = await db
      .select()
      .from(schema.refreshTokens)
      .where(and(eq(schema.refreshTokens.userId, userId), isNull(schema.refreshTokens.revokedAt)));
    expect(live).toHaveLength(1);
    expect(live[0]!.tokenHash).not.toBe(tokenHash);
    h.db = db;
    const replay = await refresh();
    expect(loser.status).toBe(replay.status);
    expect(loserBody).toBe(await replay.text());
    expect([...loser.headers]).toEqual([...replay.headers]);
  });

  it.each(['Pacific/Honolulu', 'Asia/Tokyo'])(
    'records UTC revocation wall time with session TimeZone %s',
    async (zone) => {
      h.db = new Proxy(db, {
        get(target, key) {
          if (key === 'transaction')
            return (fn: (tx: unknown) => Promise<unknown>) =>
              target.transaction(async (tx) => {
                await tx.execute(sql`SELECT set_config('TimeZone', ${zone}, true)`);
                return fn(tx);
              });
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const before = Date.now();
      expect((await refresh()).status).toBe(200);
      const after = Date.now();
      const original = await db.query.refreshTokens.findFirst({
        where: eq(schema.refreshTokens.tokenHash, tokenHash),
      });
      expect(original!.revokedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(original!.revokedAt!.getTime()).toBeLessThanOrEqual(after);
    },
  );

  it('a failed successor insert rolls the revocation back and sends no cookies', async () => {
    h.db = instrumentDb(db, async () => {}, true);
    const res = await refresh();
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual([]);
    const original = await db.query.refreshTokens.findFirst({
      where: eq(schema.refreshTokens.tokenHash, tokenHash),
    });
    expect(original!.revokedAt).toBeNull();
    h.db = db;
    expect((await refresh()).status).toBe(200);
  });
});
