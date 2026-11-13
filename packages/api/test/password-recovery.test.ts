import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { eq } from 'drizzle-orm';
import { createFakeDb } from '@haive/database/testing';
import { ConfigUnavailableError, computeEmailBlindIndex, encryptEmail } from '@haive/shared';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  enabled: true,
  send: vi.fn(),
  reserve: vi.fn(),
  hash: vi.fn(),
  redis: undefined as unknown,
  close: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => h.redis }));
vi.mock('../src/lib/mailer.js', () => ({ sendMail: h.send }));
vi.mock('../src/lib/auth-throttle.js', async (original) => ({
  ...(await original<typeof import('../src/lib/auth-throttle.js')>()),
  reserveAuthAttempt: h.reserve,
}));
vi.mock('../src/lib/user-sockets.js', () => ({ closeUserSockets: h.close }));
vi.mock('../src/auth/password.js', () => ({
  hashPassword: h.hash,
  verifyPassword: async () => false,
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: {
    getEncryptionKey: async () => 'ab'.repeat(32),
    getFresh: async () => String(h.enabled),
  },
  secretsService: { getEmailBlindIndexPepper: async () => 'ef'.repeat(32) },
  logger: { child: () => ({ warn: h.warn, info: vi.fn(), error: vi.fn() }), error: vi.fn() },
}));
import { authRoutes } from '../src/routes/auth.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { HTTPException } from 'hono/http-exception';
import { AUTH_ACCOUNT_LIMIT, AuthThrottleError } from '../src/lib/auth-throttle.js';
import {
  issuePasswordReset,
  PASSWORD_RESET_TTL_MS,
  PASSWORD_RESET_COOLDOWN_MS,
} from '../src/lib/password-resets.js';
import type { AppEnv } from '../src/context.js';
import { hashInviteToken } from '../src/lib/invites.js';

const KEY = 'ab'.repeat(32);
const EMAIL = 'person@example.test';
const blind = (email: string) => computeEmailBlindIndex(email, 'ef'.repeat(32));
const app = new Hono<AppEnv>().onError(errorHandler).route('/auth', authRoutes);
const post = (path: string, body: unknown, address?: string) =>
  app.request(
    `/auth/${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    address ? { incoming: { socket: { remoteAddress: address } } } : undefined,
  );
let fake: ReturnType<typeof createFakeDb>;
let candidates: Array<typeof schema.users.$inferSelect>;
async function user(readable = true, email = EMAIL) {
  const [row] = await fake.db
    .insert(schema.users)
    .values({
      emailEncrypted: encryptEmail(email, readable ? KEY : 'cd'.repeat(32)),
      emailBlindIndex: readable ? blind(email) : 'old-' + email,
      passwordHash: 'old-hash',
      gitEmail: ` ${email.toUpperCase()} `,
      status: 'active',
      tokenVersion: 0,
      mustChangePassword: true,
    })
    .returning();
  candidates.push(row as typeof schema.users.$inferSelect);
  return row!;
}
async function discard() {
  await fake.db.insert(schema.auditEvents).values({
    actorUserId: '00000000-0000-0000-0000-000000000000',
    action: 'config.discard_unreadable_secrets',
    targetType: 'system',
  });
}
function throttleRedis() {
  // Fake the Redis command seam, preserving independent buckets and SET NX audit slots.
  const counts = new Map<string, number>();
  const slots = new Set<string>();
  h.redis = {
    status: 'ready',
    eval: async (_script: string, n: number, ...args: Array<string | number>) => {
      const keys = args.slice(0, n) as string[];
      for (const [i, key] of keys.entries()) {
        if ((counts.get(key) ?? 0) >= Number(args[n + 4 + i])) return [0, 60_000, key];
      }
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
      return [1, 0];
    },
    set: async (key: string) => {
      if (slots.has(key)) return null;
      slots.add(key);
      return 'OK';
    },
  };
  return counts;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
  fake = createFakeDb({
    users: schema.users,
    passwordResets: schema.passwordResets,
    refreshTokens: schema.refreshTokens,
    auditEvents: schema.auditEvents,
  });
  h.db = fake.db as unknown as Database;
  candidates = [];
  // The case-insensitive SQL lookup is exercised on Postgres; input variants stay in memory.
  vi.spyOn(fake.db.query.users!, 'findMany').mockImplementation(async () => candidates);
  h.enabled = true;
  h.send.mockReset().mockResolvedValue({ ok: true });
  h.reserve.mockReset().mockResolvedValue({ refund: vi.fn() });
  h.warn.mockClear();
  h.close.mockClear();
  h.hash.mockReset().mockResolvedValue('new-hash');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('forgot password', () => {
  it.each(['unknown', 'readable', 'claim', 'multiple', 'disabled', 'no-discard'])(
    '%s always answers the same 202 and sends only an eligible link after replying',
    async (kind) => {
      if (kind === 'readable') await user();
      if (['claim', 'multiple', 'no-discard'].includes(kind)) await user(false);
      if (kind === 'multiple') await user(false);
      if (kind !== 'no-discard') await discard();
      if (kind === 'disabled') {
        h.enabled = false;
        await user();
      }
      const response = await post('forgot-password', { email: ` ${EMAIL.toUpperCase()} ` });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        message: 'If an account can be recovered, a reset link will be emailed.',
      });
      expect(h.send).not.toHaveBeenCalled();
      expect(await fake.db.query.passwordResets!.findMany()).toHaveLength(0);
      await vi.runAllTimersAsync();
      const sends = kind === 'readable' || kind === 'claim' ? 1 : 0;
      expect(h.send).toHaveBeenCalledTimes(sends);
      expect(h.reserve).toHaveBeenCalledWith(expect.anything(), 'recover', blind(EMAIL));
      const tokens = await fake.db.query.passwordResets!.findMany();
      expect(tokens).toHaveLength(sends);
      if (sends) {
        expect(h.send.mock.calls[0]![0]).toMatchObject({ to: EMAIL });
        const raw = /token=([\w-]+)/.exec(h.send.mock.calls[0]![0].text)![1]!;
        expect(JSON.stringify(tokens)).not.toContain(raw);
        expect(tokens[0]!.expiresAt).toEqual(new Date(Date.now() + PASSWORD_RESET_TTL_MS));
        expect(tokens[0]!.claimEmailEncrypted !== null).toBe(kind === 'claim');
      }
    },
  );
  it('pins the production lifetime', () => {
    expect(PASSWORD_RESET_TTL_MS).toBe(30 * 60_000);
    expect(PASSWORD_RESET_COOLDOWN_MS).toBe(2 * 60_000);
  });
  it('keeps the first link and sends no second mail during the issuance cooldown', async () => {
    await user();
    await post('forgot-password', { email: EMAIL });
    await vi.runAllTimersAsync();
    const first = await fake.db.query.passwordResets!.findMany();
    await post('forgot-password', { email: EMAIL });
    await vi.runAllTimersAsync();
    expect(h.send).toHaveBeenCalledOnce();
    expect(await fake.db.query.passwordResets!.findMany()).toEqual(first);
  });
  it('recovery spam leaves login admission and its throttle audit slot untouched', async () => {
    throttleRedis();
    const real = await vi.importActual<typeof import('../src/lib/auth-throttle.js')>(
      '../src/lib/auth-throttle.js',
    );
    h.reserve.mockImplementation(real.reserveAuthAttempt);
    await user();
    for (let i = 0; i < 12; i++)
      expect((await post('forgot-password', { email: EMAIL }, '8.8.8.8')).status).toBe(202);
    expect(
      (await post('login', { email: EMAIL, password: 'wrong-password-long' }, '8.8.8.8')).status,
    ).toBe(401);
    for (let i = 0; i < 10; i++)
      await post('login', { email: EMAIL, password: 'wrong-password-long' }, '8.8.8.8');
    await vi.runAllTimersAsync();
    const events = await fake.db.query.auditEvents!.findMany();
    expect(events.filter((e) => e.action === 'auth.password_reset.throttled')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'auth.login.throttled')).toHaveLength(1);
  });
  it.each([true, false])('honors the recovery throttle audit slot (%s)', async (auditAllowed) => {
    const row = await user();
    h.reserve.mockRejectedValue(
      new AuthThrottleError(new Response(null, { status: 429 }), auditAllowed, 'account'),
    );
    expect((await post('forgot-password', { email: EMAIL })).status).toBe(202);
    await vi.runAllTimersAsync();
    const events = await fake.db.query.auditEvents!.findMany();
    expect(events).toHaveLength(auditAllowed ? 1 : 0);
    if (auditAllowed)
      expect(events[0]).toMatchObject({
        action: 'auth.password_reset.throttled',
        targetId: row.id,
        metadata: { reason: 'throttled', limiter: 'account' },
      });
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each([new Error('secret@example.test token=secret'), new ConfigUnavailableError('test')])(
    'contains mail exceptions without logging plaintext',
    async (error) => {
      await user();
      h.send.mockRejectedValue(error);
      expect((await post('forgot-password', { email: EMAIL })).status).toBe(202);
      await vi.runAllTimersAsync();
      expect(h.warn).toHaveBeenCalled();
      expect(h.send).toHaveBeenCalledOnce();
      expect(JSON.stringify(h.warn.mock.calls)).not.toMatch(/person@|secret@|token=secret/);
    },
  );
  it('contains a typed mail failure', async () => {
    await user();
    h.send.mockResolvedValue({ ok: false, code: 'mail_send_failed' });
    await post('forgot-password', { email: EMAIL });
    await vi.runAllTimersAsync();
    expect(h.warn).toHaveBeenCalled();
  });
  it.each([true, false])('sends nothing to a deactivated user (readable: %s)', async (readable) => {
    const row = await user(readable);
    row.status = 'deactivated';
    await fake.db
      .update(schema.users)
      .set({ status: 'deactivated' })
      .where(eq(schema.users.id, String(row.id)));
    await discard();
    expect((await post('forgot-password', { email: EMAIL })).status).toBe(202);
    await vi.runAllTimersAsync();
    expect(h.send).not.toHaveBeenCalled();
    expect(await fake.db.query.passwordResets!.findMany()).toHaveLength(0);
  });
  it('throttles without revealing account state', async () => {
    h.reserve.mockRejectedValue(new Error('throttled'));
    expect((await post('forgot-password', { email: EMAIL })).status).toBe(202);
    await vi.runAllTimersAsync();
    expect(h.send).not.toHaveBeenCalled();
  });
  it('reports disabled mail without issuing a token', async () => {
    h.enabled = false;
    expect(await (await app.request('/auth/forgot-password/available')).json()).toEqual({
      available: false,
    });
    h.enabled = true;
    expect(await (await app.request('/auth/forgot-password/available')).json()).toEqual({
      available: true,
    });
    expect(await fake.db.query.passwordResets!.findMany()).toHaveLength(0);
  });
  it('uses the configured public web origin for the emailed link', async () => {
    vi.stubEnv('WEB_ORIGIN', 'https://haive.example.test');
    try {
      await user();
      await post('forgot-password', { email: EMAIL });
      await vi.runAllTimersAsync();
      expect(h.send.mock.calls[0]![0].text).toContain(
        'https://haive.example.test/reset-password?token=',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('rejects a short replacement password with the existing policy', async () => {
    expect((await post('reset-password', { token: 'token', newPassword: 'short' })).status).toBe(
      400,
    );
  });
});

describe('reset password admission', () => {
  it.each([undefined, '172.20.0.1', '8.8.8.8'])(
    'bounds one token independently of other tokens (peer: %s)',
    async (address) => {
      const counts = throttleRedis();
      const real = await vi.importActual<typeof import('../src/lib/auth-throttle.js')>(
        '../src/lib/auth-throttle.js',
      );
      h.reserve.mockImplementation(real.reserveAuthAttempt);
      vi.spyOn(fake.db.query.passwordResets!, 'findFirst').mockResolvedValue(undefined);
      const token = 'unknown-reset-token';
      const reset = (value: string) =>
        post('reset-password', { token: value, newPassword: 'new-password-long' }, address);
      for (let i = 0; i < AUTH_ACCOUNT_LIMIT; i++) expect((await reset(token)).status).toBe(400);
      const refused = await reset(token);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: 'rate_limited' });
      expect((await reset('another-reset-token')).status).toBe(400);
      expect(h.hash).not.toHaveBeenCalled();
      expect([...counts.keys()].sort()).toEqual(
        [
          'haive:auth-throttle:reset:acct:' + hashInviteToken(token),
          'haive:auth-throttle:reset:acct:' + hashInviteToken('another-reset-token'),
          ...(address === '8.8.8.8' ? ['haive:auth-throttle:reset:ip:8.8.8.8'] : []),
        ].sort(),
      );
    },
  );
  it('rejects an unknown token without hashing the replacement password', async () => {
    // SQL expiry and consumption predicates are exercised against PostgreSQL.
    vi.spyOn(fake.db.query.passwordResets!, 'findFirst').mockResolvedValue(undefined);
    const response = await post('reset-password', {
      token: 'unknown',
      newPassword: 'new-password-long',
    });
    expect(response.status).toBe(400);
    expect(h.hash).not.toHaveBeenCalled();
  });
  it('answers a throttled address before hashing even a live token', async () => {
    const row = await user();
    const token = await issuePasswordReset(fake.db as unknown as Database, String(row.id));
    h.reserve.mockRejectedValue(
      new HTTPException(429, {
        res: Response.json({ code: 'rate_limited' }, { status: 429 }),
      }),
    );
    const response = await post('reset-password', { token, newPassword: 'new-password-long' });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: 'rate_limited' });
    expect(h.hash).not.toHaveBeenCalled();
    expect(h.reserve).toHaveBeenCalledWith(expect.anything(), 'reset', hashInviteToken(token!));
  });
});
