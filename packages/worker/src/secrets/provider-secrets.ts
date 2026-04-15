import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { envelopeDecrypt, secretsService } from '@haive/shared';

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
    resolved[row.secretName] = envelopeDecrypt(
      { encryptedValue: row.encryptedValue, encryptedDek: row.encryptedDek },
      masterKek,
    );
  }
  return resolved;
}
