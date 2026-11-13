import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { computeEmailBlindIndex, configService, encryptEmail, secretsService } from '@haive/shared';
import { recoverAdmin } from '../src/recover-admin.js';
import { main } from '../src/recover-admin-cli.js';

const url = process.env.RECOVER_ADMIN_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/recover_admin_test'))
  throw new Error('Use a dedicated recover_admin_test database for account recovery tests');
const key = '11'.repeat(32);
const oldKey = '22'.repeat(32);
const admin = '00000000-0000-4000-8000-000000000001';
const orphan = '00000000-0000-4000-8000-000000000002';
const options = { email: 'admin@example.com', key, pepper: 'pepper', force: true };
const cheapHash = (value: string) => bcrypt.hash(value, 4);

describe.skipIf(!url)('admin recovery on PostgreSQL', () => {
  let client: Sql;
  let db: Database;
  let oldHash: string;
  beforeAll(async () => {
    client = postgres(url!, { max: 1 });
    db = drizzle(client, { schema });
    oldHash = await cheapHash('old-password');
  });
  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await db.delete(schema.auditEvents);
    await db.delete(schema.users);
    await db.insert(schema.users).values([
      {
        id: admin,
        role: 'admin',
        emailEncrypted: encryptEmail('old-admin@example.com', oldKey),
        phoneEncrypted: encryptEmail('old-phone', oldKey),
        emailBlindIndex: 'old-admin',
        passwordHash: oldHash,
      },
      {
        id: orphan,
        role: 'user',
        emailEncrypted: encryptEmail('old-user@example.com', oldKey),
        emailBlindIndex: 'old-user',
        passwordHash: oldHash,
      },
    ]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('runs the CLI, restores the login lookup and bcrypt check, and preserves cleared rows on a rerun', async () => {
    vi.stubEnv('DATABASE_URL', url!);
    vi.stubEnv('REDIS_URL', 'redis://unused-in-this-db-control');
    // Redis boot has its own controls; exercise the CLI and its real user transaction here.
    vi.spyOn(configService, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue(key);
    vi.spyOn(configService, 'close').mockResolvedValue(undefined);
    vi.spyOn(secretsService, 'getEmailBlindIndexPepper').mockResolvedValue(options.pepper);
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    expect(await main(['--email', options.email, '--force'])).toBe(0);
    const password = stdout.match(/Temporary password: (\S+)/)?.[1];
    expect(password).toBeDefined();
    expect(stdout).toContain('Accounts whose passwords will be invalidated: 1\n');
    expect(stdout.match(/Temporary password:/g)).toHaveLength(1);
    const owner = await db.query.users.findFirst({
      where: eq(
        schema.users.emailBlindIndex,
        computeEmailBlindIndex(options.email, options.pepper),
      ),
    });
    expect(owner).toMatchObject({
      id: admin,
      status: 'active',
      mustChangePassword: true,
      tokenVersion: 1,
    });
    expect(await bcrypt.compare(password!, owner!.passwordHash)).toBe(true);
    const lost = await db.query.users.findFirst({ where: eq(schema.users.id, orphan) });
    expect(lost).toMatchObject({ mustChangePassword: true, tokenVersion: 1 });
    expect(await bcrypt.compare('old-password', lost!.passwordHash)).toBe(false);
    const second = await recoverAdmin(db, options, cheapHash);
    expect(second.temporaryPassword).not.toBe(password);
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, orphan) })).toEqual(lost);
    const audits = await db.select().from(schema.auditEvents);
    expect(audits.filter((row) => row.action === 'user.recovery.clear_password')).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(password!);
  });

  it('refuses an ambiguous choice and a readable email collision without changing users', async () => {
    await client`UPDATE users SET role = 'admin' WHERE id = ${orphan}`;
    const before = await db.select().from(schema.users);
    await expect(recoverAdmin(db, options, cheapHash)).rejects.toThrow(`${admin}, ${orphan}`);
    expect(await db.select().from(schema.users)).toEqual(before);
    await client`UPDATE users SET email_encrypted = ${encryptEmail(options.email, key)},
      email_blind_index = ${computeEmailBlindIndex(options.email, options.pepper)} WHERE id = ${orphan}`;
    await expect(recoverAdmin(db, { ...options, userId: admin }, cheapHash)).rejects.toThrow(
      'already',
    );
    expect(await db.select().from(schema.auditEvents)).toEqual([]);
  });

  it('rolls back every account change when the admin recovery audit is refused', async () => {
    const before = await client`SELECT * FROM users ORDER BY id`;
    await client.unsafe(`CREATE FUNCTION reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'user.recover_admin' THEN RAISE EXCEPTION 'recovery audit refused'; END IF; RETURN NEW; END $$`);
    await client.unsafe(
      'CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_recovery_audit()',
    );
    try {
      await expect(recoverAdmin(db, options, cheapHash)).rejects.toThrow();
      expect(await client`SELECT * FROM users ORDER BY id`).toEqual(before);
      expect(await db.select().from(schema.auditEvents)).toEqual([]);
    } finally {
      await client.unsafe('DROP TRIGGER reject_recovery_audit ON audit_events');
      await client.unsafe('DROP FUNCTION reject_recovery_audit()');
    }
  });
});
