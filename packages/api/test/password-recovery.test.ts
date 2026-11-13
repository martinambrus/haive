import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ConfigUnavailableError, computeEmailBlindIndex, encryptEmail } from '@haive/shared';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  enabled: true,
  send: vi.fn(),
  reserve: vi.fn(),
  close: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/mailer.js', () => ({ sendMail: h.send }));
vi.mock('../src/lib/auth-throttle.js', () => ({ reserveAuthAttempt: h.reserve }));
vi.mock('../src/lib/user-sockets.js', () => ({ closeUserSockets: h.close }));
vi.mock('../src/auth/password.js', () => ({ hashPassword: async () => 'new-hash' }));
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
import { PASSWORD_RESET_TTL_MS } from '../src/lib/password-resets.js';
import type { AppEnv } from '../src/context.js';

const KEY = 'ab'.repeat(32);
const EMAIL = 'person@example.test';
const blind = (email: string) => computeEmailBlindIndex(email, 'ef'.repeat(32));
const app = new Hono<AppEnv>().onError(errorHandler).route('/auth', authRoutes);
const post = (path: string, body: unknown) =>
  app.request(`/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
      expect(h.reserve).toHaveBeenCalledWith(expect.anything(), 'login', blind(EMAIL));
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
