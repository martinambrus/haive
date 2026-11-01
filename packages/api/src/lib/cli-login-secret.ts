import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { secretsService, upsertProviderSecret } from '@haive/shared';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from './audit.js';

/** Keep the captured credential, legacy-env cleanup and security trail together. */
export async function saveCliLoginSecret(
  db: Database,
  userId: string,
  providerId: string,
  token: string,
): Promise<void> {
  const masterKek = await secretsService.getMasterKek();
  const event: AuditEvent = {
    actorUserId: userId,
    action: 'cli_provider.secret.set',
    targetType: 'cli_provider',
    targetId: providerId,
    metadata: { source: 'login', secretName: 'CLAUDE_CODE_OAUTH_TOKEN' },
  };
  await db.transaction(async (tx) => {
    // Provider before secret, matching the environment editor's write order. The lock also
    // keeps the legacy cleanup from replacing environment edits made after its read.
    const [existing] = await tx
      .select({ envVars: schema.cliProviders.envVars })
      .from(schema.cliProviders)
      .where(eq(schema.cliProviders.id, providerId))
      .for('update');
    await insertAuditEvent(tx, event);
    await upsertProviderSecret(tx, {
      providerId,
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: token,
      masterKek,
      onExisting: 'overwrite',
    });
    if (existing?.envVars && 'CLAUDE_CODE_OAUTH_TOKEN' in existing.envVars) {
      const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...rest } = existing.envVars;
      await tx
        .update(schema.cliProviders)
        .set({ envVars: rest, updatedAt: new Date() })
        .where(eq(schema.cliProviders.id, providerId));
    }
  });
  logAuditEvent(event);
}
