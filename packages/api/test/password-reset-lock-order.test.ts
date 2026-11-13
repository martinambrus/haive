import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { encryptEmail } from '@haive/shared';
import { consumePasswordReset, issuePasswordReset } from '../src/lib/password-resets.js';

vi.mock('../src/auth/password.js', () => ({
  hashPassword: async () => 'hashed',
  verifyPassword: async () => false,
}));

it('revokes refresh rows before a claim changes the unique user email index', async () => {
  const key = randomBytes(32).toString('hex');
  const fake = createFakeDb({
    users: schema.users,
    refreshTokens: schema.refreshTokens,
    passwordResets: schema.passwordResets,
    auditEvents: schema.auditEvents,
  });
  const db = fake.db as unknown as Database;
  const [user] = await db
    .insert(schema.users)
    .values({
      emailEncrypted: encryptEmail('holder@example.test', randomBytes(32).toString('hex')),
      emailBlindIndex: 'old-index',
      passwordHash: randomBytes(32).toString('hex'),
      status: 'active',
    })
    .returning();
  const now = new Date();
  await db.insert(schema.refreshTokens).values({
    userId: user!.id,
    tokenHash: randomBytes(32).toString('hex'),
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const token = await issuePasswordReset(db, user!.id, encryptEmail('holder@example.test', key), {
    now,
  });
  const writes: unknown[] = [];
  fake.hooks.beforeUpdate = async (table) => {
    writes.push(table);
  };
  await consumePasswordReset(
    db,
    token!,
    randomBytes(24).toString('hex'),
    key,
    randomBytes(32).toString('hex'),
    now,
  );
  expect(writes).toEqual([schema.passwordResets, schema.refreshTokens, schema.users]);
});
