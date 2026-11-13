import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { schema, type Database } from '@haive/database';
import {
  ConfigUnavailableError,
  computeEmailBlindIndex,
  encryptEmail,
  tryDecryptEmail,
} from '@haive/shared';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../src/context.js';
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  role: 'admin',
  send: vi.fn(),
  close: vi.fn(),
  hash: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/mailer.js', () => ({ sendMail: h.send }));
vi.mock('../src/lib/user-sockets.js', () => ({ closeUserSockets: h.close }));
vi.mock('../src/auth/password.js', () => ({ hashPassword: h.hash }));
vi.mock('../src/middleware/auth.js', async (original) => ({
  ...(await original<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getEncryptionKey: async () => 'ab'.repeat(32) },
  secretsService: { getEmailBlindIndexPepper: async () => 'ef'.repeat(32) },
}));
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { issuePasswordReset } from '../src/lib/password-resets.js';
import { hashInviteToken } from '../src/lib/invites.js';
const app = new Hono<AppEnv>().onError(errorHandler).route('/admin', adminRoutes);
const KEY = 'ab'.repeat(32);
const EMAIL = 'person@example.test';
let fake: ReturnType<typeof createFakeDb>;
const post = (id: string, email = `  ${EMAIL.toUpperCase()}  `) =>
  app.request(`/admin/users/${id}/relink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'evil.example' },
    body: JSON.stringify({ email }),
  });
async function user(readable = false, status = 'active', email = EMAIL) {
  const [row] = await fake.db
    .insert(schema.users)
    .values({
      emailEncrypted: encryptEmail(email, readable ? KEY : '12'.repeat(32)),
      emailBlindIndex: readable ? computeEmailBlindIndex(email, 'ef'.repeat(32)) : 'old-index',
      passwordHash: 'old-hash',
      mustChangePassword: false,
      tokenVersion: 2,
      status,
    })
    .returning();
  await fake.db
    .insert(schema.refreshTokens)
    .values({ userId: row!.id, tokenHash: 'session', expiresAt: new Date(Date.now() + 60000) });
  return row!;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
  vi.stubEnv('WEB_ORIGIN', 'https://haive.example');
  fake = createFakeDb({
    users: schema.users,
    refreshTokens: schema.refreshTokens,
    passwordResets: schema.passwordResets,
    auditEvents: schema.auditEvents,
    userInvites: schema.userInvites,
  });
  h.db = fake.db;
  h.role = 'admin';
  h.send.mockReset().mockResolvedValue({ ok: true });
  h.close.mockReset();
  h.hash.mockReset().mockResolvedValue('random-hash');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it('refuses a signed-in non-admin before reaching the handler', async () => {
  h.role = 'user';
  expect((await post('00000000-0000-4000-8000-000000000099')).status).toBe(403);
  expect(h.hash).not.toHaveBeenCalled();
});
it('prevents caching the invitation reply carrying its one-time token', async () => {
  const response = await app.request('/admin/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'user' }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ token: expect.any(String) });
});
it.each([
  [true, 'active', 'relink_not_orphaned'],
  [false, 'deactivated', 'relink_deactivated'],
] as const)('refuses readable=%s status=%s', async (readable, status, code) => {
  const row = await user(readable, status);
  const res = await post(String(row.id));
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code });
  expect(h.send).not.toHaveBeenCalled();
});
it('returns 404 for an unknown user', async () => {
  const res = await post('00000000-0000-4000-8000-000000000099');
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: 'User not found' });
});
it('refuses to relink the calling admin and changes nothing', async () => {
  await fake.db.insert(schema.users).values({
    id: '00000000-0000-4000-8000-000000000001',
    emailEncrypted: encryptEmail(EMAIL, '12'.repeat(32)),
    emailBlindIndex: 'caller-index',
    passwordHash: 'old-hash',
  });
  const before = structuredClone(fake.rows(schema.users));
  const res = await post('00000000-0000-4000-8000-000000000001');
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: 'Cannot relink the calling admin' });
  expect(fake.rows(schema.users)).toEqual(before);
});
it('a held email refuses with a typed conflict and leaves all state intact', async () => {
  const row = await user();
  await user(true);
  const before = structuredClone([fake.rows(schema.users), fake.rows(schema.refreshTokens)]);
  const res = await post(String(row.id));
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'relink_email_taken' });
  expect([fake.rows(schema.users), fake.rows(schema.refreshTokens)]).toEqual(before);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
  expect(fake.rows(schema.passwordResets)).toEqual([]);
});
it('relinks, revokes before the key update, audits, and sends only after commit at the configured origin', async () => {
  const row = await user();
  let committed = false;
  const writes: string[] = [];
  fake.hooks.beforeUpdate = async (table) => {
    if (table === schema.users) writes.push('user');
    if (table === schema.refreshTokens) writes.push('refresh');
  };
  fake.hooks.beforeCommit = async () => {
    committed = true;
  };
  h.send.mockImplementation(async () => {
    expect(committed).toBe(true);
    expect(h.close).toHaveBeenCalledWith(row.id);
    return { ok: true };
  });
  const res = await post(String(row.id));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, delivery: 'mailed' });
  const updated = await fake.db.query.users!.findFirst({
    where: eq(schema.users.id, String(row.id)),
  });
  expect(updated).toMatchObject({
    emailBlindIndex: computeEmailBlindIndex(EMAIL, 'ef'.repeat(32)),
    passwordHash: 'random-hash',
    mustChangePassword: true,
    tokenVersion: 3,
  });
  expect(tryDecryptEmail(String(updated!.emailEncrypted), KEY)).toBe(EMAIL);
  expect(
    (await fake.db.query.users!.findFirst({
      where: eq(schema.users.emailBlindIndex, computeEmailBlindIndex(EMAIL, 'ef'.repeat(32))),
    }))!.id,
  ).toBe(row.id);
  expect(h.hash.mock.calls[0]![0]).toMatch(/^[a-f0-9]{64}$/);
  expect(writes.indexOf('refresh')).toBeLessThan(writes.indexOf('user'));
  expect(fake.rows(schema.refreshTokens)[0]!.revokedAt).toEqual(new Date());
  const mail = h.send.mock.calls[0]![0];
  expect(mail.to).toBe(EMAIL);
  const link = new URL(mail.text.match(/https:\/\/[^\s]+/)[0]);
  expect(link.origin).toBe('https://haive.example');
  expect(link.pathname).toBe('/reset-password');
  expect(fake.rows(schema.passwordResets)[0]).toMatchObject({
    tokenHash: hashInviteToken(link.searchParams.get('token')!),
    claimEmailEncrypted: null,
  });
  expect(fake.rows(schema.auditEvents)).toContainEqual(
    expect.objectContaining({
      action: 'user.relink',
      actorUserId: '00000000-0000-4000-8000-000000000001',
      targetId: row.id,
    }),
  );
  expect(fake.rows(schema.auditEvents)).toContainEqual(
    expect.objectContaining({
      action: 'auth.password_reset.request',
      actorUserId: '00000000-0000-4000-8000-000000000001',
      targetId: row.id,
    }),
  );
  expect(JSON.stringify(fake.rows(schema.auditEvents))).not.toContain(EMAIL);
  expect(JSON.stringify(fake.rows(schema.auditEvents))).not.toContain(
    link.searchParams.get('token'),
  );
});
it.each(['disabled', 'failed', 'throw', 'config-outage'])(
  'returns a one-time link when mail is %s',
  async (kind) => {
    if (kind === 'throw') h.send.mockRejectedValue(new Error('SMTP secret'));
    else if (kind === 'config-outage')
      h.send.mockRejectedValue(new ConfigUnavailableError('get', { cause: new Error('outage') }));
    else
      h.send.mockResolvedValue({
        ok: false,
        code: kind === 'disabled' ? 'mail_disabled' : 'mail_send_failed',
      });
    const row = await user();
    const res = await post(String(row.id));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      ok: true,
      delivery: kind === 'disabled' ? 'manual' : 'failed',
      link: expect.stringMatching(/^https:\/\/haive.example\/reset-password\?token=/),
    });
  },
);
it('a recent forgot-password claim is superseded rather than blocking the admin', async () => {
  const row = await user();
  const old = await issuePasswordReset(
    fake.db as unknown as Database,
    String(row.id),
    encryptEmail(EMAIL, KEY),
  );
  const res = await post(String(row.id));
  expect(res.status).toBe(200);
  expect(h.send).toHaveBeenCalledOnce();
  const resets = fake.rows(schema.passwordResets);
  expect(resets).toHaveLength(2);
  expect(resets.find((r) => r.tokenHash === hashInviteToken(old!))!.consumedAt).not.toBeNull();
  expect(resets.find((r) => r.claimEmailEncrypted === null)!.consumedAt).toBeNull();
});
it('a refused required audit rolls back all writes and sends nothing', async () => {
  const row = await user();
  const before = structuredClone([fake.rows(schema.users), fake.rows(schema.refreshTokens)]);
  fake.hooks.beforeInsert = async (table) => {
    if (table === schema.auditEvents) throw new Error('audit refused');
  };
  expect((await post(String(row.id))).status).toBe(500);
  expect([fake.rows(schema.users), fake.rows(schema.refreshTokens)]).toEqual(before);
  expect(fake.rows(schema.passwordResets)).toEqual([]);
  expect(h.send).not.toHaveBeenCalled();
  expect(h.close).not.toHaveBeenCalled();
});
