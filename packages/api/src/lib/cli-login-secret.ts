import { cliAuthScope, type CliAuthProvider } from '@haive/shared/cli-auth-state';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, tryCliAuthLock, type Database } from '@haive/database';
import { lockLoginSet, secretsService, upsertProviderSecret } from '@haive/shared';
import { configuredProviderSecrets } from './configured-provider-secrets.js';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from './audit.js';

/** Keep the captured credential, legacy-env cleanup and security trail together. */
export async function saveCliLoginSecret(
  db: Database,
  userId: string,
  providerId: string,
  token: string,
  assertActive: () => void | Promise<void> = () => {},
  authLockHeld = false,
): Promise<void> {
  if (!authLockHeld) {
    const provider = await db.query.cliProviders.findFirst({
      where: and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)),
    });
    if (!provider) throw new Error('Provider not found');
    const release = await tryCliAuthLock(db, cliAuthScope(provider));
    if (!release) throw new Error('CLI authentication is busy');
    try {
      return await saveCliLoginSecret(
        db,
        userId,
        providerId,
        token,
        async () => {
          await release.assertHeld();
          await assertActive();
        },
        true,
      );
    } finally {
      await release();
    }
  }
  const masterKek = await secretsService.getMasterKek();
  const events: AuditEvent[] = [];
  await assertActive();
  await db.transaction(async (tx) => {
    const [clicked] = await tx
      .select({
        id: schema.cliProviders.id,
        userId: schema.cliProviders.userId,
        name: schema.cliProviders.name,
        authMode: schema.cliProviders.authMode,
        isolateAuth: schema.cliProviders.isolateAuth,
      })
      .from(schema.cliProviders)
      .where(and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)));
    await assertActive();
    if (!clicked) throw new Error('Provider not found');
    // Provider rows before secrets, matching the environment editor's write order. The lock
    // also keeps the legacy cleanup from replacing environment edits made after its read.
    const members = await lockLoginSet(tx, clicked);
    await assertActive();
    if (!members.some((m) => m.id === providerId)) throw new Error('Provider not found');
    for (const member of members) {
      const event: AuditEvent = {
        actorUserId: userId,
        action: 'cli_provider.secret.set',
        targetType: 'cli_provider',
        targetId: member.id,
        metadata: {
          source: 'login',
          secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
          viaProviderId: providerId,
          setSize: members.length,
        },
      };
      await insertAuditEvent(tx, event);
      events.push(event);
      await assertActive();
      await upsertProviderSecret(tx, {
        providerId: member.id,
        name: 'CLAUDE_CODE_OAUTH_TOKEN',
        value: token,
        masterKek,
        onExisting: 'overwrite',
      });
      await assertActive();
      if (member.envVars && 'CLAUDE_CODE_OAUTH_TOKEN' in member.envVars) {
        const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...rest } = member.envVars;
        await tx
          .update(schema.cliProviders)
          .set({ envVars: rest })
          .where(eq(schema.cliProviders.id, member.id));
      }
    }
    await tx
      .update(schema.cliProviders)
      .set({
        authGeneration: randomUUID(),
        authStatus: 'ok',
        authMessage: 'authenticated',
        // Always advance the check stamp, even when it already sits ahead of the clock.
        authLastCheckedAt: sql`greatest(clock_timestamp()::timestamp, ${schema.cliProviders.authLastCheckedAt} + interval '1 microsecond')`,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          schema.cliProviders.id,
          members.map((m) => m.id),
        ),
      );
    // A close while a write was awaiting rolls back every row's token, health and audit together.
    await assertActive();
  });
  for (const event of events) logAuditEvent(event);
}

export const isSetLoginSecret = (providerName: string, secretName: string): boolean =>
  providerName === 'claude-code' && secretName === 'CLAUDE_CODE_OAUTH_TOKEN';

/** Copies the token to the other rows of `members`, which the caller locked with `lockLoginSet` before
 * writing anything for the request; the caller writes the clicked row's own secret after that lock. */
export async function writeLoginTokenToSet(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  opts: {
    userId: string;
    viaId: string;
    members: { id: string }[];
    source: 'manual' | 'environment';
    value: string;
    masterKek: string;
    assertHeld: () => Promise<void>;
  },
): Promise<AuditEvent[]> {
  const { userId, viaId, members, source, value, masterKek, assertHeld } = opts;
  if (!members.some((m) => m.id === viaId)) throw new Error('Provider not found');
  const events: AuditEvent[] = [];
  for (const member of members) {
    if (member.id === viaId) continue;
    const event: AuditEvent = {
      actorUserId: userId,
      action: 'cli_provider.secret.set',
      targetType: 'cli_provider',
      targetId: member.id,
      metadata: {
        source,
        secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
        viaProviderId: viaId,
        setSize: members.length,
      },
    };
    await insertAuditEvent(tx, event);
    events.push(event);
    await assertHeld();
    await upsertProviderSecret(tx, {
      providerId: member.id,
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      value,
      masterKek,
      onExisting: 'overwrite',
    });
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
  return events;
}

/** Removes the token from every row of the set; never touches generation or status. */
export async function deleteLoginTokenFromSet(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  via: CliAuthProvider,
): Promise<{ deletedIds: string[]; setSize: number }> {
  const members = await lockLoginSet(tx, via);
  const ids = members.map((m) => m.id);
  const deleted = await tx
    .delete(schema.cliProviderSecrets)
    .where(
      and(
        inArray(schema.cliProviderSecrets.providerId, ids),
        eq(schema.cliProviderSecrets.secretName, 'CLAUDE_CODE_OAUTH_TOKEN'),
      ),
    )
    .returning({ providerId: schema.cliProviderSecrets.providerId });
  return { deletedIds: deleted.map((d) => d.providerId), setSize: members.length };
}

/** Gives a row that joined a set the login of the set: the token and credential state of the member
 * that holds the newest token. The caller locked `members` (the joiner included) with `lockLoginSet`
 * before writing anything for the request. Nothing is written when no other member holds a token.
 * `row` is the joiner as it stands after the seed, and absent when nothing was seeded. */
export async function seedJoinerFromSet(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  opts: {
    userId: string;
    joinerId: string;
    members: { id: string }[];
    assertHeld: () => Promise<void>;
    /** The joiner keeps the generation it holds: the request advanced it, and the set's would undo that. */
    keepGeneration?: boolean;
  },
): Promise<{ events: AuditEvent[]; row?: typeof schema.cliProviders.$inferSelect }> {
  const { userId, joinerId, members, assertHeld, keepGeneration } = opts;
  const others = members.filter((m) => m.id !== joinerId).map((m) => m.id);
  if (others.length === 0) return { events: [] };
  const candidates = await tx
    .select({
      providerId: schema.cliProviderSecrets.providerId,
      encryptedValue: schema.cliProviderSecrets.encryptedValue,
      encryptedDek: schema.cliProviderSecrets.encryptedDek,
      fingerprint: schema.cliProviderSecrets.fingerprint,
      authStatus: schema.cliProviders.authStatus,
      authMessage: schema.cliProviders.authMessage,
      // Through text: a Date would cut the stamp to milliseconds.
      authCheckedAt: sql<string | null>`${schema.cliProviders.authLastCheckedAt}::text`,
      authGeneration: schema.cliProviders.authGeneration,
    })
    .from(schema.cliProviderSecrets)
    .innerJoin(
      schema.cliProviders,
      eq(schema.cliProviders.id, schema.cliProviderSecrets.providerId),
    )
    .where(
      and(
        inArray(schema.cliProviderSecrets.providerId, others),
        eq(schema.cliProviderSecrets.secretName, 'CLAUDE_CODE_OAUTH_TOKEN'),
      ),
    )
    .orderBy(desc(schema.cliProviderSecrets.updatedAt), asc(schema.cliProviderSecrets.providerId));
  const [source] = await configuredProviderSecrets(candidates);
  if (!source) return { events: [] };
  const event: AuditEvent = {
    actorUserId: userId,
    action: 'cli_provider.secret.set',
    targetType: 'cli_provider',
    targetId: joinerId,
    metadata: {
      source: 'join',
      secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
      viaProviderId: source.providerId,
      setSize: members.length,
    },
  };
  await insertAuditEvent(tx, event);
  await assertHeld();
  const secret = {
    encryptedValue: source.encryptedValue,
    encryptedDek: source.encryptedDek,
    fingerprint: source.fingerprint,
  };
  await tx
    .insert(schema.cliProviderSecrets)
    .values({ providerId: joinerId, secretName: 'CLAUDE_CODE_OAUTH_TOKEN', ...secret })
    .onConflictDoUpdate({
      target: [schema.cliProviderSecrets.providerId, schema.cliProviderSecrets.secretName],
      set: { ...secret, updatedAt: new Date() },
    });
  const [row] = await tx
    .update(schema.cliProviders)
    .set({
      authStatus: source.authStatus,
      authMessage: source.authMessage,
      authLastCheckedAt: sql`${source.authCheckedAt}::timestamp`,
      ...(keepGeneration ? {} : { authGeneration: source.authGeneration }),
    })
    .where(eq(schema.cliProviders.id, joinerId))
    .returning();
  await assertHeld();
  return { events: [event], row };
}
