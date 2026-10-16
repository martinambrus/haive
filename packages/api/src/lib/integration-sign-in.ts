import { and, eq, sql } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import {
  decryptDek,
  encrypt,
  encryptDek,
  forgeProviderSchema,
  generateDek,
  secretsService,
} from '@haive/shared';
import {
  decryptConnectionTokens,
  encryptConnectionTokens,
  fetchUserInfo,
  type ResolvedOauthClient,
  type TokenSet,
} from '@haive/shared/integrations';
import type { IntegrationProviderSpec } from '@haive/shared/modularity';
import { HttpError } from '../context.js';
import type { Database } from '../db.js';
import { recordAuditEvent } from './audit.js';
import {
  endpointHost,
  isForgeProvider,
  viaVendor,
  type DeviceMethod,
  type Oauth2Method,
} from './integration-provider.js';

export const EXPIRING_TOKENS_MESSAGE =
  'This OAuth client issues expiring tokens; use an OAuth App with token expiration turned off, because a Git credential cannot refresh a token.';

const CREDENTIAL_LABEL_MAX_LENGTH = 255;

export type ConnectionRow = typeof schema.integrationConnections.$inferSelect;

/** What a connection looks like to the browser: the token columns never leave the server. */
export function toConnectionSummary(row: ConnectionRow) {
  return {
    id: row.id,
    providerId: row.providerId,
    accountLabel: row.accountLabel,
    authMethod: row.authMethod,
    grantedScopes: row.grantedScopes,
    status: row.status,
    lastError: row.lastError,
    repoCredentialId: row.repoCredentialId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface SignInResult {
  connection: ReturnType<typeof toConnectionSummary>;
  credential: { id: string; label: string; host: string } | null;
}

/** The Git credential a forge sign-in leaves behind: refreshed in place when the connection has one. */
async function writeCredential(
  tx: DbTx,
  args: {
    userId: string;
    spec: IntegrationProviderSpec;
    method: Oauth2Method | DeviceMethod;
    accountLabel: string;
    accessToken: string;
    linkedCredentialId: string | null;
    kek: string;
  },
): Promise<{ id: string; label: string; host: string }> {
  if (args.linkedCredentialId !== null) {
    const [linked] = await tx
      .select()
      .from(schema.repoCredentials)
      .where(
        and(
          eq(schema.repoCredentials.id, args.linkedCredentialId),
          eq(schema.repoCredentials.userId, args.userId),
        ),
      )
      .for('update');
    if (linked) {
      const dek = decryptDek(linked.encryptedDek, args.kek);
      await tx
        .update(schema.repoCredentials)
        .set({ secretEncrypted: encrypt(args.accessToken, dek), updatedAt: new Date() })
        .where(eq(schema.repoCredentials.id, linked.id));
      return { id: linked.id, label: linked.label, host: linked.host };
    }
  }
  const dek = generateDek();
  const forge = forgeProviderSchema.safeParse(args.spec.id);
  const [created] = await tx
    .insert(schema.repoCredentials)
    .values({
      userId: args.userId,
      label: `${args.spec.displayName} OAuth (${args.accountLabel})`.slice(
        0,
        CREDENTIAL_LABEL_MAX_LENGTH,
      ),
      host: endpointHost(args.method),
      provider: forge.success ? forge.data : null,
      usernameEncrypted: encrypt(args.accountLabel, dek),
      secretEncrypted: encrypt(args.accessToken, dek),
      encryptedDek: encryptDek(dek, args.kek),
    })
    .returning({
      id: schema.repoCredentials.id,
      label: schema.repoCredentials.label,
      host: schema.repoCredentials.host,
    });
  return created!;
}

/** Unreadable tokens (a replaced key) count as none, so a reconnect can still heal the row. */
function storedRefreshToken(row: ConnectionRow | undefined, kek: string): string | null {
  if (!row?.refreshTokenEncrypted) return null;
  try {
    return decryptConnectionTokens(row, kek).refreshToken;
  } catch {
    return null;
  }
}

/**
 * Turns tokens a provider just issued into a connection: the account is looked up, then ONE
 * transaction writes the Git credential (a forge) and the connection, or updates both in place
 * when this account is already connected. A forge's Git credential holds the only copy of the
 * token, and nothing refreshes it, so a response that expires is refused before anything is written.
 */
export async function finishSignIn(input: {
  db: Database;
  userId: string;
  spec: IntegrationProviderSpec;
  method: Oauth2Method | DeviceMethod;
  client: ResolvedOauthClient;
  tokens: TokenSet;
  requestedScopes: string[];
}): Promise<SignInResult> {
  const { db, userId, spec, method, client, tokens } = input;
  const forge = isForgeProvider(spec);
  if (forge && (tokens.refreshToken !== null || tokens.expiresAt !== null)) {
    throw new HttpError(400, EXPIRING_TOKENS_MESSAGE);
  }
  const identity = await viaVendor(() => fetchUserInfo(fetch, method.userInfo, tokens.accessToken));
  const kek = await secretsService.getMasterKek();

  const written = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`integration-account:${userId}:${spec.id}:${identity.externalAccountId}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(schema.integrationConnections)
      .where(
        and(
          eq(schema.integrationConnections.scope, 'user'),
          eq(schema.integrationConnections.ownerUserId, userId),
          eq(schema.integrationConnections.providerId, spec.id),
          eq(schema.integrationConnections.externalAccountId, identity.externalAccountId),
        ),
      )
      .for('update');

    const credential = forge
      ? await writeCredential(tx, {
          userId,
          spec,
          method,
          accountLabel: identity.accountLabel,
          accessToken: tokens.accessToken,
          linkedCredentialId: existing?.repoCredentialId ?? null,
          kek,
        })
      : null;
    const columns = {
      accountLabel: identity.accountLabel,
      authMethod: method.kind,
      grantedScopes: tokens.scopes ?? input.requestedScopes,
      status: 'connected' as const,
      lastError: null,
      oauthClientId: client.clientId,
      updatedAt: new Date(),
      ...(credential
        ? {
            repoCredentialId: credential.id,
            accessTokenEncrypted: null,
            refreshTokenEncrypted: null,
            encryptedDek: null,
            expiresAt: null,
          }
        : {
            repoCredentialId: null,
            expiresAt: tokens.expiresAt,
            ...encryptConnectionTokens(
              {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken ?? storedRefreshToken(existing, kek),
              },
              kek,
            ),
          }),
    };

    if (existing) {
      const [row] = await tx
        .update(schema.integrationConnections)
        .set(columns)
        .where(eq(schema.integrationConnections.id, existing.id))
        .returning();
      return { row: row!, created: false, credential };
    }
    const [row] = await tx
      .insert(schema.integrationConnections)
      .values({
        providerId: spec.id,
        scope: 'user',
        ownerUserId: userId,
        externalAccountId: identity.externalAccountId,
        ...columns,
      })
      .returning();
    return { row: row!, created: true, credential };
  });

  await recordAuditEvent(db, {
    actorUserId: userId,
    action: written.created ? 'integration.connection.create' : 'integration.connection.reconnect',
    targetType: 'integration_connection',
    targetId: written.row.id,
    metadata: {
      providerId: spec.id,
      authMethod: method.kind,
      clientSource: client.source,
      credentialBacked: written.credential !== null,
      ...(written.credential ? { repoCredentialId: written.credential.id } : {}),
    },
  });
  return { connection: toConnectionSummary(written.row), credential: written.credential };
}
