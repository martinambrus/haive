import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema } from '@haive/database';
import { computeEmailBlindIndex, encryptEmail, tryDecryptEmail } from '@haive/shared';
import { concurrentReads, instrumentDb } from './auth-hardening-db.js';
import type { AppEnv } from '../src/context.js';
const url = process.env.ADMIN_RELINK_TEST_URL;
if (url && new URL(url).pathname !== '/rlk_test')
  throw new Error('Use a dedicated rlk_test database');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  send: vi.fn(),
  caller: '00000000-0000-4000-8000-000000000001',
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', async (original) => ({
  ...(await original<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', h.caller);
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('../src/auth/password.js', () => ({
  hashPassword: async (value: string) => 'hash-' + value,
}));
vi.mock('../src/lib/user-sockets.js', () => ({ closeUserSockets: () => {} }));
vi.mock('../src/lib/mailer.js', () => ({ sendMail: h.send }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getEncryptionKey: async () => 'ab'.repeat(32) },
  secretsService: { getEmailBlindIndexPepper: async () => 'ef'.repeat(32) },
}));
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
describe.skipIf(!url)('admin relink on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  const ids: string[] = [];
  const app = new Hono<AppEnv>().onError(errorHandler).route('/admin', adminRoutes);
  const post = (id: string, email: string) =>
    app.request('/admin/users/' + id + '/relink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
    h.send.mockResolvedValue({ ok: false, code: 'mail_disabled' });
  });
  afterAll(async () => {
    for (const id of ids) {
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.targetId, id));
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await db.$client.end({ timeout: 5 });
  });
  async function user() {
    const [u] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: encryptEmail('old@example.test', '12'.repeat(32)),
        emailBlindIndex: randomUUID(),
        passwordHash: 'old-hash',
      })
      .returning();
    ids.push(u!.id);
    await db
      .insert(schema.refreshTokens)
      .values({ userId: u!.id, tokenHash: randomUUID(), expiresAt: new Date('2099-01-01') });
    return u!;
  }
  async function state(id: string) {
    return {
      user: await db.query.users.findFirst({ where: eq(schema.users.id, id) }),
      sessions: await db.query.refreshTokens.findMany({
        where: eq(schema.refreshTokens.userId, id),
      }),
      resets: await db.query.passwordResets.findMany({
        where: eq(schema.passwordResets.userId, id),
      }),
      audits: await db.query.auditEvents.findMany({ where: eq(schema.auditEvents.targetId, id) }),
    };
  }
  it('refuses relinking the caller under any spelling Postgres accepts for its id', async () => {
    const u = await user();
    h.caller = u.id;
    try {
      const before = await state(u.id);
      for (const id of [u.id.toUpperCase(), u.id.replaceAll('-', ''), '{' + u.id + '}']) {
        const res = await post(id, randomUUID() + '@example.test');
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'Cannot relink the calling admin' });
      }
      expect(await state(u.id)).toEqual(before);
    } finally {
      h.caller = '00000000-0000-4000-8000-000000000001';
    }
  });
  it('commits the normalized login index, password, revocation, plain reset and required audits together', async () => {
    const u = await user();
    const email = randomUUID() + '@example.test';
    h.send.mockImplementationOnce(async () => {
      const committed = await state(u.id);
      expect(committed.user!.mustChangePassword).toBe(true);
      expect(committed.audits.map((a) => a.action)).toContain('user.relink');
      return { ok: false, code: 'mail_disabled' };
    });
    const res = await post(u.id, ' ' + email.toUpperCase() + ' ');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, delivery: 'manual' });
    const s = await state(u.id);
    expect(s.user).toMatchObject({
      tokenVersion: 1,
      mustChangePassword: true,
      passwordHash: expect.stringMatching(/^hash-[a-f0-9]{64}$/),
    });
    expect(tryDecryptEmail(s.user!.emailEncrypted, 'ab'.repeat(32))).toBe(email);
    expect(
      (await db.query.users.findFirst({
        where: eq(schema.users.emailBlindIndex, computeEmailBlindIndex(email, 'ef'.repeat(32))),
      }))!.id,
    ).toBe(u.id);
    expect(s.sessions.every((t) => t.revokedAt !== null)).toBe(true);
    expect(s.resets).toMatchObject([{ claimEmailEncrypted: null, consumedAt: null }]);
    expect(s.audits.map((a) => a.action).sort()).toEqual([
      'auth.password_reset.request',
      'user.relink',
    ]);
  });
  it('a real unique-index race rolls back every write of the losing relink', async () => {
    const users = await Promise.all([user(), user()]);
    const before = await Promise.all(users.map((u) => state(u.id)));
    const gate = concurrentReads('users');
    h.db = instrumentDb(db, gate.afterRead);
    let replies: Response[];
    const email = randomUUID() + '@example.test';
    try {
      replies = await Promise.all(users.map((u) => post(u.id, email)));
    } finally {
      gate.release();
      h.db = db;
    }
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = replies.findIndex((r) => r.status === 409);
    expect(await replies[loser]!.json()).toMatchObject({ code: 'relink_email_taken' });
    expect(await state(users[loser]!.id)).toEqual(before[loser]);
  });
  it.each(['user.relink', 'auth.password_reset.request'])(
    'a refused %s audit rolls back the account, refresh tokens and reset issuance',
    async (action) => {
      const u = await user();
      const before = await state(u.id);
      await db.$client.unsafe(
        `CREATE FUNCTION rlk_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'synthetic audit refusal'; END IF; RETURN NEW; END $$`,
      );
      await db.$client.unsafe(
        'CREATE TRIGGER rlk_refuse_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION rlk_refuse_audit()',
      );
      try {
        expect((await post(u.id, randomUUID() + '@example.test')).status).toBe(500);
        expect(await state(u.id)).toEqual(before);
      } finally {
        await db.$client.unsafe('DROP TRIGGER rlk_refuse_audit ON audit_events');
        await db.$client.unsafe('DROP FUNCTION rlk_refuse_audit()');
      }
    },
  );
});
