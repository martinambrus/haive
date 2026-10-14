import { and, eq } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { secretsService } from '../config/secrets.service.js';
import { envelopeDecrypt } from '../crypto/index.js';
import type { OauthClientCredentials } from './oauth.js';

export type OauthClientMethod = 'oauth2' | 'device';
export type OauthClientSource = 'env' | 'user' | 'admin';

export interface ResolvedOauthClient extends OauthClientCredentials {
  source: OauthClientSource;
}

/** The providers whose client can also come from the environment or from the user's own secrets. */
const OWN_CLIENT_SOURCES = new Map([
  [
    'github',
    {
      idEnv: 'GITHUB_OAUTH_CLIENT_ID',
      secretEnv: 'GITHUB_OAUTH_CLIENT_SECRET',
      userSecretKey: 'github_client_id',
    },
  ],
]);

type Handle = Database | DbTx;

async function userClient(
  db: Handle,
  kek: string,
  userId: string,
  secretKey: string,
): Promise<ResolvedOauthClient | null> {
  const [row] = await db
    .select({
      encryptedValue: schema.userSecrets.encryptedValue,
      encryptedDek: schema.userSecrets.encryptedDek,
    })
    .from(schema.userSecrets)
    .where(and(eq(schema.userSecrets.userId, userId), eq(schema.userSecrets.keyName, secretKey)));
  const clientId = row ? envelopeDecrypt(row, kek).trim() : '';
  return clientId ? { clientId, clientSecret: null, source: 'user' } : null;
}

async function adminClient(
  db: Handle,
  kek: string,
  providerId: string,
): Promise<ResolvedOauthClient | null> {
  const [row] = await db
    .select()
    .from(schema.integrationProviderConfigs)
    .where(eq(schema.integrationProviderConfigs.providerId, providerId));
  const clientId = row?.oauthClientId?.trim();
  if (!row || !clientId) return null;
  const secret =
    row.oauthClientSecretEncrypted && row.encryptedDek
      ? envelopeDecrypt(
          { encryptedValue: row.oauthClientSecretEncrypted, encryptedDek: row.encryptedDek },
          kek,
        )
      : null;
  return { clientId, clientSecret: secret || null, source: 'admin' };
}

/**
 * The environment's client, then the user's own, then the admin's row; each whole, and a source
 * that cannot serve the method is skipped (a code flow needs a secret). `kek` spares a pool lookup.
 */
export async function resolveOauthClient(
  db: Handle,
  providerId: string,
  userId: string,
  method: OauthClientMethod,
  kek?: string,
): Promise<ResolvedOauthClient | null> {
  const key = kek ?? (await secretsService.getMasterKek());
  const own = OWN_CLIENT_SOURCES.get(providerId);
  const sources: Array<() => Promise<ResolvedOauthClient | null>> = [];
  if (own) {
    sources.push(
      async () => {
        const clientId = process.env[own.idEnv]?.trim();
        return clientId
          ? {
              clientId,
              clientSecret: process.env[own.secretEnv]?.trim() || null,
              source: 'env',
            }
          : null;
      },
      () => userClient(db, key, userId, own.userSecretKey),
    );
  }
  sources.push(() => adminClient(db, key, providerId));
  for (const source of sources) {
    const client = await source();
    if (client && (method === 'device' || client.clientSecret !== null)) return client;
  }
  return null;
}
