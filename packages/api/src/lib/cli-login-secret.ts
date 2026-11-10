import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, tryCliAuthLock, type Database } from '@haive/database';
import { secretsService, upsertProviderSecret } from '@haive/shared';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from './audit.js';

/** Keep the captured credential, legacy-env cleanup and security trail together. */
export async function saveCliLoginSecret(
  db: Database,
  userId: string,
  providerId: string,
  token: string,
  assertActive: () => void = () => {},
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
      return await saveCliLoginSecret(db, userId, providerId, token, assertActive, true);
    } finally {
      await release();
    }
  }
  const masterKek = await secretsService.getMasterKek();
  const event: AuditEvent = {
    actorUserId: userId,
    action: 'cli_provider.secret.set',
    targetType: 'cli_provider',
    targetId: providerId,
    metadata: { source: 'login', secretName: 'CLAUDE_CODE_OAUTH_TOKEN' },
  };
  assertActive();
  await db.transaction(async (tx) => {
    // Provider before secret, matching the environment editor's write order. The lock also
    // keeps the legacy cleanup from replacing environment edits made after its read.
    const [existing] = await tx
      .select({ envVars: schema.cliProviders.envVars })
      .from(schema.cliProviders)
      .where(and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)))
      .for('update');
    assertActive();
    if (!existing) throw new Error('Provider not found');
    await insertAuditEvent(tx, event);
    assertActive();
    await upsertProviderSecret(tx, {
      providerId,
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: token,
      masterKek,
      onExisting: 'overwrite',
    });
    assertActive();
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...rest } = existing.envVars ?? {};
    await tx
      .update(schema.cliProviders)
      .set({
        ...(existing.envVars && 'CLAUDE_CODE_OAUTH_TOKEN' in existing.envVars
          ? { envVars: rest }
          : {}),
        authGeneration: randomUUID(),
        authStatus: 'ok',
        authMessage: 'authenticated',
        authLastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, providerId));
    // A close while a write was awaiting rolls back the token, health and audit together.
    assertActive();
  });
  logAuditEvent(event);
}
