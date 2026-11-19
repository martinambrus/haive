import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { envelopeDecrypt, secretsService } from '@haive/shared';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';

// Read by name by the worker only, never part of a container environment.
// resolveProviderSecrets skips these; readProviderSecret reads them.
export const WORKER_ONLY_SECRET_NAMES: ReadonlySet<string> = new Set([CLAUDE_USAGE_OAUTH_SECRET]);

/** The resolver for every env builder. */
export async function resolveProviderSecrets(
  db: Database,
  providerId: string,
): Promise<Record<string, string>> {
  const rows = await db.query.cliProviderSecrets.findMany({
    where: eq(schema.cliProviderSecrets.providerId, providerId),
  });
  if (rows.length === 0) return {};
  const masterKek = await secretsService.getMasterKek();
  const resolved: Record<string, string> = {};
  for (const row of rows) {
    if (WORKER_ONLY_SECRET_NAMES.has(row.secretName)) continue;
    resolved[row.secretName] = envelopeDecrypt(
      { encryptedValue: row.encryptedValue, encryptedDek: row.encryptedDek },
      masterKek,
    );
  }
  return resolved;
}

/** By-name reader for code inside the worker. Includes worker-only names; the result must
 *  never be merged into an env. */
export async function readProviderSecret(
  db: Database,
  providerId: string,
  secretName: string,
): Promise<string | null> {
  const row = await db.query.cliProviderSecrets.findFirst({
    where: and(
      eq(schema.cliProviderSecrets.providerId, providerId),
      eq(schema.cliProviderSecrets.secretName, secretName),
    ),
  });
  if (!row) return null;
  const masterKek = await secretsService.getMasterKek();
  return envelopeDecrypt(
    { encryptedValue: row.encryptedValue, encryptedDek: row.encryptedDek },
    masterKek,
  );
}
