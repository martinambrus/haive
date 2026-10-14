import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, isUniqueViolationOf } from '@haive/database';
import { logger, secretsService } from '@haive/shared';
import {
  OauthUnavailableError,
  OauthVendorError,
  decryptConnectionTokens,
  getIntegrationProvider,
  resolveOauthClient,
  resolveOauthClientById,
  revokeToken,
  type ConnectionTokens,
} from '@haive/shared/integrations';
import type { IntegrationProviderSpec } from '@haive/shared/modularity';
import { HttpError } from '../context.js';
import type { Database } from '../db.js';
import { recordAuditEvent } from './audit.js';
import {
  forgeHostOf,
  isForgeProvider,
  requireEnabled,
  revokeUrlOf,
} from './integration-provider.js';
import { toConnectionSummary, type ConnectionRow } from './integration-sign-in.js';

const REPO_CREDENTIAL_KEY_INDEX = 'integration_connections_repo_credential_key_idx';
const log = logger.child({ module: 'integration-connections' });

export type Revoked = 'yes' | 'no' | 'n/a';

export async function listConnections(db: Database, userId: string) {
  const rows = await db
    .select()
    .from(schema.integrationConnections)
    .where(
      and(
        eq(schema.integrationConnections.scope, 'user'),
        eq(schema.integrationConnections.ownerUserId, userId),
      ),
    )
    .orderBy(asc(schema.integrationConnections.createdAt));
  return rows.map(toConnectionSummary);
}

/** Tokens that cannot be read back (a replaced key) must not keep their connection from being removed. */
function readableTokens(row: ConnectionRow, kek: string): ConnectionTokens | null {
  try {
    return decryptConnectionTokens(row, kek);
  } catch {
    return null;
  }
}

/** RFC 7009 on the token the connection owns, asked with the client that issued it. */
async function revokeAtVendor(
  db: Database,
  row: ConnectionRow,
  tokens: ConnectionTokens,
): Promise<Revoked> {
  const kind = row.authMethod;
  if (kind !== 'oauth2' && kind !== 'device') return 'n/a';
  const spec = getIntegrationProvider(row.providerId);
  const revokeUrl = spec && revokeUrlOf(spec);
  if (revokeUrl === undefined) return 'n/a';
  const client =
    row.oauthClientId === null
      ? await resolveOauthClient(db, row.providerId, row.ownerUserId, kind)
      : await resolveOauthClientById(db, row.providerId, row.ownerUserId, kind, row.oauthClientId);
  if (!client) return 'no';
  try {
    await revokeToken(fetch, {
      revokeUrl,
      client,
      token: tokens.refreshToken ?? tokens.accessToken,
      tokenTypeHint: tokens.refreshToken === null ? 'access_token' : 'refresh_token',
    });
    return 'yes';
  } catch (err) {
    if (!(err instanceof OauthVendorError) && !(err instanceof OauthUnavailableError)) throw err;
    log.warn({ connectionId: row.id, providerId: row.providerId }, 'token revocation failed');
    return 'no';
  }
}

/**
 * Deletes the caller's connection. One that owns its token revokes it at the provider afterwards,
 * best effort; one that points at a Git credential only loses the pointer: the credential and
 * every repository bound to it stay.
 */
export async function disconnectConnection(
  db: Database,
  userId: string,
  connectionId: string,
): Promise<Revoked> {
  if (!z.string().uuid().safeParse(connectionId).success) {
    throw new HttpError(404, 'Connection not found');
  }
  const kek = await secretsService.getMasterKek();
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.integrationConnections)
      .where(
        and(
          eq(schema.integrationConnections.id, connectionId),
          eq(schema.integrationConnections.scope, 'user'),
          eq(schema.integrationConnections.ownerUserId, userId),
        ),
      )
      .for('update');
    if (!row) return null;
    const ownsToken = row.repoCredentialId === null && row.accessTokenEncrypted !== null;
    await tx
      .delete(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connectionId));
    return { row, ownsToken, tokens: ownsToken ? readableTokens(row, kek) : null };
  });
  if (!removed) throw new HttpError(404, 'Connection not found');

  let revoked: Revoked = 'n/a';
  if (removed.ownsToken) {
    revoked = removed.tokens ? await revokeAtVendor(db, removed.row, removed.tokens) : 'no';
  }
  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'integration.connection.disconnect',
    targetType: 'integration_connection',
    targetId: connectionId,
    metadata: {
      providerId: removed.row.providerId,
      credentialBacked: removed.row.repoCredentialId !== null,
      revoked,
    },
  });
  return revoked;
}

/** "Use as connection": an existing Git credential of the caller becomes a connection that points at it. */
export async function linkCredential(
  db: Database,
  userId: string,
  spec: IntegrationProviderSpec,
  repoCredentialId: string,
) {
  if (!isForgeProvider(spec)) {
    throw new HttpError(400, `${spec.displayName} has no Git credentials to use as a connection`);
  }
  await requireEnabled(db, spec);
  const [credential] = await db
    .select({
      id: schema.repoCredentials.id,
      label: schema.repoCredentials.label,
      host: schema.repoCredentials.host,
      provider: schema.repoCredentials.provider,
    })
    .from(schema.repoCredentials)
    .where(
      and(
        eq(schema.repoCredentials.id, repoCredentialId),
        eq(schema.repoCredentials.userId, userId),
      ),
    );
  if (!credential) throw new HttpError(404, 'Credential not found');
  const publicHost = forgeHostOf(spec);
  const belongs = credential.provider
    ? credential.provider === spec.id
    : publicHost !== null && credential.host.trim().toLowerCase() === publicHost;
  if (!belongs) {
    throw new HttpError(400, `This is not a ${spec.displayName} credential (${credential.host})`);
  }
  try {
    const [row] = await db
      .insert(schema.integrationConnections)
      .values({
        providerId: spec.id,
        scope: 'user',
        ownerUserId: userId,
        accountLabel: credential.label,
        authMethod: 'token',
        repoCredentialId: credential.id,
      })
      .returning();
    await recordAuditEvent(db, {
      actorUserId: userId,
      action: 'integration.connection.create',
      targetType: 'integration_connection',
      targetId: row!.id,
      metadata: {
        providerId: spec.id,
        authMethod: 'token',
        credentialBacked: true,
        repoCredentialId: credential.id,
      },
    });
    return toConnectionSummary(row!);
  } catch (err) {
    if (isUniqueViolationOf(err, REPO_CREDENTIAL_KEY_INDEX)) {
      throw new HttpError(409, 'This Git credential is already a connection');
    }
    throw err;
  }
}

export async function setWriteSwitch(
  db: Database,
  userId: string,
  spec: IntegrationProviderSpec,
  writeEnabled: boolean,
): Promise<void> {
  await db
    .insert(schema.integrationUserSettings)
    .values({ userId, providerId: spec.id, writeEnabled })
    .onConflictDoUpdate({
      target: [schema.integrationUserSettings.userId, schema.integrationUserSettings.providerId],
      set: { writeEnabled, updatedAt: new Date() },
    });
  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'integration.write_switch',
    targetType: 'integration_provider',
    metadata: { providerId: spec.id, writeEnabled },
  });
}
