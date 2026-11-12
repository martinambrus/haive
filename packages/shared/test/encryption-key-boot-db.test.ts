import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { encrypt, encryptEmail, envelopeEncrypt, envelopeDecrypt } from '../src/crypto/index.js';
import { generateBootEncryptionKey } from '../src/config/encryption-key-boot.js';

const url = process.env.ENCRYPTION_KEY_BOOT_TEST_URL;
const oldKey = 'ab'.repeat(32);
const oldMaster = 'cd'.repeat(32);

describe.skipIf(!url)('boot encryption key database boundary', () => {
  let db: Database;
  beforeAll(() => {
    if (!new URL(url!).pathname.endsWith('/encryption_key_boot_test')) {
      throw new Error('Use a dedicated encryption_key_boot_test database');
    }
    db = createDatabase(url!);
  });
  beforeEach(async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    await db.$client`truncate system_secrets, users, audit_events cascade`;
    await db.insert(schema.systemSecrets).values({
      key: 'master_kek',
      encryptedValue: encrypt(oldMaster, oldKey),
    });
  });
  afterEach(async () => {
    await db.$client`drop trigger if exists refuse_key_discard on system_secrets`;
    await db.$client`drop function if exists refuse_key_discard()`;
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  function store() {
    let key: string | null = null;
    let pending: string | null = null;
    const publishPending = vi.fn(async (value: string) => {
      // A fresh connection proves the audit committed before any usable key appears.
      if (JSON.parse(value).discard) {
        const rows =
          await db.$client`select id from audit_events where id = ${JSON.parse(value).id}`;
        expect(rows).toHaveLength(1);
      }
      key ??= JSON.parse(value).key;
      if (pending === value) pending = null;
    });
    return {
      getKey: async () => key,
      getPending: async () => pending,
      reservePending: async (value: string) => {
        pending ??= value;
      },
      publishPending,
    };
  }

  it('refuses existing ciphertext without the explicit override', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '');
    const state = store();
    await expect(generateBootEncryptionKey(db, state)).rejects.toThrow('CONFIG_ENCRYPTION_KEY');
    expect(await state.getKey()).toBeNull();
    expect(await db.select().from(schema.systemSecrets)).toHaveLength(1);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
  });

  it('concurrent discard commits one audit, clears system secrets and retains bad envelopes', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: encryptEmail('lost@example.test', oldKey),
        emailBlindIndex: '0'.repeat(64),
        passwordHash: 'fixture',
      })
      .returning({ id: schema.users.id });
    const envelope = envelopeEncrypt('retained', oldMaster);
    await db.insert(schema.userSecrets).values({ userId: user!.id, keyName: 'token', ...envelope });
    const state = store();
    await Promise.all([generateBootEncryptionKey(db, state), generateBootEncryptionKey(db, state)]);
    const audits = await db.select().from(schema.auditEvents);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: '00000000-0000-0000-0000-000000000000',
      metadata: { unreadableSecretCount: 3, discardedSystemSecretCount: 1 },
    });
    expect(await db.select().from(schema.systemSecrets)).toHaveLength(0);
    expect(await db.select().from(schema.userSecrets)).toHaveLength(1);
    expect(() => envelopeDecrypt(envelope, 'ef'.repeat(32))).toThrow();
    expect(await state.getKey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a deferred commit refusal rolls back the discard and audit, and publishes no key', async () => {
    await db.$client.unsafe(`
      create function refuse_key_discard() returns trigger language plpgsql as $$
      begin raise exception 'refuse discard commit'; end $$;
      create constraint trigger refuse_key_discard after delete on system_secrets
        deferrable initially deferred for each row execute function refuse_key_discard();
    `);
    const state = store();
    await expect(generateBootEncryptionKey(db, state)).rejects.toThrow();
    expect(state.publishPending).not.toHaveBeenCalled();
    expect(await db.select().from(schema.systemSecrets)).toHaveLength(1);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
    const pending = await state.getPending();
    await db.$client`drop trigger refuse_key_discard on system_secrets`;
    await generateBootEncryptionKey(db, state);
    expect(await state.getKey()).toBe(JSON.parse(pending!).key);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(1);
  });
});
