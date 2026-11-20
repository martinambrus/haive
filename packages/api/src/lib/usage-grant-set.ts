import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { computeKeyFingerprint, envelopeEncrypt } from '@haive/shared';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';
import { HttpError } from '../context.js';
import { insertAuditEvent, type AuditEvent } from './audit.js';

/**
 * The usage grant is one OAuth grant per login set. Every member holds a copy with identical
 * ciphertext columns and `updated_at` (the poller converges on equal `encrypted_value`), so a
 * new value is encrypted once and copied, never encrypted per member.
 *
 * Lock order of every caller: the advisory auth lock, then `lockLoginSet` as the transaction's
 * first row lock (after the first `assertHeld`), then secret and snapshot writes, and
 * `assertHeld` again after the last write.
 */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Members = { id: string }[];

export const isUsageGrantSecret = (providerName: string, secretName: string): boolean =>
  providerName === 'claude-code' && secretName === CLAUDE_USAGE_OAUTH_SECRET;

/** The shape the poller reads: {accessToken, refreshToken, expiresAt (ms), scopes}. */
export function isUsageGrantValue(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const g = parsed as Record<string, unknown>;
  return (
    typeof g.accessToken === 'string' &&
    typeof g.refreshToken === 'string' &&
    typeof g.expiresAt === 'number' &&
    Number.isFinite(g.expiresAt) &&
    Array.isArray(g.scopes) &&
    g.scopes.every((s) => typeof s === 'string')
  );
}

const grantEvent = (
  action: 'cli_provider.secret.set' | 'cli_provider.secret.delete',
  userId: string,
  targetId: string,
  metadata: Record<string, unknown>,
): AuditEvent => ({
  actorUserId: userId,
  action,
  targetType: 'cli_provider',
  targetId,
  metadata: { ...metadata, secretName: CLAUDE_USAGE_OAUTH_SECRET },
});

/** The clicked row's event is plain; a sibling's names the clicked row and the size of the set. */
const setWideEvent = (
  action: 'cli_provider.secret.set' | 'cli_provider.secret.delete',
  userId: string,
  source: string,
  viaId: string,
  targetId: string,
  setSize: number,
): AuditEvent =>
  grantEvent(
    action,
    userId,
    targetId,
    targetId === viaId ? { source } : { source, viaProviderId: viaId, setSize },
  );

function assertMember(members: Members, viaId: string): void {
  if (!members.some((m) => m.id === viaId)) {
    throw new HttpError(
      409,
      'CLI authentication settings changed. Reload and try again.',
      'cli_auth_busy',
    );
  }
}

/** Writes one new grant to every row of `members` (locked by the caller with `lockLoginSet`) and
 * gives them all one new generation. */
export async function writeUsageGrantToSet(
  tx: Tx,
  opts: {
    userId: string;
    viaId: string;
    members: Members;
    source: 'usage_oauth' | 'manual';
    value: string;
    masterKek: string;
    assertHeld: () => Promise<void>;
  },
): Promise<{
  events: AuditEvent[];
  secret: {
    id: string;
    secretName: string;
    fingerprint: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
}> {
  const { userId, viaId, members, source, value, masterKek, assertHeld } = opts;
  assertMember(members, viaId);
  const envelope = envelopeEncrypt(value, masterKek);
  const copy = {
    encryptedValue: envelope.encryptedValue,
    encryptedDek: envelope.encryptedDek,
    fingerprint: computeKeyFingerprint(value),
    updatedAt: new Date(),
  };
  const events: AuditEvent[] = [];
  let secret: Awaited<ReturnType<typeof writeUsageGrantToSet>>['secret'] | undefined;
  for (const member of members) {
    const event = setWideEvent(
      'cli_provider.secret.set',
      userId,
      source,
      viaId,
      member.id,
      members.length,
    );
    await insertAuditEvent(tx, event);
    events.push(event);
    await assertHeld();
    const [row] = await tx
      .insert(schema.cliProviderSecrets)
      .values({ providerId: member.id, secretName: CLAUDE_USAGE_OAUTH_SECRET, ...copy })
      .onConflictDoUpdate({
        target: [schema.cliProviderSecrets.providerId, schema.cliProviderSecrets.secretName],
        set: copy,
      })
      .returning({
        id: schema.cliProviderSecrets.id,
        secretName: schema.cliProviderSecrets.secretName,
        fingerprint: schema.cliProviderSecrets.fingerprint,
        createdAt: schema.cliProviderSecrets.createdAt,
        updatedAt: schema.cliProviderSecrets.updatedAt,
      });
    if (member.id === viaId) secret = row;
  }
  // One new generation for the whole set supersedes a sign-out queued through any row.
  await tx
    .update(schema.cliProviders)
    .set({ authGeneration: randomUUID() })
    .where(
      inArray(
        schema.cliProviders.id,
        members.map((m) => m.id),
      ),
    );
  await assertHeld();
  return { events, secret: secret! };
}

/** Removes the grant and the usage snapshot of every row of `members` (locked by the caller); never
 * touches generation or status. Events are for the rows that held a grant. */
export async function deleteUsageGrantFromSet(
  tx: Tx,
  opts: {
    userId: string;
    viaId: string;
    members: Members;
    source: 'usage_oauth' | 'manual';
    assertHeld: () => Promise<void>;
  },
): Promise<AuditEvent[]> {
  const { userId, viaId, members, source, assertHeld } = opts;
  assertMember(members, viaId);
  const ids = members.map((m) => m.id);
  const deleted = await tx
    .delete(schema.cliProviderSecrets)
    .where(
      and(
        inArray(schema.cliProviderSecrets.providerId, ids),
        eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET),
      ),
    )
    .returning({ providerId: schema.cliProviderSecrets.providerId });
  // With no grant the poller never touches a row again, so a stale meter would linger.
  await tx
    .delete(schema.usageWindowSnapshots)
    .where(inArray(schema.usageWindowSnapshots.providerId, ids));
  const held = new Set(deleted.map((d) => d.providerId));
  const events: AuditEvent[] = [];
  for (const id of ids.filter((i) => held.has(i))) {
    const event = setWideEvent('cli_provider.secret.delete', userId, source, viaId, id, ids.length);
    await insertAuditEvent(tx, event);
    events.push(event);
  }
  await assertHeld();
  return events;
}

/** Gives a row that joined a set (a member of `members`, locked by the caller) the copy of the
 * grant of the other member with the newest one. Nothing is written when none holds a grant. */
export async function seedUsageGrantJoiner(
  tx: Tx,
  opts: { userId: string; joinerId: string; members: Members; assertHeld: () => Promise<void> },
): Promise<AuditEvent[]> {
  const { userId, joinerId, members, assertHeld } = opts;
  const others = members.filter((m) => m.id !== joinerId).map((m) => m.id);
  if (others.length === 0) return [];
  const [source] = await tx
    .select({
      providerId: schema.cliProviderSecrets.providerId,
      encryptedValue: schema.cliProviderSecrets.encryptedValue,
      encryptedDek: schema.cliProviderSecrets.encryptedDek,
      fingerprint: schema.cliProviderSecrets.fingerprint,
      // Through text: a Date would cut the stamp to milliseconds.
      updatedAt: sql<string>`${schema.cliProviderSecrets.updatedAt}::text`,
    })
    .from(schema.cliProviderSecrets)
    .where(
      and(
        inArray(schema.cliProviderSecrets.providerId, others),
        eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET),
      ),
    )
    .orderBy(desc(schema.cliProviderSecrets.updatedAt), asc(schema.cliProviderSecrets.providerId))
    .limit(1);
  if (!source) return [];
  const event = grantEvent('cli_provider.secret.set', userId, joinerId, {
    source: 'join',
    viaProviderId: source.providerId,
    setSize: members.length,
  });
  await insertAuditEvent(tx, event);
  await assertHeld();
  const copy = {
    encryptedValue: source.encryptedValue,
    encryptedDek: source.encryptedDek,
    fingerprint: source.fingerprint,
    updatedAt: sql`${source.updatedAt}::timestamp`,
  };
  await tx
    .insert(schema.cliProviderSecrets)
    .values({ providerId: joinerId, secretName: CLAUDE_USAGE_OAUTH_SECRET, ...copy })
    .onConflictDoUpdate({
      target: [schema.cliProviderSecrets.providerId, schema.cliProviderSecrets.secretName],
      set: copy,
    });
  await assertHeld();
  return [event];
}

/** A row that moves to another login scope drops its own grant and usage snapshot, no other row's. */
export async function dropLeaverUsageGrant(
  tx: Tx,
  opts: { userId: string; leaverId: string; assertHeld: () => Promise<void> },
): Promise<AuditEvent[]> {
  const { userId, leaverId, assertHeld } = opts;
  const deleted = await tx
    .delete(schema.cliProviderSecrets)
    .where(
      and(
        eq(schema.cliProviderSecrets.providerId, leaverId),
        eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET),
      ),
    )
    .returning({ id: schema.cliProviderSecrets.id });
  await tx
    .delete(schema.usageWindowSnapshots)
    .where(eq(schema.usageWindowSnapshots.providerId, leaverId));
  const events: AuditEvent[] = [];
  if (deleted.length > 0) {
    const event = grantEvent('cli_provider.secret.delete', userId, leaverId, { source: 'leave' });
    await insertAuditEvent(tx, event);
    events.push(event);
  }
  await assertHeld();
  return events;
}
