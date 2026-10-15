import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { secretsService } from '../config/secrets.service.js';
import { decrypt, decryptDek, envelopeDecrypt } from '../crypto/index.js';
import { logger } from '../logger/index.js';
import { decryptConnectionTokens, encryptConnectionTokens } from './connection-tokens.js';
import {
  ConnectionNotFoundError,
  NeedsReauthError,
  OauthUnavailableError,
  OauthVendorError,
} from './errors.js';
import { refreshAccessToken, type TokenSet } from './oauth.js';
import { resolveOauthClient, resolveOauthClientById } from './oauth-client.js';
import { getIntegrationProvider } from './providers.js';

const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
/** OAuth's code for a refresh token the vendor will not take again, and GitHub's own name for it. */
const REFRESH_REJECTED_CODES = new Set(['invalid_grant', 'bad_refresh_token']);
/** The provider refused the client, not the connection (GitHub's name included): fixing the
 *  client's configuration, a missing secret among them, heals every connection, so none is stranded. */
const CLIENT_REFUSED_CODES = new Set(['invalid_client', 'incorrect_client_credentials']);

type ConnectionRow = typeof schema.integrationConnections.$inferSelect;
type Outcome = { accessToken: string } | { needsReauth: true } | { refused: OauthVendorError };

export interface AccessTokenOptions {
  fetchFn: typeof fetch;
  now?: () => number;
}

/** username and apiBaseUrl are the Git credential's, so null for an OAuth connection. */
export interface ConnectionCredential {
  accessToken: string;
  username: string | null;
  provider: string;
  apiBaseUrl: string | null;
}

// Per database client, so one process shares a refresh among its callers while two pools do not.
const refreshing = new WeakMap<Database, Map<string, Promise<string>>>();

function isExpiring(row: ConnectionRow, nowMs: number): boolean {
  return row.expiresAt !== null && row.expiresAt.getTime() - REFRESH_MARGIN_MS <= nowMs;
}

async function loadConnectedRow(db: Database, connectionId: string): Promise<ConnectionRow> {
  const [row] = await db
    .select()
    .from(schema.integrationConnections)
    .where(eq(schema.integrationConnections.id, connectionId));
  if (!row) throw new ConnectionNotFoundError(connectionId);
  if (row.status !== 'connected') throw new NeedsReauthError(connectionId, row.status);
  return row;
}

/**
 * A usable access token, refreshed first when about to expire; a Git-credential-backed connection
 * returns that credential's secret. Throws NeedsReauthError when the owner must sign in again.
 */
export async function getConnectionAccessToken(
  db: Database,
  connectionId: string,
  options: AccessTokenOptions,
): Promise<string> {
  const now = options.now ?? Date.now;
  const row = await loadConnectedRow(db, connectionId);

  const kek = await secretsService.getMasterKek();
  if (row.repoCredentialId !== null) {
    const [credential] = await db
      .select({
        encryptedValue: schema.repoCredentials.secretEncrypted,
        encryptedDek: schema.repoCredentials.encryptedDek,
      })
      .from(schema.repoCredentials)
      .where(eq(schema.repoCredentials.id, row.repoCredentialId));
    if (!credential) throw new ConnectionNotFoundError(connectionId);
    return envelopeDecrypt(credential, kek);
  }
  if (!isExpiring(row, now())) return decryptConnectionTokens(row, kek).accessToken;

  const inFlight = refreshing.get(db) ?? new Map<string, Promise<string>>();
  refreshing.set(db, inFlight);
  let flight = inFlight.get(connectionId);
  if (!flight) {
    flight = refreshLocked(db, connectionId, kek, options.fetchFn, now).finally(() =>
      inFlight.delete(connectionId),
    );
    inFlight.set(connectionId, flight);
  }
  return flight;
}

/** getConnectionAccessToken plus the Git credential's username and API base, for a forge call. */
export async function getConnectionCredential(
  db: Database,
  connectionId: string,
  options: AccessTokenOptions,
): Promise<ConnectionCredential> {
  const row = await loadConnectedRow(db, connectionId);
  if (row.repoCredentialId === null) {
    const accessToken = await getConnectionAccessToken(db, connectionId, options);
    return { accessToken, username: null, provider: row.providerId, apiBaseUrl: null };
  }

  const [credential] = await db
    .select({
      usernameEncrypted: schema.repoCredentials.usernameEncrypted,
      secretEncrypted: schema.repoCredentials.secretEncrypted,
      encryptedDek: schema.repoCredentials.encryptedDek,
      apiBaseUrl: schema.repoCredentials.apiBaseUrl,
    })
    .from(schema.repoCredentials)
    .where(eq(schema.repoCredentials.id, row.repoCredentialId));
  if (!credential) throw new ConnectionNotFoundError(connectionId);
  const dek = decryptDek(credential.encryptedDek, await secretsService.getMasterKek());
  return {
    accessToken: decrypt(credential.secretEncrypted, dek),
    username: decrypt(credential.usernameEncrypted, dek),
    provider: row.providerId,
    apiBaseUrl: credential.apiBaseUrl,
  };
}

async function refreshLocked(
  db: Database,
  connectionId: string,
  kek: string,
  fetchFn: typeof fetch,
  now: () => number,
): Promise<string> {
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${REFRESH_LOCK_TIMEOUT_MS}ms'`));
    const [row] = await tx
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connectionId))
      .for('update');
    if (!row) throw new ConnectionNotFoundError(connectionId);
    if (row.status !== 'connected') throw new NeedsReauthError(connectionId, row.status);
    const tokens = decryptConnectionTokens(row, kek);
    if (!isExpiring(row, now())) return { accessToken: tokens.accessToken };

    const needsReauth = async (reason: string): Promise<Outcome> => {
      await tx
        .update(schema.integrationConnections)
        .set({ status: 'needs_reauth', lastError: reason, updatedAt: new Date(now()) })
        .where(eq(schema.integrationConnections.id, connectionId));
      logger.warn(
        { connectionId, providerId: row.providerId },
        'integration connection needs to be connected again',
      );
      return { needsReauth: true };
    };
    if (tokens.refreshToken === null) return needsReauth('The provider issued no refresh token.');

    const method = getIntegrationProvider(row.providerId)?.auth.find(
      (auth) => auth.kind === row.authMethod,
    );
    if (method?.kind !== 'oauth2' && method?.kind !== 'device') {
      throw new OauthUnavailableError(
        `provider ${row.providerId} has no ${row.authMethod} method to refresh with`,
      );
    }
    const issuer = row.oauthClientId;
    const client =
      issuer === null
        ? await resolveOauthClient(tx, row.providerId, row.ownerUserId, method.kind, kek)
        : await resolveOauthClientById(
            tx,
            row.providerId,
            row.ownerUserId,
            method.kind,
            issuer,
            kek,
          );
    if (!client) {
      // A replaced client strands the connection; no client at all may be a config gap that heals.
      const current =
        issuer === null
          ? null
          : await resolveOauthClient(tx, row.providerId, row.ownerUserId, method.kind, kek);
      if (current !== null) {
        return needsReauth('The OAuth client that issued this connection was replaced.');
      }
      throw new OauthUnavailableError(`no OAuth client is configured for ${row.providerId}`);
    }

    let fresh: TokenSet;
    try {
      fresh = await refreshAccessToken(fetchFn, {
        tokenUrl: method.tokenUrl,
        client,
        refreshToken: tokens.refreshToken,
        now,
      });
    } catch (err) {
      if (err instanceof OauthVendorError && CLIENT_REFUSED_CODES.has(err.code)) {
        await tx
          .update(schema.integrationConnections)
          .set({
            lastError: `The provider refused this connection's OAuth client (${err.code}); its client secret may be missing or wrong.`,
            updatedAt: new Date(now()),
          })
          .where(eq(schema.integrationConnections.id, connectionId));
        return { refused: err };
      }
      if (err instanceof OauthVendorError && REFRESH_REJECTED_CODES.has(err.code)) {
        return needsReauth(err.description ?? err.code);
      }
      throw err;
    }
    await tx
      .update(schema.integrationConnections)
      .set({
        ...encryptConnectionTokens(
          {
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken ?? tokens.refreshToken,
          },
          kek,
        ),
        expiresAt: fresh.expiresAt,
        grantedScopes: fresh.scopes ?? row.grantedScopes,
        updatedAt: new Date(now()),
      })
      .where(eq(schema.integrationConnections.id, connectionId));
    return { accessToken: fresh.accessToken };
  });
  if ('needsReauth' in outcome) throw new NeedsReauthError(connectionId, 'needs_reauth');
  if ('refused' in outcome) throw outcome.refused;
  return outcome.accessToken;
}
