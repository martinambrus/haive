import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { AuthThrottleError } from '../src/lib/auth-throttle.js';
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
const url = process.env.FORCED_THROTTLED_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/forced_throttled_audit_test'))
  throw new Error('Use a dedicated forced_throttled_audit_test database');
const h = vi.hoisted(() => ({
  db: undefined as any,
  actor: '',
  throttle: vi.fn(),
  close: vi.fn(),
  auditDone: vi.fn(),
  auditDelayMs: 0,
  auditWork: undefined as Promise<void> | undefined,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/user-sockets.js', () => ({ closeUserSockets: h.close }));
vi.mock('../src/lib/auth-throttle.js', async (original) => ({
  ...(await original<any>()),
  reserveAuthAttempt: h.throttle,
}));
vi.mock('../src/lib/audit.js', async (original) => {
  const real = await original<typeof import('../src/lib/audit.js')>();
  return {
    ...real,
    recordAuditEvent: async (...args: Parameters<typeof real.recordAuditEvent>) => {
      h.auditWork = (async () => {
        try {
          if (h.auditDelayMs) await new Promise((resolve) => setTimeout(resolve, h.auditDelayMs));
          await real.recordAuditEvent(...args);
        } finally {
          h.auditDone();
        }
      })();
      await h.auditWork;
    },
  };
});
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

describe.skipIf(!url)('Forced changes and throttled logins on Postgres', () => {
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
    h.auditDone.mockClear();
    h.auditDelayMs = 0;
    h.auditWork = undefined;
  });
  afterEach(async () => {
    await h.auditWork;
    await allowAudit(db);
    await db.delete(schema.userInvites).where(eq(schema.userInvites.createdBy, h.actor));
    const registered = await db.query.users.findFirst({
      where: eq(
        schema.users.emailBlindIndex,
        computeEmailBlindIndex('new@example.test', 'ef'.repeat(32)),
      ),
    });
    if (registered) await cleanActor(db, registered.id);
    await cleanActor(db, h.actor, { anonymous: true });
    vi.restoreAllMocks();
  });
  for (const refused of [false, true]) {
    for (const known of [true, false])
      it(`throttled ${known ? 'known' : 'unknown'} login: ${refused ? 'refused audit preserves 429' : 'eventually writes a safe row'}`, async () => {
        h.throttle.mockRejectedValue(
          new AuthThrottleError(
            Response.json(
              { code: 'rate_limited' },
              { status: 429, headers: { 'Retry-After': '60' } },
            ),
            true,
            'account',
          ),
        );
        // The 5.5 s delay exceeds the 5 s default test timeout; the 30 s timeout below replaces it.
        h.auditDelayMs = known && !refused ? 5500 : 0;
        if (refused) await refuseAudit(db, h.actor, { anonymous: true });
        const res = await send('/auth/login', {
          email: known ? 'known@example.test' : 'absent@example.test',
          password: 'synthetic-password',
        });
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('60');
        await expect.poll(() => h.auditDone.mock.calls.length, { timeout: 15_000 }).toBe(1);
        const rows = await audits(db);
        expect(rows).toHaveLength(refused ? 0 : 1);
        expect(await sessions()).toEqual([]);
        if (!refused) {
          expect(res.headers.get('Retry-After')).toBe('60');
          expect(rows[0]).toMatchObject({
            action: 'auth.login.throttled',
            targetId: known ? h.actor : null,
            metadata: { reason: 'throttled' },
          });
          expect(JSON.stringify(rows)).not.toContain('example.test');
        }
      }, 30_000);
    it(`forced password change: ${refused ? 'refusal keeps the gate and password' : 'records the forced change'}`, async () => {
      await db
        .update(schema.users)
        .set({ mustChangePassword: true })
        .where(eq(schema.users.id, h.actor));
      const before = await user();
      if (refused) await refuseAudit(db, h.actor, { anonymous: true });
      const res = await send('/user-settings/password', {
        currentPassword: 'synthetic-password',
        newPassword: 'synthetic-next-password',
      });
      expect(res.status).toBe(refused ? 500 : 200);
      if (refused) {
        expect(await user()).toEqual(before);
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(h.close).not.toHaveBeenCalled();
      } else {
        expect((await user())!.mustChangePassword).toBe(false);
        expect((await audits(db))[0]).toMatchObject({
          action: 'user.password.change',
          metadata: { forced: true },
        });
      }
      expect(await sessions()).toHaveLength(refused ? 0 : 1);
    });
  }
});
