import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  allowAudit,
  audits,
  cleanActor,
  createDatabase,
  KEK,
  makeActor,
  refuseAudit,
  schema,
} from './security-audit-db.js';
const url = process.env.ACCOUNT_SECURITY_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/account_security_audit_test'))
  throw new Error('Use a dedicated account_security_audit_test database');
const h = vi.hoisted(() => ({
  db: undefined as any,
  actor: '',
  throttle: vi.fn(),
  close: vi.fn(),
  auditInsert: vi.fn(),
  auditLog: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/audit.js', async (original) => {
  const real = await original<any>();
  return {
    ...real,
    insertAuditEvent: async (db: any, event: any) => {
      h.auditInsert(event);
      return real.insertAuditEvent(db, event);
    },
    logAuditEvent: (event: any) => {
      h.auditLog(event);
      real.logAuditEvent(event);
    },
  };
});
vi.mock('../src/lib/user-sockets.js', () => ({ closeUserSockets: h.close }));
vi.mock('../src/lib/auth-throttle.js', () => ({ reserveAuthAttempt: h.throttle }));
vi.mock('../src/auth/password.js', () => ({
  hashPassword: async () => 'next-hash',
  verifyPassword: async (password: string) => password === 'synthetic-password',
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<any>()),
  configService: { getEncryptionKey: async () => 'ab'.repeat(32), get: async () => 'open' },
}));
import { computeEmailBlindIndex, encryptEmail, secretsService } from '@haive/shared';
import { authRoutes } from '../src/routes/auth.js';
import { userSettingsRoutes } from '../src/routes/user-settings.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

describe.skipIf(!url)('Account security audit on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  let cookie: string;
  const app = new Hono<AppEnv>()
    .onError(errorHandler)
    .route('/auth', authRoutes)
    .route('/user-settings', userSettingsRoutes);
  const send = (path: string, body: unknown) =>
    app.request(path, {
      method: path === '/user-settings/password' ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const sessions = () => db.select().from(schema.refreshTokens);
  const user = () => db.query.users.findFirst({ where: eq(schema.users.id, h.actor) });
  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    vi.spyOn(secretsService, 'getEmailBlindIndexPepper').mockResolvedValue('ef'.repeat(32));
    h.actor = (await makeActor(db)).id;
    h.auditInsert.mockClear();
    h.auditLog.mockClear();
    await db
      .update(schema.users)
      .set({
        emailEncrypted: encryptEmail('known@example.test', KEK),
        emailBlindIndex: computeEmailBlindIndex('known@example.test', 'ef'.repeat(32)),
      })
      .where(eq(schema.users.id, h.actor));
    cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: h.actor, role: 'admin', tv: 0 })}`;
    h.throttle.mockReset().mockResolvedValue({ refund: async () => {} });
    h.close.mockClear();
  });
  afterEach(async () => {
    await allowAudit(db);
    await db.delete(schema.userInvites).where(eq(schema.userInvites.createdBy, h.actor));
    const registered = await db.query.users.findFirst({
      where: eq(
        schema.users.emailBlindIndex,
        computeEmailBlindIndex('new@example.test', 'ef'.repeat(32)),
      ),
    });
    if (registered) await cleanActor(db, registered.id);
    await cleanActor(db, h.actor);
    vi.restoreAllMocks();
  });
  for (const refused of [false, true]) {
    it(`password change: ${refused ? 'refusal undoes password and session' : 'commits one safe row'}`, async () => {
      const before = await user();
      if (refused)
        await refuseAudit(db, h.actor, {
          registrationBlindIndex: computeEmailBlindIndex('new@example.test', 'ef'.repeat(32)),
        });
      const res = await send('/user-settings/password', {
        currentPassword: 'synthetic-password',
        newPassword: 'synthetic-next-password',
      });
      expect(res.status).toBe(refused ? 500 : 200);
      expect(await audits(db)).toHaveLength(refused ? 0 : 1);
      expect(await sessions()).toHaveLength(refused ? 0 : 1);
      if (refused) {
        expect(await user()).toEqual(before);
        expect(h.close).not.toHaveBeenCalled();
        expect(res.headers.getSetCookie()).toEqual([]);
      } else
        expect((await audits(db))[0]).toMatchObject({
          action: 'user.password.change',
          targetId: h.actor,
          metadata: { forced: false },
        });
    });
    it(`registration: ${refused ? 'refusal undoes user, invite consumption and session' : 'commits one safe row'}`, async () => {
      const { hashInviteToken } = await import('../src/lib/invites.js');
      const [invite] = await db
        .insert(schema.userInvites)
        .values({
          tokenHash: hashInviteToken('synthetic-invite'),
          role: 'user',
          createdBy: h.actor,
          expiresAt: new Date(Date.now() + 60000),
        })
        .returning();
      if (refused)
        await refuseAudit(db, h.actor, {
          registrationBlindIndex: computeEmailBlindIndex('new@example.test', 'ef'.repeat(32)),
        });
      const res = await send('/auth/register', {
        email: 'new@example.test',
        password: 'synthetic-password',
        inviteToken: 'synthetic-invite',
      });
      expect(res.status).toBe(refused ? 500 : 201);
      const users = await db.select().from(schema.users);
      expect(users).toHaveLength(refused ? 1 : 2);
      const consumed = await db.query.userInvites.findFirst({
        where: eq(schema.userInvites.id, invite!.id),
      });
      expect(consumed!.consumedAt !== null).toBe(!refused);
      expect(await sessions()).toHaveLength(refused ? 0 : 1);
      const rows = await audits(db);
      expect(rows).toHaveLength(refused ? 0 : 1);
      if (refused) expect(res.headers.getSetCookie()).toEqual([]);
      else {
        const payload = (await res.json()) as any;
        expect(h.auditLog.mock.calls[0]![0]).toBe(h.auditInsert.mock.calls[0]![0]);
        expect(rows[0]).toMatchObject({
          action: 'user.register',
          actorUserId: payload.user.id,
          targetId: payload.user.id,
        });
        expect(JSON.stringify(rows)).not.toContain('example.test');
      }
      await db.delete(schema.userInvites).where(eq(schema.userInvites.id, invite!.id));
    });
  }
});
