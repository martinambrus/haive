import { eq, and } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { decrypt, decryptDek, secretsService } from '@haive/shared';

export interface DecryptedCredentials {
  username: string;
  secret: string;
  host: string;
}

export async function getDecryptedCredentials(
  db: Database,
  credentialsId: string,
  userId: string,
): Promise<DecryptedCredentials> {
  const row = await db.query.repoCredentials.findFirst({
    where: and(
      eq(schema.repoCredentials.id, credentialsId),
      eq(schema.repoCredentials.userId, userId),
    ),
  });
  if (!row) throw new Error('Credentials not found');
  const masterKek = await secretsService.getMasterKek();
  const dekHex = decryptDek(row.encryptedDek, masterKek);
  return {
    username: decrypt(row.usernameEncrypted, dekHex),
    secret: decrypt(row.secretEncrypted, dekHex),
    host: row.host,
  };
}
