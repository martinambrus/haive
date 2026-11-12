import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '../logger/index.js';

/** No expiry: an interrupted discard resumes with the same key and audit id. */
export const PENDING_ENCRYPTION_KEY = 'bootstrap:pendingEncryptionKey';
const DISCARD_SETTING = 'HAIVE_DISCARD_UNREADABLE_SECRETS';

/** Count rows, not individual fields. Nullable integration rows may contain no secret at all.
 * Include wrapped DEKs even without their payload: those are still encrypted key material.
 * User email/phone use the config key directly; the other envelopes depend on master_kek,
 * which is itself a system secret encrypted with the config key. */
async function encryptedRowCounts(db: Pick<Database, 'execute'>): Promise<Record<string, number>> {
  const rows = await db.execute<{ source: string; count: string }>(sql`
    select 'system_secrets' as source, count(*) as count from ${schema.systemSecrets}
    union all select 'users', count(*) from ${schema.users}
    union all select 'user_secrets', count(*) from ${schema.userSecrets}
    union all select 'cli_provider_secrets', count(*) from ${schema.cliProviderSecrets}
    union all select 'repo_credentials', count(*) from ${schema.repoCredentials}
    union all select 'integration_provider_configs', count(*) from ${schema.integrationProviderConfigs}
      where ${schema.integrationProviderConfigs.oauthClientSecretEncrypted} is not null
         or ${schema.integrationProviderConfigs.encryptedDek} is not null
    union all select 'integration_connections', count(*) from ${schema.integrationConnections}
      where ${schema.integrationConnections.accessTokenEncrypted} is not null
         or ${schema.integrationConnections.refreshTokenEncrypted} is not null
         or ${schema.integrationConnections.encryptedDek} is not null
  `);
  return Object.fromEntries(rows.map((row) => [row.source, Number(row.count)]));
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
  db: Database | undefined,
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
  const audited = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.auditEvents)
      .values({
        id: auditId,
        actorUserId: '00000000-0000-0000-0000-000000000000',
        action: 'config.discard_unreadable_secrets',
        targetType: 'system',
        metadata: {
          unreadableSecretCount,
          discardedSystemSecretCount: counts.system_secrets ?? 0,
          counts,
        },
        createdAt: sql`clock_timestamp()`,
      })
      .onConflictDoNothing({ target: schema.auditEvents.id })
      .returning({ id: schema.auditEvents.id });
    if (inserted.length === 0) return false;
    await tx.delete(schema.systemSecrets);
    return true;
  });
  if (audited) {
    logger.warn(
      { unreadableSecretCount, discardedSystemSecretCount: counts.system_secrets ?? 0, counts },
      'Discarding unreadable secrets: cleared system secrets; retained encrypted user fields and envelopes will fail their existing decryption checks',
    );
  }
  await store.publishPending(pending);
}
