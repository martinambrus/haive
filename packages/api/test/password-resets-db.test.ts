import { randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema } from '@haive/database';
import { computeEmailBlindIndex, encryptEmail, tryDecryptEmail } from '@haive/shared';
import {
  issuePasswordReset,
  consumePasswordReset,
  findPasswordResetRecipient,
  PASSWORD_RESET_COOLDOWN_MS,
} from '../src/lib/password-resets.js';

const url = process.env.PASSWORD_RESETS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/fpw_test'))
  throw new Error('Use a dedicated fpw_test database');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  close: vi.fn(),
  hash: vi.fn(async () => 'new-hash'),
  verify: vi.fn(async (password: string, hash: string) => password === hash),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/user-sockets.js', () => ({ closeUserSockets: h.close }));
vi.mock('../src/lib/auth-throttle.js', () => ({
  reserveAuthAttempt: async () => ({ refund: async () => {} }),
}));
// SQL, atomicity and constraints are under test; bcrypt cost is covered by password.test.ts.
vi.mock('../src/auth/password.js', () => ({
  hashPassword: h.hash,
  verifyPassword: h.verify,
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getEncryptionKey: async () => 'ab'.repeat(32) },
  secretsService: {
    getEmailBlindIndexPepper: async () => 'ef'.repeat(32),
    getJwtSecret: async () => 'cd'.repeat(32),
  },
}));
import { authRoutes } from '../src/routes/auth.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

describe.skipIf(!url)('password resets on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  const ids: string[] = [];
  const key = 'ab'.repeat(32);
  const pepper = 'ef'.repeat(32);
  const app = new Hono<AppEnv>().onError(errorHandler).route('/auth', authRoutes);
  const post = (path: string, body: unknown) =>
    app.request(`/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    for (const id of ids) {
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.targetId, id));
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await db.$client.end({ timeout: 5 });
  });
  async function user() {
    const email = `${randomUUID()}@example.test`;
    const [row] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: encryptEmail(email, '12'.repeat(32)),
        emailBlindIndex: 'old-' + randomUUID(),
        passwordHash: 'old-hash',
        gitEmail: ` ${email.toUpperCase()} `,
        mustChangePassword: true,
      })
      .returning();
    ids.push(row!.id);
    return { ...row!, email };
  }
  it('the SQL claim lookup normalizes git email and requires the discard event', async () => {
    const row = await user();
    const index = computeEmailBlindIndex(row.email, pepper);
    expect(await findPasswordResetRecipient(db, row.email, index, key)).toBeNull();
    const [gate] = await db
      .insert(schema.auditEvents)
      .values({
        actorUserId: '00000000-0000-0000-0000-000000000000',
        action: 'config.discard_unreadable_secrets',
        targetType: 'system',
      })
      .returning();
    try {
      expect(await findPasswordResetRecipient(db, row.email, index, key)).toMatchObject({
        userId: row.id,
        to: row.email,
        claimEmailEncrypted: expect.any(String),
      });
    } finally {
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.id, gate!.id));
    }
  });
  it('refuses direct issuance for a deactivated user at the SQL user lock', async () => {
    const row = await user();
    await db.update(schema.users).set({ status: 'deactivated' }).where(eq(schema.users.id, row.id));
    await expect(issuePasswordReset(db, row.id)).rejects.toMatchObject({ status: 400 });
    expect(
      await db.query.passwordResets.findMany({ where: eq(schema.passwordResets.userId, row.id) }),
    ).toEqual([]);
    expect(
      await db.query.auditEvents.findMany({ where: eq(schema.auditEvents.targetId, row.id) }),
    ).toEqual([]);
  });
  it('atomically consumes once, revokes refresh tokens, bumps the version, and audits', async () => {
    const row = await user();
    await db.insert(schema.refreshTokens).values({
      userId: row.id,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const token = await issuePasswordReset(db, row.id);
    const responses = await Promise.all(
      [1, 2].map(() => post('reset-password', { token, newPassword: 'new-password-long' })),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(responses.find((r) => r.status === 200)!.headers.getSetCookie()).toEqual([
      expect.stringMatching(/haive_access=.*Max-Age=0/),
      expect.stringMatching(/haive_refresh=.*Max-Age=0/),
    ]);
    const updated = await db.query.users.findFirst({ where: eq(schema.users.id, row.id) });
    expect(updated).toMatchObject({
      tokenVersion: 1,
      mustChangePassword: false,
      passwordHash: 'new-hash',
    });
    const sessions = await db.query.refreshTokens.findMany({
      where: eq(schema.refreshTokens.userId, row.id),
    });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(h.close).toHaveBeenCalledWith(row.id);
    const audit = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.targetId, row.id),
    });
    expect(audit.some((a) => a.action === 'auth.password_reset.complete')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(token);
  });
  it.each([true, false])(
    'an unchanged password is refused only for a forced change (%s), without consuming the link',
    async (forced) => {
      const row = await user();
      const password = 'temporary-password-long';
      await db
        .update(schema.users)
        .set({ passwordHash: password, mustChangePassword: forced })
        .where(eq(schema.users.id, row.id));
      await db.insert(schema.refreshTokens).values({
        userId: row.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const token = await issuePasswordReset(db, row.id);
      const response = await post('reset-password', { token, newPassword: password });
      expect(response.status).toBe(forced ? 400 : 200);
      if (!forced) return;
      expect(await response.json()).toEqual({
        error: 'Choose a password different from the one you were given',
        code: 'password_unchanged',
      });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await db.query.users.findFirst({ where: eq(schema.users.id, row.id) })).toMatchObject({
        passwordHash: password,
        tokenVersion: 0,
        mustChangePassword: true,
      });
      expect(
        (await db.query.passwordResets.findFirst({
          where: eq(schema.passwordResets.userId, row.id),
        }))!.consumedAt,
      ).toBeNull();
      expect(
        (await db.query.refreshTokens.findFirst({
          where: eq(schema.refreshTokens.userId, row.id),
        }))!.revokedAt,
      ).toBeNull();
      const audits = await db.query.auditEvents.findMany({
        where: eq(schema.auditEvents.targetId, row.id),
      });
      expect(audits.some((a) => a.action === 'auth.password_reset.complete')).toBe(false);
      expect(
        (await post('reset-password', { token, newPassword: 'different-password-long' })).status,
      ).toBe(200);
    },
  );
  it('uses the application clock for issuance and both redemption checks', async () => {
    const row = await user();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2000-01-01'));
    try {
      const token = await issuePasswordReset(db, row.id);
      const response = await post('reset-password', {
        token,
        newPassword: randomBytes(24).toString('hex'),
      });
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
  it('expiry uses an injected clock and superseded links have the same refusal', async () => {
    const row = await user();
    const expired = await issuePasswordReset(db, row.id, null, { now: new Date('2000-01-01') });
    h.hash.mockClear();
    h.verify.mockClear();
    // Also bypass the HTTP admission hint: the transactional claim must reject before bcrypt.
    await expect(
      consumePasswordReset(db, expired!, 'new-password-long', key, pepper),
    ).rejects.toThrow('That reset link is invalid or expired. Request a new one.');
    const first = await post('reset-password', {
      token: expired,
      newPassword: 'new-password-long',
    });
    const old = await issuePasswordReset(db, row.id, null, {
      now: new Date(Date.now() - PASSWORD_RESET_COOLDOWN_MS),
    });
    await issuePasswordReset(db, row.id);
    const second = await post('reset-password', { token: old, newPassword: 'new-password-long' });
    const unknown = await post('reset-password', {
      token: 'unknown',
      newPassword: 'new-password-long',
    });
    expect([first.status, second.status, unknown.status]).toEqual([400, 400, 400]);
    expect(await first.text()).toBe(await second.text());
    const unknownBody = await unknown.text();
    for (const token of ['', null, 'x'.repeat(256)]) {
      const malformed = await post('reset-password', { token, newPassword: 'new-password-long' });
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).toBe(unknownBody);
    }
    expect(h.hash).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });
  it('serializes the cooldown and preserves the first token until its boundary', async () => {
    const row = await user();
    const now = new Date('2026-11-13T12:00:00Z');
    const options = { now, cooldownMs: 10 };
    const tokens = await Promise.all([
      issuePasswordReset(db, row.id, null, options),
      issuePasswordReset(db, row.id, null, options),
    ]);
    expect(tokens.filter((t) => t !== null)).toHaveLength(1);
    expect(tokens.filter((t) => t === null)).toHaveLength(1);
    const first = await db.query.passwordResets.findMany({
      where: eq(schema.passwordResets.userId, row.id),
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.consumedAt).toBeNull();
    expect(
      await issuePasswordReset(db, row.id, null, {
        now: new Date(now.getTime() + 9),
        cooldownMs: 10,
      }),
    ).toBeNull();
    expect(
      await issuePasswordReset(db, row.id, null, {
        now: new Date(now.getTime() + 10),
        cooldownMs: 10,
      }),
    ).toBeTypeOf('string');
    const superseded = await db.query.passwordResets.findFirst({
      where: eq(schema.passwordResets.id, first[0]!.id),
    });
    expect(superseded!.consumedAt).not.toBeNull();
    const audits = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.targetId, row.id),
    });
    expect(audits.filter((a) => a.action === 'auth.password_reset.request')).toHaveLength(2);
  });
  it('a claim repairs the email and index and can log in with that email', async () => {
    const row = await user();
    const token = await issuePasswordReset(db, row.id, encryptEmail(row.email, key));
    expect((await post('reset-password', { token, newPassword: 'new-password-long' })).status).toBe(
      200,
    );
    const updated = await db.query.users.findFirst({ where: eq(schema.users.id, row.id) });
    expect(tryDecryptEmail(updated!.emailEncrypted, key)).toBe(row.email);
    expect(updated!.emailBlindIndex).toBe(computeEmailBlindIndex(row.email, pepper));
    expect((await post('login', { email: row.email, password: 'new-hash' })).status).toBe(200);
  });
  it('a taken index rolls back the claim, password, revocations and token consumption', async () => {
    const row = await user();
    const holder = await user();
    await db
      .update(schema.users)
      .set({ emailBlindIndex: computeEmailBlindIndex(row.email, pepper) })
      .where(eq(schema.users.id, holder.id));
    const token = await issuePasswordReset(db, row.id, encryptEmail(row.email, key));
    h.hash.mockClear();
    h.verify.mockClear();
    expect((await post('reset-password', { token, newPassword: 'new-password-long' })).status).toBe(
      409,
    );
    expect(h.hash).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, row.id) })).toMatchObject({
      passwordHash: 'old-hash',
      tokenVersion: 0,
      mustChangePassword: true,
    });
    const resets = await db.query.passwordResets.findMany({
      where: eq(schema.passwordResets.userId, row.id),
    });
    expect(resets[0]!.consumedAt).toBeNull();
    await db.delete(schema.users).where(eq(schema.users.id, holder.id));
    await expect(consumePasswordReset(db, token!, 'new-password-long', key, pepper)).resolves.toBe(
      row.id,
    );
  });
  it.each(['issuance', 'redemption'])(
    '%s permits a refresh-shaped transaction under the held user lock',
    async (operation) => {
      const row = await user();
      const token = await issuePasswordReset(db, row.id);
      const [session] = await db
        .insert(schema.refreshTokens)
        .values({
          userId: row.id,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning();
      let checked = false;
      const wrapped = new Proxy(db, {
        get(target, prop) {
          if (prop === 'transaction')
            return (run: (tx: unknown) => Promise<unknown>) =>
              target.transaction((tx) =>
                run(
                  new Proxy(tx, {
                    get(t, p) {
                      if (p === 'select')
                        return (fields: { id: typeof schema.users.id }) => ({
                          from: (table: typeof schema.users) => ({
                            where: (condition: ReturnType<typeof eq>) => ({
                              for: async (strength: 'update' | 'no key update') => {
                                const rows = await t
                                  .select(fields)
                                  .from(table)
                                  .where(condition)
                                  .for(strength);
                                // A second connection holds a refresh row, then takes the FK's user lock.
                                // NOWAIT makes an incompatible user lock fail without sleeps.
                                await db.transaction(async (refresh) => {
                                  await refresh
                                    .update(schema.refreshTokens)
                                    .set({ revokedAt: new Date() })
                                    .where(eq(schema.refreshTokens.id, session!.id));
                                  await refresh.execute(
                                    sql`select id from users where id = ${row.id} for key share nowait`,
                                  );
                                  await refresh.insert(schema.refreshTokens).values({
                                    userId: row.id,
                                    tokenHash: randomUUID(),
                                    expiresAt: new Date(Date.now() + 60_000),
                                  });
                                });
                                checked = true;
                                return rows;
                              },
                            }),
                          }),
                        });
                      const value = Reflect.get(t, p);
                      return typeof value === 'function' ? value.bind(t) : value;
                    },
                  }),
                ),
              );
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const result =
        operation === 'issuance'
          ? issuePasswordReset(wrapped, row.id)
          : consumePasswordReset(wrapped, token!, 'new-password-long', key, pepper);
      if (operation === 'issuance') await expect(result).resolves.toBeNull();
      else await expect(result).resolves.toBe(row.id);
      expect(checked).toBe(true);
    },
  );
  it.each([false, true])('refuses redemption after deactivation (claim: %s)', async (claim) => {
    const row = await user();
    const token = await issuePasswordReset(db, row.id, claim ? encryptEmail(row.email, key) : null);
    await db.update(schema.users).set({ status: 'deactivated' }).where(eq(schema.users.id, row.id));
    const response = await post('reset-password', { token, newPassword: 'new-password-long' });
    expect(response.status).toBe(400);
    const unknown = await post('reset-password', {
      token: 'unknown',
      newPassword: 'new-password-long',
    });
    expect(await response.text()).toBe(await unknown.text());
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, row.id) })).toMatchObject({
      passwordHash: 'old-hash',
      tokenVersion: 0,
      mustChangePassword: true,
    });
    const reset = await db.query.passwordResets.findFirst({
      where: eq(schema.passwordResets.userId, row.id),
    });
    expect(reset!.consumedAt).toBeNull();
  });
  it('refuses a claim whose target email became readable after issuance', async () => {
    const row = await user();
    const token = await issuePasswordReset(db, row.id, encryptEmail(row.email, key));
    const repairedEmail = `repaired-${row.email}`;
    const emailEncrypted = encryptEmail(repairedEmail, key);
    const emailBlindIndex = computeEmailBlindIndex(repairedEmail, pepper);
    await db
      .update(schema.users)
      .set({ emailEncrypted, emailBlindIndex })
      .where(eq(schema.users.id, row.id));
    await db.insert(schema.refreshTokens).values({
      userId: row.id,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    h.hash.mockClear();
    h.verify.mockClear();
    const response = await post('reset-password', { token, newPassword: 'new-password-long' });
    expect(response.status).toBe(400);
    expect(h.hash).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    const unknown = await post('reset-password', {
      token: 'unknown',
      newPassword: 'new-password-long',
    });
    expect(await response.text()).toBe(await unknown.text());
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, row.id) })).toMatchObject({
      emailEncrypted,
      emailBlindIndex,
      passwordHash: 'old-hash',
      tokenVersion: 0,
      mustChangePassword: true,
    });
    expect(
      (await db.query.passwordResets.findFirst({
        where: eq(schema.passwordResets.userId, row.id),
      }))!.consumedAt,
    ).toBeNull();
    expect(
      (await db.query.refreshTokens.findFirst({
        where: eq(schema.refreshTokens.userId, row.id),
      }))!.revokedAt,
    ).toBeNull();
    const audits = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.targetId, row.id),
    });
    expect(audits.some((a) => a.action === 'auth.password_reset.complete')).toBe(false);
  });
  it('an audit failure rolls the entire reset back', async () => {
    const row = await user();
    const token = await issuePasswordReset(db, row.id);
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction')
          return (run: (tx: unknown) => Promise<unknown>) =>
            target.transaction((tx) =>
              run(
                new Proxy(tx, {
                  get(t, p) {
                    if (p === 'insert')
                      return (table: unknown) => {
                        if (table === schema.auditEvents)
                          throw new Error('synthetic audit failure');
                        return t.insert(table as typeof schema.auditEvents);
                      };
                    const v = Reflect.get(t, p);
                    return typeof v === 'function' ? v.bind(t) : v;
                  },
                }),
              ),
            );
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await expect(
      consumePasswordReset(broken, token!, 'new-password-long', key, pepper),
    ).rejects.toThrow('synthetic audit failure');
    expect(
      (await db.query.passwordResets.findFirst({
        where: eq(schema.passwordResets.userId, row.id),
      }))!.consumedAt,
    ).toBeNull();
    expect(
      (await db.query.users.findFirst({ where: eq(schema.users.id, row.id) }))!.passwordHash,
    ).toBe('old-hash');
  });
});
