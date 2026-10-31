import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import {
  decryptDek,
  encrypt,
  encryptDek,
  forgeProviderSchema,
  generateDek,
  secretsService,
} from '@haive/shared';
import { credentialForgeProvider } from '@haive/shared/forge';
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
import { insertAuditEvent, logAuditEvent, type AuditEvent } from './audit.js';
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
type CredentialRow = typeof schema.repoCredentials.$inferSelect;

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
    refreshRefusedAt: row.refreshRefusedAt,
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

/**
 * The Git credential a forge sign-in leaves behind: the one the connection points at, else one an
 * earlier sign-in of this account made that backs no connection now (a disconnect keeps it), else a
 * new one. An existing credential is written only while it is still on the sign-in's host and still
 * that provider's forge; one that moved stays as it is, and one typed by hand (no sign-in account)
 * is never taken.
 */
async function writeCredential(
  tx: DbTx,
  args: {
    userId: string;
    spec: IntegrationProviderSpec;
    method: Oauth2Method | DeviceMethod;
    identity: { externalAccountId: string; accountLabel: string };
    accessToken: string;
    linkedCredentialId: string | null;
    kek: string;
  },
): Promise<{ id: string; label: string; host: string }> {
  const { identity } = args;
  const host = endpointHost(args.method);
  const own = (row: CredentialRow) =>
    row.host.toLowerCase() === host &&
    credentialForgeProvider(row.provider, row.host) === args.spec.id;
  // A credential stored under a replaced key cannot be written; the sign-in makes its own.
  const readable = (row: CredentialRow) => {
    try {
      decryptDek(row.encryptedDek, args.kek);
      return true;
    } catch {
      return false;
    }
  };
  const refresh = async (row: CredentialRow) => {
    const dek = decryptDek(row.encryptedDek, args.kek);
    await tx
      .update(schema.repoCredentials)
      .set({
        secretEncrypted: encrypt(args.accessToken, dek),
        signInAccountId: identity.externalAccountId,
        updatedAt: new Date(),
      })
      .where(eq(schema.repoCredentials.id, row.id));
    return { id: row.id, label: row.label, host: row.host };
  };

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
    if (linked && own(linked)) return refresh(linked);
  }

  // Locked before checked: a connection cannot start pointing at a locked credential, so what the
  // backing check finds holds until this transaction ends.
  const earlier = await tx
    .select()
    .from(schema.repoCredentials)
    .where(
      and(
        eq(schema.repoCredentials.userId, args.userId),
        eq(schema.repoCredentials.host, host),
        eq(schema.repoCredentials.signInAccountId, identity.externalAccountId),
      ),
    )
    .orderBy(asc(schema.repoCredentials.createdAt), asc(schema.repoCredentials.id))
    .for('update');
  for (const candidate of earlier) {
    if (!own(candidate)) continue;
    const [backed] = await tx
      .select({ id: schema.integrationConnections.id })
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.repoCredentialId, candidate.id));
    if (!backed && readable(candidate)) return refresh(candidate);
  }

  const dek = generateDek();
  const forge = forgeProviderSchema.safeParse(args.spec.id);
  const [created] = await tx
    .insert(schema.repoCredentials)
    .values({
      userId: args.userId,
      label: `${args.spec.displayName} OAuth (${identity.accountLabel})`.slice(
        0,
        CREDENTIAL_LABEL_MAX_LENGTH,
      ),
      host,
      provider: forge.success ? forge.data : null,
      usernameEncrypted: encrypt(identity.accountLabel, dek),
      secretEncrypted: encrypt(args.accessToken, dek),
      encryptedDek: encryptDek(dek, args.kek),
      signInAccountId: identity.externalAccountId,
    })
    .returning({
      id: schema.repoCredentials.id,
      label: schema.repoCredentials.label,
      host: schema.repoCredentials.host,
    });
  return created!;
}

/** Unreadable tokens (a replaced key) count as none, so a reconnect can still heal the row. */
function storedRefreshToken(
  row: ConnectionRow | undefined,
  method: Oauth2Method | DeviceMethod,
  client: ResolvedOauthClient,
  kek: string,
): string | null {
  if (!row?.refreshTokenEncrypted) return null;
  // A refresh uses the row's method and client, so a grant from another issuer would fail there.
  if (row.authMethod !== method.kind || row.oauthClientId !== client.clientId) return null;
  try {
    return decryptConnectionTokens(row, kek).refreshToken;
  } catch {
    return null;
  }
}

/**
 * Turns tokens a provider just issued into a connection: the account is looked up, then ONE
 * transaction writes the Git credential (a forge) and the connection, or updates the connection in
 * place when this account is already connected. The connection ends up on its own credential while
 * that stays on the sign-in's host and forge, else on the one an earlier sign-in of this account
 * left behind, else on a new one (`writeCredential`). A forge's Git credential holds the only copy
 * of the token, and nothing refreshes it, so a response that expires is refused before anything is
 * written.
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
          identity,
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
      refreshRefusedAt: null,
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
                refreshToken:
                  tokens.refreshToken ?? storedRefreshToken(existing, method, client, kek),
              },
              kek,
            ),
          }),
    };

    const record = async (row: ConnectionRow, created: boolean) => {
      const event: AuditEvent = {
        actorUserId: userId,
        action: created ? 'integration.connection.create' : 'integration.connection.reconnect',
        targetType: 'integration_connection',
        targetId: row.id,
        metadata: {
          providerId: spec.id,
          authMethod: method.kind,
          clientSource: client.source,
          credentialBacked: credential !== null,
          ...(credential ? { repoCredentialId: credential.id } : {}),
        },
      };
      await insertAuditEvent(tx, event);
      return { row, created, credential, event };
    };

    if (existing) {
      const [row] = await tx
        .update(schema.integrationConnections)
        .set(columns)
        .where(eq(schema.integrationConnections.id, existing.id))
        .returning();
      return record(row!, false);
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
    return record(row!, true);
  });

  logAuditEvent(written.event);
  return { connection: toConnectionSummary(written.row), credential: written.credential };
}
