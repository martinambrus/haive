import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { sql } from 'drizzle-orm';
import {
  decrypt,
  encrypt,
  encryptEmail,
  tryDecrypt,
  envelopeEncrypt,
  envelopeDecrypt,
} from '../src/crypto/index.js';
import {
  encryptionKeyBootDatabase,
  generateBootEncryptionKey,
} from '../src/config/encryption-key-boot.js';
import { configService } from '../src/config/config.service.js';
import { SecretUnreadableError } from '../src/config/secret-unreadable.js';
import { SecretsService } from '../src/config/secrets.service.js';

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
      const published = key === null;
      key ??= JSON.parse(value).key;
      if (pending === value) pending = null;
      return published;
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
    await expect(
      generateBootEncryptionKey(encryptionKeyBootDatabase(db.$client), state),
    ).rejects.toThrow('CONFIG_ENCRYPTION_KEY');
    expect(await state.getKey()).toBeNull();
    expect(await db.select().from(schema.systemSecrets)).toHaveLength(1);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
  });

  it('inventories a pre-0192 schema without integration tables before updater migration', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '');
    const state = store();
    await db.transaction(async (tx) => {
      for (const name of [
        'system_secrets',
        'users',
        'user_secrets',
        'cli_provider_secrets',
        'repo_credentials',
      ]) {
        await tx.execute(
          sql`CREATE TEMP TABLE ${sql.identifier(name)} (LIKE public.${sql.identifier(name)} INCLUDING DEFAULTS) ON COMMIT DROP`,
        );
      }
      await tx.execute(sql`INSERT INTO pg_temp.system_secrets SELECT * FROM public.system_secrets`);
      await tx.execute(sql`SET LOCAL search_path TO pg_temp`);
      await expect(generateBootEncryptionKey(tx, state)).rejects.toThrow(
        'Refusing to generate an encryption key: 1 encrypted rows',
      );
      expect(state.publishPending).not.toHaveBeenCalled();
    });
    expect(await db.select().from(schema.systemSecrets)).toHaveLength(1);
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
    await Promise.all([
      generateBootEncryptionKey(db, state),
      generateBootEncryptionKey(encryptionKeyBootDatabase(db.$client), state),
    ]);
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

describe.skipIf(!url)('a present key that cannot read the stored system secrets', () => {
  const NIL_UUID = '00000000-0000-0000-0000-000000000000';
  const NAMES = ['master_kek', 'jwt_secret', 'email_blind_index_pepper'];
  // Arbitrary constant key for the advisory lock that stalls the audit insert (test-only).
  const AUDIT_STALL_LOCK = 589_001;
  let db: Database;
  let peerDb: Database;
  let monitorDb: Database;
  let keyA: string;
  let keyB: string;
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');

  beforeAll(() => {
    if (!new URL(url!).pathname.endsWith('/encryption_key_boot_test')) {
      throw new Error('Use a dedicated encryption_key_boot_test database');
    }
    db = createDatabase(url!);
    peerDb = createDatabase(url!);
    monitorDb = createDatabase(url!);
  });
  beforeEach(async () => {
    keyA = randomBytes(32).toString('hex');
    keyB = randomBytes(32).toString('hex');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '');
    vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue(keyB);
    await db.$client`truncate system_secrets, users, audit_events cascade`;
  });
  afterEach(async () => {
    await db.$client`drop trigger if exists audit_gate on audit_events`;
    await db.$client`drop function if exists audit_gate()`;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await Promise.all([db, peerDb, monitorDb].map((d) => d?.$client.end({ timeout: 5 })));
  });

  async function seedUnreadable() {
    await db.insert(schema.systemSecrets).values(
      NAMES.map((key) => ({
        key,
        encryptedValue: encrypt(randomBytes(16).toString('hex'), keyA),
      })),
    );
  }
  /** SHA-256 per stored value, so a failure prints hashes and never a ciphertext. */
  async function storedHashes(): Promise<Record<string, string>> {
    const rows = await db.$client<
      { key: string; encrypted_value: string }[]
    >`select key, encrypted_value from system_secrets order by key`;
    return Object.fromEntries(rows.map((row) => [row.key, sha(row.encrypted_value)]));
  }
  async function auditRows() {
    return db.select().from(schema.auditEvents);
  }
  async function settle(promise: Promise<unknown>) {
    return promise.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
  }

  async function expectG1(initialize: () => Promise<unknown>) {
    const before = await storedHashes();
    const outcome = await settle(initialize());
    expect(outcome.kind).toBe('rejected');
    const error = (outcome as { error: SecretUnreadableError }).error;
    expect(error).toBeInstanceOf(SecretUnreadableError);
    expect([...error.secretKeys].sort()).toEqual([...NAMES].sort());
    expect(await storedHashes()).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  }

  it('G1 refuses at initialize and leaves every stored value identical', async () => {
    await seedUnreadable();
    await expectG1(() => new SecretsService().initialize(db));
  });

  it('G1 self-check: the same assertions hold for a hand-built correct double', async () => {
    await seedUnreadable();
    await expectG1(async () => {
      const rows = await db.$client<
        { key: string; encrypted_value: string }[]
      >`select key, encrypted_value from system_secrets`;
      const unreadable = rows.filter((row) => tryDecrypt(row.encrypted_value, keyB) === null);
      if (unreadable.length > 0)
        throw new SecretUnreadableError(
          'unreadable',
          unreadable.map((row) => row.key),
        );
    });
  });

  it('G1 refuses a later read on an initialized service and leaves the row identical', async () => {
    const svc = new SecretsService();
    await svc.initialize(db);
    await seedUnreadable();
    const before = await storedHashes();
    const outcome = await settle(svc.getMasterKek());
    expect(outcome.kind).toBe('rejected');
    expect((outcome as { error: unknown }).error).toBeInstanceOf(SecretUnreadableError);
    expect(await storedHashes()).toEqual(before);
  });

  it('G2 with the override discards in one audited transaction and keeps user rows', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    await seedUnreadable();
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: encryptEmail('lost@example.test', keyA),
        emailBlindIndex: '0'.repeat(64),
        passwordHash: 'fixture',
      })
      .returning({ id: schema.users.id });
    await db
      .insert(schema.userSecrets)
      .values({ userId: user!.id, keyName: 'token', ...envelopeEncrypt('retained', keyA) });
    const userRows = async () =>
      JSON.stringify([
        await db.$client`select id, email_encrypted, password_hash from users order by id`,
        await db.$client`select id, user_id, key_name, encrypted_value from user_secrets order by id`,
      ]);
    const userBefore = sha(await userRows());

    const svc = new SecretsService();
    await svc.initialize(db);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: NIL_UUID,
      action: 'config.discard_unreadable_secrets',
      targetType: 'system',
      metadata: { discardedSystemSecretCount: 3, keyPresent: true },
    });
    expect(await storedHashes()).toEqual({});
    expect(sha(await userRows())).toBe(userBefore);

    const generated = await svc.getMasterKek();
    const [row] = await db.$client<
      { encrypted_value: string }[]
    >`select encrypted_value from system_secrets where key = 'master_kek'`;
    expect(decrypt(row!.encrypted_value, keyB)).toBe(generated);
  });

  it('G3 two concurrent initializers with the override write one audit', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    await seedUnreadable();
    await Promise.all([new SecretsService().initialize(db), new SecretsService().initialize(db)]);
    expect(await auditRows()).toHaveLength(1);
    expect(await storedHashes()).toEqual({});
  });

  it('G4 a readable secret written while the discard is open survives', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    await seedUnreadable();
    // The trigger parks the audit insert on an advisory lock this test holds, so the discard
    // transaction is demonstrably open while the peer writes.
    await db.$client.unsafe(`
      create function audit_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_lock(${AUDIT_STALL_LOCK}); perform pg_advisory_unlock(${AUDIT_STALL_LOCK}); return new; end $$;
      create trigger audit_gate before insert on audit_events
        for each row execute function audit_gate();
    `);
    const holder = await db.$client.reserve();
    const waiting = async (condition: string) => {
      const [row] = await monitorDb.$client.unsafe(
        `select count(*)::int as n from pg_stat_activity
         where datname = current_database() and pid <> pg_backend_pid() and ${condition}`,
      );
      return Number(row!.n) > 0;
    };
    // A bounded loop of database round trips: it ends on a stable state, never on elapsed time.
    const until = async (done: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 20_000; attempt += 1) {
        if (await done()) return true;
      }
      return false;
    };
    const readable = encrypt(randomBytes(16).toString('hex'), keyB);
    let initFinished = false;
    let peerFinished = false;
    let init: Promise<unknown> | null = null;
    let peer: Promise<unknown> | null = null;
    try {
      await holder`select pg_advisory_lock(${AUDIT_STALL_LOCK})`;
      init = settle(new SecretsService().initialize(db)).then(() => {
        initFinished = true;
      });
      const reachedAudit = await until(
        async () => initFinished || (await waiting(`wait_event = 'advisory'`)),
      );
      expect(reachedAudit && !initFinished).toBe(true);
      peer = settle(
        Promise.resolve(
          peerDb
            .insert(schema.systemSecrets)
            .values({ key: 'global_kb_connection_string', encryptedValue: readable }),
        ),
      ).then(() => {
        peerFinished = true;
      });
      // Either the insert finished (no table lock in the design) or it queued behind the
      // discard (a table lock). Both are stable; the survival assertion below holds for both.
      const peerSettled = await until(
        async () =>
          peerFinished ||
          (await waiting(
            `wait_event_type = 'Lock' and wait_event = 'relation' and query ilike 'insert into "system_secrets"%'`,
          )),
      );
      expect(peerSettled).toBe(true);
    } finally {
      await holder`select pg_advisory_unlock(${AUDIT_STALL_LOCK})`;
      holder.release();
      await Promise.all([init, peer]);
    }
    expect(await auditRows()).toHaveLength(1);
    const [survivor] = await db.$client<
      { encrypted_value: string }[]
    >`select encrypted_value from system_secrets where key = 'global_kb_connection_string'`;
    expect(survivor && sha(survivor.encrypted_value)).toBe(sha(readable));
  });

  it('G5 a refused audit insert rolls the discard back', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    await seedUnreadable();
    const before = await storedHashes();
    await db.$client.unsafe(`
      create function audit_gate() returns trigger language plpgsql as $$
      begin raise exception 'refuse audit'; end $$;
      create trigger audit_gate before insert on audit_events
        for each row execute function audit_gate();
    `);
    await expect(new SecretsService().initialize(db)).rejects.toThrow();
    expect(await storedHashes()).toEqual(before);
  });

  it('G6 an empty table generates once and a second service reads it back', async () => {
    const first = new SecretsService();
    await first.initialize(db);
    const generated = await first.getMasterKek();
    expect(Object.keys(await storedHashes())).toEqual(['master_kek']);
    const second = new SecretsService();
    await second.initialize(db);
    expect(await second.getMasterKek()).toBe(generated);
    expect(await auditRows()).toHaveLength(0);
  });
});
