import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import {
  computeKeyFingerprint,
  envelopeDecrypt,
  envelopeEncrypt,
  lockLoginSet,
  secretsService,
} from '@haive/shared';
import { cliAuthSetWhere, type CliAuthProvider } from '@haive/shared/cli-auth-state';
import { CLAUDE_USAGE_OAUTH_SECRET, type ClaudeOauthTokens } from '@haive/shared/claude-oauth';
import { insertAuditEvent, type AuditEvent } from '../audit.js';

// Lock order for everything here: the advisory lock (cliAuthScope) is taken by the caller, then
// the transaction's FIRST lock is lockLoginSet (provider rows, id order), then secret and
// snapshot writes. The image job locks provider rows in id order without the advisory lock.

/** The one member whose copy of the usage grant the set polls with. */
export interface GrantHolder {
  providerId: string;
  /** The identity of a copy: copies carry the same ciphertext. Never the fingerprint. */
  encryptedValue: string;
  encryptedDek: string;
  grant: ClaudeOauthTokens;
}

type Tx = Pick<Database, 'select' | 'update' | 'insert'>;

/** Holder: a member with an ok snapshot first, newest fetch first; then one whose snapshot is
 *  error; then one with no snapshot; then needs_reconnect. Within a tier (after the fetch time in
 *  the first): the newest secret, then the smallest id. Only the holder's grant is decrypted. Null when no member holds a usable grant. */
export async function pickGrantHolder(
  db: Pick<Database, 'select'>,
  rep: CliAuthProvider,
): Promise<GrantHolder | null> {
  const [row] = await db
    .select({
      providerId: schema.cliProviderSecrets.providerId,
      encryptedValue: schema.cliProviderSecrets.encryptedValue,
      encryptedDek: schema.cliProviderSecrets.encryptedDek,
    })
    .from(schema.cliProviderSecrets)
    .innerJoin(
      schema.cliProviders,
      eq(schema.cliProviders.id, schema.cliProviderSecrets.providerId),
    )
    .leftJoin(
      schema.usageWindowSnapshots,
      eq(schema.usageWindowSnapshots.providerId, schema.cliProviderSecrets.providerId),
    )
    .where(
      and(
        eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET),
        cliAuthSetWhere(rep),
      ),
    )
    .orderBy(
      sql`case when ${schema.usageWindowSnapshots.status} = 'ok' then 0 when ${schema.usageWindowSnapshots.status} = 'error' then 1 when ${schema.usageWindowSnapshots.status} is null then 2 else 3 end`,
      sql`case when ${schema.usageWindowSnapshots.status} = 'ok' then ${schema.usageWindowSnapshots.fetchedAt} end desc nulls last`,
      desc(schema.cliProviderSecrets.updatedAt),
      asc(schema.cliProviderSecrets.providerId),
    )
    .limit(1);
  if (!row) return null;
  let grant: ClaudeOauthTokens;
  try {
    grant = JSON.parse(
      envelopeDecrypt(
        { encryptedValue: row.encryptedValue, encryptedDek: row.encryptedDek },
        await secretsService.getMasterKek(),
      ),
    ) as ClaudeOauthTokens;
  } catch {
    return null;
  }
  if (!grant || typeof grant.accessToken !== 'string' || !grant.accessToken) return null;
  return { ...row, grant };
}

/** Stores a rotated grant as ONE new encryption on every member that holds the holder's
 *  pre-refresh copy. Hold the advisory lock across the refresh and this write. */
export async function rotateGrantCopies(
  db: Database,
  rep: CliAuthProvider,
  holder: GrantHolder,
  fresh: ClaudeOauthTokens,
  assertHeld: () => Promise<void>,
): Promise<GrantHolder> {
  const value = JSON.stringify(fresh);
  const env = envelopeEncrypt(value, await secretsService.getMasterKek());
  const now = new Date();
  await db.transaction(async (tx) => {
    await assertHeld();
    const ids = (await lockLoginSet(tx, rep)).map((m) => m.id);
    await tx
      .update(schema.cliProviderSecrets)
      .set({
        encryptedValue: env.encryptedValue,
        encryptedDek: env.encryptedDek,
        fingerprint: computeKeyFingerprint(value),
        updatedAt: now,
      })
      .where(
        and(
          inArray(schema.cliProviderSecrets.providerId, ids),
          eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET),
          eq(schema.cliProviderSecrets.encryptedValue, holder.encryptedValue),
        ),
      );
    await assertHeld();
  });
  return { providerId: holder.providerId, ...env, grant: fresh };
}

/** Runs inside the write transaction, after lockLoginSet returned `memberIds`. Returns the
 *  audit events to log after the commit, or null when the holder no longer holds the exact copy
 *  the fetch used. Converges every differing copy onto the holder's when the fetch proved it live. */
export async function convergeSetCopies(
  tx: Tx,
  rep: CliAuthProvider,
  holder: GrantHolder,
  memberIds: string[],
  converge: boolean,
): Promise<{ events: AuditEvent[]; copyIds: string[] } | null> {
  const secretName = eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET);
  const [current] = await tx
    .select({ encryptedValue: schema.cliProviderSecrets.encryptedValue })
    .from(schema.cliProviderSecrets)
    .where(
      and(
        eq(schema.cliProviderSecrets.providerId, holder.providerId),
        inArray(schema.cliProviderSecrets.providerId, memberIds),
        secretName,
      ),
    );
  if (current?.encryptedValue !== holder.encryptedValue) return null;

  const events: AuditEvent[] = [];
  if (converge) {
    const source = alias(schema.cliProviderSecrets, 'holder_copy');
    const written = await tx
      .update(schema.cliProviderSecrets)
      .set({
        encryptedValue: sql`${source.encryptedValue}`,
        encryptedDek: sql`${source.encryptedDek}`,
        fingerprint: sql`${source.fingerprint}`,
        updatedAt: sql`${source.updatedAt}`,
      })
      .from(source)
      .where(
        and(
          eq(source.providerId, holder.providerId),
          eq(source.secretName, CLAUDE_USAGE_OAUTH_SECRET),
          secretName,
          inArray(schema.cliProviderSecrets.providerId, memberIds),
          ne(schema.cliProviderSecrets.encryptedValue, source.encryptedValue),
        ),
      )
      .returning({ providerId: schema.cliProviderSecrets.providerId });
    for (const { providerId } of written) {
      const event: AuditEvent = {
        actorUserId: rep.userId,
        action: 'cli_provider.secret.set',
        targetType: 'cli_provider',
        targetId: providerId,
        metadata: {
          source: 'usage-poll',
          actorKind: 'system',
          secretName: CLAUDE_USAGE_OAUTH_SECRET,
          viaProviderId: holder.providerId,
          setSize: memberIds.length,
        },
      };
      await insertAuditEvent(tx, event);
      events.push(event);
    }
  }
  const copies = await tx
    .select({ providerId: schema.cliProviderSecrets.providerId })
    .from(schema.cliProviderSecrets)
    .where(
      and(
        inArray(schema.cliProviderSecrets.providerId, memberIds),
        secretName,
        eq(schema.cliProviderSecrets.encryptedValue, holder.encryptedValue),
      ),
    );
  return { events, copyIds: copies.map((c) => c.providerId) };
}
