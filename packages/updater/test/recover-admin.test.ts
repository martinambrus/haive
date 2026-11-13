import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { computeEmailBlindIndex, decryptEmail, encryptEmail } from '@haive/shared';
import bcrypt from 'bcrypt';
import { RECOVERY_PASSWORD_ROUNDS, recoverAdmin } from '../src/recover-admin.js';

const key = '11'.repeat(32);
const oldKey = '22'.repeat(32);
const admin = '00000000-0000-4000-8000-000000000001';
const orphan = '00000000-0000-4000-8000-000000000002';
const readable = '00000000-0000-4000-8000-000000000003';
const options = { email: 'admin@example.com', key, pepper: 'pepper', force: true };
let fake: ReturnType<typeof createFakeDb>;
let db: Database;
const hashPassword = (value: string) => bcrypt.hash(value, 4);
let oldHash: string;
beforeAll(async () => {
  oldHash = await hashPassword('previous-password');
});

beforeEach(() => {
  fake = createFakeDb({ users: schema.users, auditEvents: schema.auditEvents });
  db = fake.db as unknown as Database;
  for (const [id, role, fieldKey] of [
    [admin, 'admin', oldKey],
    [orphan, 'user', oldKey],
    [readable, 'user', key],
  ]) {
    fake.insert(schema.users, {
      id,
      role,
      status: 'active',
      emailEncrypted: encryptEmail(`${id}@example.com`, fieldKey!),
      emailBlindIndex: id,
      passwordHash: oldHash,
      tokenVersion: 4,
      mustChangePassword: false,
      updatedAt: new Date(),
    });
  }
});

it('restores the chosen admin and invalidates every orphan password, leaving readable users alone', async () => {
  const before = structuredClone(fake.rows(schema.users)[2]);
  const result = await recoverAdmin(db, options, hashPassword);
  const [owner, lost] = fake.rows(schema.users);
  expect(decryptEmail(owner!.emailEncrypted as string, key)).toBe(options.email);
  expect(owner).toMatchObject({
    emailBlindIndex: computeEmailBlindIndex(options.email, options.pepper),
    mustChangePassword: true,
    tokenVersion: 5,
  });
  expect(await bcrypt.compare(result.temporaryPassword, owner!.passwordHash as string)).toBe(true);
  expect(lost).toMatchObject({ mustChangePassword: true, tokenVersion: 5 });
  expect(lost!.passwordHash).toMatch(/^\$2b\$04\$/);
  expect(await bcrypt.compare('previous-password', lost!.passwordHash as string)).toBe(false);
  expect(RECOVERY_PASSWORD_ROUNDS).toBe(12);
  expect(fake.rows(schema.users)[2]).toEqual(before);
  expect(fake.rows(schema.auditEvents)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'user.recover_admin', targetId: admin }),
    ]),
  );
  expect(JSON.stringify(fake.rows(schema.auditEvents))).not.toContain(result.temporaryPassword);
});

it('reissues the temporary password without touching an already cleared orphan or rewriting the email', async () => {
  const first = await recoverAdmin(db, options, hashPassword);
  const cleared = structuredClone(fake.rows(schema.users)[1]);
  const encryptedEmail = fake.rows(schema.users)[0]!.emailEncrypted;
  const second = await recoverAdmin(db, options, hashPassword);
  expect(second.temporaryPassword).not.toBe(first.temporaryPassword);
  expect(fake.rows(schema.users)[1]).toEqual(cleared);
  expect(fake.rows(schema.users)[0]!.emailEncrypted).toBe(encryptedEmail);
  expect(fake.rows(schema.users)[0]!.tokenVersion).toBe(6);
});

it('refuses an email held by a readable row without changing anything', async () => {
  fake.patch(schema.users, readable, {
    emailBlindIndex: computeEmailBlindIndex(options.email, options.pepper),
  });
  const before = structuredClone(fake.rows(schema.users));
  await expect(recoverAdmin(db, options, hashPassword)).rejects.toThrow('already');
  expect(fake.rows(schema.users)).toEqual(before);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});

it('lists admin ids when the choice is ambiguous, then accepts an explicit id', async () => {
  fake.patch(schema.users, orphan, { role: 'admin' });
  const before = structuredClone(fake.rows(schema.users));
  await expect(recoverAdmin(db, options, hashPassword)).rejects.toThrow(`${admin}, ${orphan}`);
  expect(fake.rows(schema.users)).toEqual(before);
  const result = await recoverAdmin(db, { ...options, userId: orphan }, hashPassword);
  expect(result.userId).toBe(orphan);
});

it('refuses a non-admin selection and a database with no admins', async () => {
  await expect(recoverAdmin(db, { ...options, userId: readable }, hashPassword)).rejects.toThrow(
    'admin',
  );
  fake.patch(schema.users, admin, { role: 'user' });
  await expect(recoverAdmin(db, options, hashPassword)).rejects.toThrow('admin');
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});

it('rolls back passwords and email when the required audit fails', async () => {
  const before = structuredClone(fake.rows(schema.users));
  fake.hooks.beforeInsert = async (table) => {
    if (table === schema.auditEvents) throw new Error('audit refused');
  };
  await expect(recoverAdmin(db, options, hashPassword)).rejects.toThrow('audit refused');
  expect(fake.rows(schema.users)).toEqual(before);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});

it('clears an orphan again if its password was subsequently changed', async () => {
  await recoverAdmin(db, options, hashPassword);
  fake.patch(schema.users, orphan, { tokenVersion: 6, passwordHash: 'new-known-password' });
  await recoverAdmin(db, options, hashPassword);
  expect(fake.rows(schema.users)[1]).toMatchObject({ tokenVersion: 7, mustChangePassword: true });
  expect(fake.rows(schema.users)[1]!.passwordHash).not.toBe('new-known-password');
});

it('frees a blind index held only by an unreadable row', async () => {
  fake.patch(schema.users, orphan, {
    emailBlindIndex: computeEmailBlindIndex(options.email, options.pepper),
  });
  await recoverAdmin(db, options, hashPassword);
  expect(fake.rows(schema.users)[0]!.emailBlindIndex).toBe(
    computeEmailBlindIndex(options.email, options.pepper),
  );
  expect(fake.rows(schema.users)[1]!.emailBlindIndex).not.toBe(
    fake.rows(schema.users)[0]!.emailBlindIndex,
  );
});

it('uses 32 random bytes for an orphan password and never reuses the admin password', async () => {
  const inputs: string[] = [];
  const result = await recoverAdmin(db, options, async (value) => {
    inputs.push(value);
    return hashPassword(value);
  });
  expect(inputs[0]).toBe(result.temporaryPassword);
  expect(inputs[1]).toMatch(/^[a-f0-9]{64}$/);
  expect(inputs[1]).not.toBe(result.temporaryPassword);
});

it('reactivates the explicitly recovered administrator so the temporary password can sign in', async () => {
  fake.patch(schema.users, admin, { status: 'deactivated' });
  await recoverAdmin(db, { ...options, userId: admin }, hashPassword);
  expect(fake.rows(schema.users)[0]!.status).toBe('active');
  expect(fake.rows(schema.auditEvents)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'user.recover_admin',
        metadata: { relinked: true, reactivated: true },
      }),
    ]),
  );
});

it('refuses orphan invalidation without discard evidence and writes nothing', async () => {
  const before = structuredClone(fake.rows(schema.users));
  const report = vi.fn();
  await expect(
    recoverAdmin(db, { ...options, force: false, reportInvalidationCount: report }, hashPassword),
  ).rejects.toThrow('config.discard_unreadable_secrets');
  expect(report).toHaveBeenCalledWith(1);
  expect(fake.rows(schema.users)).toEqual(before);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});
it('accepts discard evidence and reports the orphan count before any writes', async () => {
  fake.insert(schema.auditEvents, { action: 'config.discard_unreadable_secrets' });
  const before = structuredClone(fake.rows(schema.users));
  const report = vi.fn(() => expect(fake.rows(schema.users)).toEqual(before));
  await recoverAdmin(
    db,
    { ...options, force: false, reportInvalidationCount: report },
    hashPassword,
  );
  expect(report).toHaveBeenCalledWith(1);
  expect(fake.rows(schema.users)[1]!.tokenVersion).toBe(5);
});
it('allows an explicit force without discard evidence', async () => {
  await recoverAdmin(db, { ...options, force: true }, hashPassword);
  expect(fake.rows(schema.users)[1]!.tokenVersion).toBe(5);
});
