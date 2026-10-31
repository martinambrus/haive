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
const url = process.env.SECURITY_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t376_audit_test'))
  throw new Error('Use a dedicated t376_audit_test database');
const h = vi.hoisted(() => ({
  db: undefined as any,
  actor: '',
  throttle: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
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

describe.skipIf(!url)('Login audit on Postgres', () => {
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
  });
  afterEach(async () => {
    await allowAudit(db);
    await db.delete(schema.userInvites);
    await db
      .delete(schema.users)
      .where(
        eq(
          schema.users.emailBlindIndex,
          computeEmailBlindIndex('new@example.test', 'ef'.repeat(32)),
        ),
      );
    await cleanActor(db, h.actor);
    vi.restoreAllMocks();
  });
  for (const kind of ['success', 'wrong-password', 'unknown', 'deactivated'] as const) {
    for (const refused of [false, true])
      it(`${kind}: ${refused ? 'audit refusal fails and issues no session' : 'writes safe audit'}`, async () => {
        if (kind === 'deactivated')
          await db
            .update(schema.users)
            .set({ status: 'deactivated' })
            .where(eq(schema.users.id, h.actor));
        if (refused) await refuseAudit(db);
        const res = await send('/auth/login', {
          email: kind === 'unknown' ? 'absent@example.test' : 'known@example.test',
          password: kind === 'wrong-password' ? 'wrong-password' : 'synthetic-password',
        });
        expect(res.status).toBe(refused ? 500 : kind === 'success' ? 200 : 401);
        expect(await sessions()).toHaveLength(!refused && kind === 'success' ? 1 : 0);
        const rows = await audits(db);
        expect(rows).toHaveLength(refused ? 0 : 1);
        if (refused || kind !== 'success') expect(res.headers.getSetCookie()).toEqual([]);
        if (!refused) {
          expect(rows[0]).toMatchObject({
            action: kind === 'success' ? 'auth.login.success' : 'auth.login.failure',
            targetId: kind === 'unknown' ? null : h.actor,
          });
          expect(JSON.stringify(rows)).not.toMatch(
            /example.test|synthetic-password|wrong-password/,
          );
        }
      });
  }
});
