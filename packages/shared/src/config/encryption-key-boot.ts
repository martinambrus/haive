import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { schema, type Database, type DbTx } from '@haive/database';
import { tryDecrypt } from '../crypto/index.js';
import { logger } from '../logger/index.js';
import { SecretUnreadableError } from './secret-unreadable.js';

/** Only the inventory and audited-discard operations are needed during configuration boot. */
export type EncryptionKeyBootDatabase = Pick<Database, 'execute' | 'transaction'>;

/** Adapt a dedicated client without owning its pool. Drizzle changes its parsers/serializers,
 * so callers must not share it with raw postgres.js consumers. */
export function encryptionKeyBootDatabase(client: Sql): EncryptionKeyBootDatabase {
  return drizzle(client, { schema });
}

/** The Redis key that holds the install's encryption key; `CONFIG_KEYS.ENCRYPTION_KEY` is this name. */
export const ENCRYPTION_KEY_REDIS_KEY = 'bootstrap:encryptionKey';
/** No expiry: an interrupted discard resumes with the same key and audit id. */
export const PENDING_ENCRYPTION_KEY = 'bootstrap:pendingEncryptionKey';
export const PENDING_ENCRYPTION_KEY_WAIT_MS = 10 * 60 * 1000;
const DISCARD_SETTING = 'HAIVE_DISCARD_UNREADABLE_SECRETS';

/** Count rows, not individual fields. Nullable integration rows may contain no secret at all.
 * Include wrapped DEKs even without their payload: those are still encrypted key material.
 * User email/phone use the config key directly; the other envelopes depend on master_kek,
 * which is itself a system secret encrypted with the config key. */
async function encryptedRowCounts(db: Pick<Database, 'execute'>): Promise<Record<string, number>> {
  // The updater can boot before 0192 creates integration storage. Missing tables hold no
  // ciphertext; every present table must still be inventoried, and a failed read still refuses.
  const [tables] = await db.execute<{ providers: boolean; connections: boolean }>(sql`
    select to_regclass('integration_provider_configs') is not null as providers,
           to_regclass('integration_connections') is not null as connections
  `);
  // Only an explicit absence skips a table; an empty capability result keeps the old inventory.
  const rows = await db.execute<{ source: string; count: string }>(sql`
    select 'system_secrets' as source, count(*) as count from ${schema.systemSecrets}
    union all select 'users', count(*) from ${schema.users}
    union all select 'user_secrets', count(*) from ${schema.userSecrets}
    union all select 'cli_provider_secrets', count(*) from ${schema.cliProviderSecrets}
    union all select 'repo_credentials', count(*) from ${schema.repoCredentials}
    ${
      tables?.providers !== false
        ? sql`union all select 'integration_provider_configs', count(*) from ${schema.integrationProviderConfigs}
      where ${schema.integrationProviderConfigs.oauthClientSecretEncrypted} is not null
         or ${schema.integrationProviderConfigs.encryptedDek} is not null`
        : sql``
    }
    ${
      tables?.connections !== false
        ? sql`union all select 'integration_connections', count(*) from ${schema.integrationConnections}
      where ${schema.integrationConnections.accessTokenEncrypted} is not null
         or ${schema.integrationConnections.refreshTokenEncrypted} is not null
         or ${schema.integrationConnections.encryptedDek} is not null`
        : sql``
    }
  `);
  return Object.fromEntries(rows.map((row) => [row.source, Number(row.count)]));
}

type SystemSecretRow = { key: string; encrypted_value: string };

/** Every `system_secrets` row, read raw so the check never depends on a service's cache. Only an
 * explicit absence of the table skips it (the updater can boot before the schema exists, and a
 * missing table holds no ciphertext); an empty capability result keeps the read. */
async function systemSecretRows(db: Pick<Database, 'execute'>): Promise<SystemSecretRow[]> {
  const [table] = await db.execute<{ present: boolean }>(
    sql`select to_regclass('system_secrets') is not null as present`,
  );
  if (table?.present === false) return [];
  const rows = await db.execute<SystemSecretRow>(sql`
    select ${schema.systemSecrets.key} as key, ${schema.systemSecrets.encryptedValue} as encrypted_value
    from ${schema.systemSecrets}
    order by ${schema.systemSecrets.key}
  `);
  return [...rows];
}

/** The names of the stored rows when the key reads none of them; null for an empty table (a first
 * install) and for a key that reads at least one row. A table with only some unreadable rows is
 * left to the readers, which refuse each of them by name and never regenerate it. `tryDecrypt`
 * answers null for a malformed envelope or a failed GCM tag and still throws for a key that is not
 * 32 bytes, so a misconfigured key is never reported as unreadable data. */
function unreadableTable(rows: SystemSecretRow[], key: string): string[] | null {
  const unreadable = rows
    .filter((row) => tryDecrypt(row.encrypted_value, key) === null)
    .map((row) => row.key);
  return unreadable.length > 0 && unreadable.length === rows.length ? unreadable : null;
}

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

/** The audited discard both paths share. The caller's transaction makes the audit row and the
 * delete atomic; false means this audit id already exists, so the delete is not repeated. */
async function auditAndClearSystemSecrets(
  tx: DbTx,
  id: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  const inserted = await tx
    .insert(schema.auditEvents)
    .values({
      id,
      actorUserId: SYSTEM_ACTOR,
      action: 'config.discard_unreadable_secrets',
      targetType: 'system',
      metadata,
      createdAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing({ target: schema.auditEvents.id })
    .returning({ id: schema.auditEvents.id });
  if (inserted.length === 0) return false;
  await tx.delete(schema.systemSecrets);
  return true;
}

function logDiscard(fields: Record<string, unknown>): void {
  logger.warn(
    fields,
    'Discarding unreadable secrets: cleared system secrets; retained encrypted user fields and envelopes will fail their existing decryption checks',
  );
}

/** The key is present and does not read the stored system secrets. The discard is decided again
 * under a table lock that conflicts with every writer: a peer that already discarded and
 * regenerated is seen by the re-read and its rows are never deleted, and two booting processes
 * record one audit row. */
async function discardUnreadableSystemSecrets(
  db: EncryptionKeyBootDatabase,
  key: string,
): Promise<void> {
  const discarded = await db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${schema.systemSecrets} in share row exclusive mode`);
    const rows = await systemSecretRows(tx);
    if (!unreadableTable(rows, key)) return null;
    const counts = await encryptedRowCounts(tx);
    const fields = {
      unreadableSecretCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
      discardedSystemSecretCount: rows.length,
      counts,
    };
    await auditAndClearSystemSecrets(tx, randomUUID(), { ...fields, keyPresent: true });
    return fields;
  });
  if (discarded) logDiscard(discarded);
}

/** Where the key under test came from; only the refusal text differs. */
const KEY_SOURCES = {
  env: {
    origin: 'CONFIG_ENCRYPTION_KEY',
    restore: 'Restore the original CONFIG_ENCRYPTION_KEY.',
  },
  redis: {
    origin: `The encryption key in Redis (${ENCRYPTION_KEY_REDIS_KEY})`,
    restore: `Restore the original key: CONFIG_ENCRYPTION_KEY only seeds an empty Redis, so remove the different key stored in Redis (${ENCRYPTION_KEY_REDIS_KEY}) first.`,
  },
} as const;

/** A key that is present must read what the database holds before it is seeded or used. One
 * readable row proves the key is this database's; only a table it reads none of means the wrong
 * key. That refuses, and `HAIVE_DISCARD_UNREADABLE_SECRETS=1` is the same audited discard as a boot
 * with no key.
 *
 * A key Redis does not hold yet (the environment key about to seed an empty Redis) passes `settle`:
 * a discard rewrites the install, so that key must be the install's before the first write. It runs
 * after the refusal is ruled out and resolves false when another key holds Redis, which skips the
 * discard: a process whose key lost the race deletes nothing. A key already in Redis needs none. */
export async function assertKeyReadsSystemSecrets(
  db: EncryptionKeyBootDatabase,
  key: string,
  source: keyof typeof KEY_SOURCES,
  settle?: () => Promise<boolean>,
): Promise<void> {
  const unreadable = unreadableTable(await systemSecretRows(db), key);
  if (!unreadable) return;
  if (process.env[DISCARD_SETTING] !== '1') {
    const { origin, restore } = KEY_SOURCES[source];
    throw new SecretUnreadableError(
      `${origin} cannot decrypt any of the ${unreadable.length} stored system secrets (${unreadable.join(', ')}), so it is not the key this database was written with. Nothing was changed. ${restore} Or set ${DISCARD_SETTING}=1 to discard the unreadable system secrets in one audited transaction; every user field and credential that depends on them stays unreadable.`,
      unreadable,
    );
  }
  if (settle && !(await settle())) return;
  await discardUnreadableSystemSecrets(db, key);
}

interface KeyStore {
  getKey(): Promise<string | null>;
  getPending(): Promise<string | null>;
  reservePending(value: string): Promise<void>;
  publishPending(value: string): Promise<boolean>;
}

/** Database work commits BEFORE publishing a usable key. The pending Redis value supplies
 * the idempotency id and candidate across processes/crashes, so an ambiguous Redis reply or
 * failed database COMMIT cannot publish an unaudited replacement or duplicate its audit. */
export async function generateBootEncryptionKey(
  db: EncryptionKeyBootDatabase | undefined,
  store: KeyStore,
  envKeyInvalid = false,
) {
  if (!db) {
    throw new Error(
      'A database connection is required before generating an encryption key; restore CONFIG_ENCRYPTION_KEY or initialize configuration with the database.',
    );
  }
  const counts = await encryptedRowCounts(db);
  const unreadableSecretCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (await store.getKey()) return; // A peer may have booted while the inventory was read.
  const discard = process.env[DISCARD_SETTING] === '1';
  if (unreadableSecretCount > 0 && !discard) {
    throw new Error(
      `Refusing to generate an encryption key: ${unreadableSecretCount} encrypted rows exist but no key was found in Redis and CONFIG_ENCRYPTION_KEY is ${envKeyInvalid ? 'set but invalid (ignored)' : 'unset'}. Restore the original CONFIG_ENCRYPTION_KEY, or set ${DISCARD_SETTING}=1 to discard unreadable secrets.`,
    );
  }
  let pending = await store.getPending();
  if (!pending) {
    await store.reservePending(
      JSON.stringify({
        id: randomUUID(),
        key: randomBytes(32).toString('hex'),
        discard: unreadableSecretCount > 0,
        reservedAt: Date.now(),
      }),
    );
    pending = await store.getPending();
  }
  if (!pending) {
    if (await store.getKey()) return;
    throw new Error('Pending encryption key not found');
  }
  const invalidPendingMessage =
    'Invalid pending encryption key; restore the original CONFIG_ENCRYPTION_KEY';
  let candidate: unknown;
  try {
    candidate = JSON.parse(pending);
  } catch {
    throw new Error(invalidPendingMessage);
  }
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('id' in candidate) ||
    typeof candidate.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate.id) ||
    !('discard' in candidate) ||
    typeof candidate.discard !== 'boolean' ||
    !('key' in candidate) ||
    typeof candidate.key !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.key)
  )
    throw new Error(invalidPendingMessage);

  if (!candidate.discard && unreadableSecretCount === 0) {
    if (await store.publishPending(pending)) {
      logger.warn('Generated new encryption key (CONFIG_ENCRYPTION_KEY not set or invalid)');
    }
    return;
  }
  if (!discard) throw new Error(`Pending secret discard requires ${DISCARD_SETTING}=1`);

  // Retain envelopes and user fields for the readers' existing bad-row failures. Clear system
  // secrets so production boot can recreate master_kek, JWT secret and email pepper rather
  // than immediately failing on them. The audit and this discard are one transaction.
  const auditId = candidate.id;
  const fields = {
    unreadableSecretCount,
    discardedSystemSecretCount: counts.system_secrets ?? 0,
    counts,
  };
  const audited = await db.transaction((tx) => auditAndClearSystemSecrets(tx, auditId, fields));
  if (audited) logDiscard(fields);
  await store.publishPending(pending);
}
