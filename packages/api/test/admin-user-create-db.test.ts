import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
import { computeEmailBlindIndex, configService, secretsService } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { adminRoutes } from '../src/routes/admin.js';
import {
  FIELD_KEY,
  concurrentReads,
  createDatabase,
  instrumentDb,
  makeUser,
  schema,
} from './auth-hardening-db.js';

describe.skipIf(!url)('admin duplicate user creation on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  const admins: string[] = [];
  let blindIndex: string;
  let release = () => {};
  const app = new Hono<AppEnv>().onError(errorHandler).route('/admin', adminRoutes);
  beforeAll(() => {
    db = createDatabase(url!);
  });
  beforeEach(() => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    vi.spyOn(secretsService, 'getEmailBlindIndexPepper').mockResolvedValue('ef'.repeat(32));
    vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue(FIELD_KEY);
    h.db = db;
  });
  afterEach(async () => {
    release();
    if (blindIndex)
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, blindIndex));
    for (const id of admins.splice(0)) {
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, id));
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  it('two admins racing on one email receive 201 and the same 409 as a pre-check duplicate', async () => {
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const made = await makeUser(db);
      admins.push(made.user.id);
      await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, made.user.id));
      cookies.push(made.cookie);
    }
    const email = `${randomUUID()}@synthetic-admin-create.test.local`;
    blindIndex = computeEmailBlindIndex(email, 'ef'.repeat(32));
    const create = (cookie: string) =>
      app.request('/admin/users', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ email, role: 'user' }),
      });
    const gate = concurrentReads('users');
    release = gate.release;
    h.db = instrumentDb(db, async (table, opts) => {
      // Only the email pre-check, after both real SELECTs return no user.
      if (Object.keys(opts.columns ?? {}).length === 1) await gate.afterRead(table, opts);
    });
    const replies = await Promise.all(cookies.map(create));
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    h.db = db;
    const duplicate = await create(cookies[0]!);
    const loser = replies.find((r) => r.status === 409)!;
    expect(duplicate.status).toBe(409);
    expect(await loser.text()).toBe(await duplicate.text());
    expect([...loser.headers]).toEqual([...duplicate.headers]);
    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.emailBlindIndex, blindIndex));
    expect(users).toHaveLength(1);
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, users[0]!.id));
    expect(audits).toHaveLength(1);
  });
});
