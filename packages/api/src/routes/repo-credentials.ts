import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import { isLockNotAvailable, schema, type DbTx } from '@haive/database';
import {
  encrypt,
  generateDek,
  encryptDek,
  decryptDek,
  emailSchema,
  forgeProviderSchema,
  secretsService,
} from '@haive/shared';
import { apiBaseFits, credentialForgeProvider } from '@haive/shared/forge';
import { getIntegrationProvider } from '@haive/shared/integrations';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from '../lib/audit.js';

// Optional commit identity, mirroring the global one in `gitIdentityUpdateSchema`.
const gitNameField = z
  .string()
  .max(100)
  .transform((v) => v.trim())
  .optional();
const gitEmailField = z
  .union([z.literal(''), emailSchema])
  .transform((v) => v.trim())
  .optional();

const BOTH_OR_NEITHER = 'gitName and gitEmail must be set together, or both left empty';

/** Half a pair would author commits as `Work Name <personal@email>`. */
const identityIsWhole = (b: { gitName?: string; gitEmail?: string }) =>
  Boolean(b.gitName?.length) === Boolean(b.gitEmail?.length);

const HOST_LABEL = '[a-z0-9]+(?:-+[a-z0-9]+)*';
const HOST_NAME = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*(?::([1-9][0-9]{0,4}))?$`);

const isHostName = (v: string) => {
  const m = HOST_NAME.exec(v);
  if (m === null || (m[1] !== undefined && Number(m[1]) > 65535)) return false;
  // The URL parser rewrites numeric hosts and drops a default port; refuse what would not survive it.
  try {
    return new URL(`https://${v}/`).host === v;
  } catch {
    return false;
  }
};

/** A host name with an optional port, stored trimmed and lower case, so no userinfo or path can ride into a URL built from it. */
const hostField = z
  .string()
  .max(255)
  .trim()
  .toLowerCase()
  .refine(isHostName, { message: 'host must be a host name, optionally followed by :port' });

const API_BASE_ON_HOST =
  "apiBaseUrl must be an https URL on the credential's host or its forge's API host, with no user, query or fragment";

// What an edit leaves behind: the stored provider and URL stand in for whatever the request omits.
const apiBaseTargetSchema = z
  .object({ host: z.string(), provider: z.string().nullish(), apiBaseUrl: z.string().nullish() })
  .refine(apiBaseFits, { message: API_BASE_ON_HOST, path: ['apiBaseUrl'] });

const createCredentialSchema = z
  .object({
    label: z.string().min(1).max(255),
    host: hostField,
    username: z.string().min(1).max(255),
    secret: z.string().min(1).max(4096),
    // Which forge to call for PR creation/polling. '' = auto-detect from host (only
    // works for the four well-known public hosts); required for self-hosted forges.
    provider: z.union([z.literal(''), forgeProviderSchema]).optional(),
    // Self-hosted API base override (e.g. https://git.example.com/api/v1); blank =
    // derive from the provider convention.
    apiBaseUrl: z.string().max(500).optional(),
    gitName: gitNameField,
    gitEmail: gitEmailField,
  })
  .refine(identityIsWhole, { message: BOTH_OR_NEITHER, path: ['gitEmail'] })
  .refine(apiBaseFits, { message: API_BASE_ON_HOST, path: ['apiBaseUrl'] });

// Edit: label/host always; username/secret optional — blank means "keep the
// current value" (the encrypted values are never sent to the client, so the
// edit form can't pre-fill them and only replaces what the user re-types).
//
// The identity pair is different: it is plaintext and IS returned to the client, so
// the form pre-fills it and an emptied field is a deliberate clear. Omitting the keys
// entirely still means "keep" — otherwise an older client that PUTs only {label, host}
// would silently wipe a configured identity.
const updateCredentialSchema = z
  .object({
    label: z.string().min(1).max(255),
    host: hostField,
    username: z.string().max(255).optional(),
    secret: z.string().max(4096).optional(),
    provider: z.union([z.literal(''), forgeProviderSchema]).optional(),
    apiBaseUrl: z.string().max(500).optional(),
    gitName: gitNameField,
    gitEmail: gitEmailField,
  })
  .refine((b) => (b.gitName === undefined) === (b.gitEmail === undefined), {
    message: BOTH_OR_NEITHER,
    path: ['gitEmail'],
  })
  .refine(identityIsWhole, { message: BOTH_OR_NEITHER, path: ['gitEmail'] });

/** The connection that points at a credential of this user, its row locked. A reconnect locks its
 *  connection before its credential, so the writers here take the two in that order as well. */
const lockConnectionOf = (tx: DbTx, credentialId: string, userId: string, noWait = false) =>
  tx
    .select({
      id: schema.integrationConnections.id,
      providerId: schema.integrationConnections.providerId,
      authMethod: schema.integrationConnections.authMethod,
      accountLabel: schema.integrationConnections.accountLabel,
    })
    .from(schema.integrationConnections)
    .where(
      and(
        eq(schema.integrationConnections.repoCredentialId, credentialId),
        eq(schema.integrationConnections.ownerUserId, userId),
      ),
    )
    .for('update', noWait ? { noWait: true } : {});

/** The connection a link committed while the request waited for the credential row, which it holds
 *  by now. A reconnect holds its connection and queues for the credential, so waiting for the row
 *  here would be the reverse order and deadlock with it: a row someone holds answers 503 instead,
 *  and the request can be sent again. */
const lockLateConnectionOf = async (tx: DbTx, credentialId: string, userId: string) => {
  try {
    return (await lockConnectionOf(tx, credentialId, userId, true))[0];
  } catch (err) {
    if (isLockNotAvailable(err)) {
      throw new HttpError(503, "This Git credential's connection is being changed; try again");
    }
    throw err;
  }
};

export const repoCredentialsRoutes = new Hono<AppEnv>();
repoCredentialsRoutes.use('*', requireAuth);

repoCredentialsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.repoCredentials.findMany({
    where: eq(schema.repoCredentials.userId, userId),
    orderBy: [desc(schema.repoCredentials.createdAt)],
    columns: {
      id: true,
      label: true,
      host: true,
      provider: true,
      apiBaseUrl: true,
      gitName: true,
      gitEmail: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const connections = await db
    .select({
      repoCredentialId: schema.integrationConnections.repoCredentialId,
      id: schema.integrationConnections.id,
      providerId: schema.integrationConnections.providerId,
      accountLabel: schema.integrationConnections.accountLabel,
    })
    .from(schema.integrationConnections)
    .where(
      and(
        eq(schema.integrationConnections.scope, 'user'),
        eq(schema.integrationConnections.ownerUserId, userId),
        isNotNull(schema.integrationConnections.repoCredentialId),
      ),
    );
  const byCredential = new Map(connections.map((row) => [row.repoCredentialId, row]));
  return c.json({
    credentials: rows.map((row) => {
      const connection = byCredential.get(row.id);
      return {
        ...row,
        connection: connection
          ? {
              id: connection.id,
              providerId: connection.providerId,
              providerName:
                getIntegrationProvider(connection.providerId)?.displayName ?? connection.providerId,
              accountLabel: connection.accountLabel,
            }
          : null,
      };
    }),
  });
});

repoCredentialsRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = createCredentialSchema.parse(await c.req.json());
  const db = getDb();

  const masterKek = await secretsService.getMasterKek();
  const dekHex = generateDek();
  const usernameEncrypted = encrypt(body.username, dekHex);
  const secretEncrypted = encrypt(body.secret, dekHex);
  const encryptedDek = encryptDek(dekHex, masterKek);

  // The refine guarantees the pair is whole, so one non-empty half implies the other.
  const identitySet = Boolean(body.gitName?.length);

  const { inserted, audit } = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(schema.repoCredentials)
      .values({
        userId,
        label: body.label,
        host: body.host,
        provider: body.provider ? body.provider : null,
        apiBaseUrl: body.apiBaseUrl?.trim() || null,
        usernameEncrypted,
        secretEncrypted,
        encryptedDek,
        gitName: identitySet ? (body.gitName ?? null) : null,
        gitEmail: identitySet ? (body.gitEmail ?? null) : null,
      })
      .returning({
        id: schema.repoCredentials.id,
        label: schema.repoCredentials.label,
        host: schema.repoCredentials.host,
        provider: schema.repoCredentials.provider,
        apiBaseUrl: schema.repoCredentials.apiBaseUrl,
        gitName: schema.repoCredentials.gitName,
        gitEmail: schema.repoCredentials.gitEmail,
        createdAt: schema.repoCredentials.createdAt,
      });
    const ev: AuditEvent = {
      actorUserId: userId,
      action: 'credential.create',
      targetType: 'repo_credential',
      targetId: rows[0]?.id ?? null,
      metadata: { host: body.host, label: body.label, identitySet },
    };
    await insertAuditEvent(tx, ev);
    return { inserted: rows, audit: ev };
  });
  logAuditEvent(audit);
  return c.json({ credential: inserted[0] }, 201);
});

repoCredentialsRoutes.put('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = updateCredentialSchema.parse(await c.req.json());
  const db = getDb();

  const update: {
    label: string;
    host: string;
    usernameEncrypted?: string;
    secretEncrypted?: string;
    gitName?: string | null;
    gitEmail?: string | null;
    provider?: string | null;
    apiBaseUrl?: string | null;
    signInAccountId?: null;
    updatedAt: Date;
  } = { label: body.label, host: body.host, updatedAt: new Date() };
  // Absent = keep; '' = auto-detect (null); a value = pin. Same keep-on-omit rule as
  // the identity pair, so an older client that omits them never wipes a set provider.
  if (body.provider !== undefined) update.provider = body.provider ? body.provider : null;
  if (body.apiBaseUrl !== undefined) update.apiBaseUrl = body.apiBaseUrl.trim() || null;

  // Absent = keep. Present = replace, where an empty pair clears the identity. The
  // refines guarantee both keys arrive together and are both empty or both filled.
  const identityChanged = body.gitName !== undefined;
  if (identityChanged) {
    update.gitName = body.gitName!.length > 0 ? body.gitName! : null;
    update.gitEmail = body.gitEmail!.length > 0 ? body.gitEmail! : null;
  }

  // Re-encrypt only the fields the user actually changed, reusing the existing
  // per-credential DEK so the stored secret never round-trips to the client.
  const newUsername = body.username?.trim();
  const newSecret = typeof body.secret === 'string' && body.secret.length > 0 ? body.secret : null;
  const masterKek = newUsername || newSecret !== null ? await secretsService.getMasterKek() : null;

  const audit: AuditEvent = {
    actorUserId: userId,
    action: 'credential.update',
    targetType: 'repo_credential',
    targetId: id,
    metadata: {
      host: body.host,
      label: body.label,
      usernameChanged: Boolean(newUsername),
      secretChanged: newSecret !== null,
      identityChanged,
    },
  };

  // One lock from read to write, so an overlapping edit cannot change the row the check judged.
  const updated = await db.transaction(async (tx) => {
    let [connection] = await lockConnectionOf(tx, id, userId);
    const [existing] = await tx
      .select({
        encryptedDek: schema.repoCredentials.encryptedDek,
        label: schema.repoCredentials.label,
        host: schema.repoCredentials.host,
        provider: schema.repoCredentials.provider,
        apiBaseUrl: schema.repoCredentials.apiBaseUrl,
      })
      .from(schema.repoCredentials)
      .where(and(eq(schema.repoCredentials.id, id), eq(schema.repoCredentials.userId, userId)))
      .for('update');
    if (!existing) throw new HttpError(404, 'Credential not found');
    apiBaseTargetSchema.parse({
      host: body.host,
      provider: body.provider ?? existing.provider,
      apiBaseUrl: body.apiBaseUrl ?? existing.apiBaseUrl,
    });

    // One a link committed while this waited for the credential.
    connection ??= await lockLateConnectionOf(tx, id, userId);
    if (connection) {
      const nextProvider = body.provider === undefined ? existing.provider : body.provider || null;
      const existingForge = credentialForgeProvider(existing.provider, existing.host);
      const nextForge = credentialForgeProvider(nextProvider, body.host);
      if (
        existing.host.toLowerCase() !== body.host ||
        (nextForge !== existingForge && nextForge !== connection.providerId)
      ) {
        const providerName =
          getIntegrationProvider(connection.providerId)?.displayName ?? connection.providerId;
        throw new HttpError(
          409,
          `This Git credential is the connection to ${connection.accountLabel} on ${providerName}, so its host and forge provider cannot be changed; disconnect the connection first`,
          'credential-backs-connection',
        );
      }
    }

    if (masterKek !== null) {
      const dekHex = decryptDek(existing.encryptedDek, masterKek);
      if (newUsername) update.usernameEncrypted = encrypt(newUsername, dekHex);
      if (newSecret !== null) {
        update.secretEncrypted = encrypt(newSecret, dekHex);
        // A secret the user typed is theirs: a later sign-in must not take the credential back and replace it.
        update.signInAccountId = null;
      }
    }

    const rows = await tx
      .update(schema.repoCredentials)
      .set(update)
      .where(and(eq(schema.repoCredentials.id, id), eq(schema.repoCredentials.userId, userId)))
      .returning({
        id: schema.repoCredentials.id,
        label: schema.repoCredentials.label,
        host: schema.repoCredentials.host,
        provider: schema.repoCredentials.provider,
        apiBaseUrl: schema.repoCredentials.apiBaseUrl,
        gitName: schema.repoCredentials.gitName,
        gitEmail: schema.repoCredentials.gitEmail,
        createdAt: schema.repoCredentials.createdAt,
        updatedAt: schema.repoCredentials.updatedAt,
      });
    if (connection?.authMethod === 'token' && body.label !== existing.label) {
      await tx
        .update(schema.integrationConnections)
        .set({ accountLabel: body.label, updatedAt: new Date() })
        .where(eq(schema.integrationConnections.id, connection.id));
    }
    await insertAuditEvent(tx, audit);
    return rows;
  });
  logAuditEvent(audit);
  return c.json({ credential: updated[0] });
});

repoCredentialsRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const audit = await db.transaction(async (tx) => {
    // Locked, not just read: a disconnect running now removes the connection itself, and the audit
    // row names only what this delete took.
    let [connection] = await lockConnectionOf(tx, id, userId);
    const [locked] = await tx
      .select({ id: schema.repoCredentials.id })
      .from(schema.repoCredentials)
      .where(and(eq(schema.repoCredentials.id, id), eq(schema.repoCredentials.userId, userId)))
      .for('update');
    if (!locked) throw new HttpError(404, 'Credential not found');
    // One a link committed while this waited for the credential.
    connection ??= await lockLateConnectionOf(tx, id, userId);
    await tx
      .delete(schema.repoCredentials)
      .where(and(eq(schema.repoCredentials.id, id), eq(schema.repoCredentials.userId, userId)));
    const event: AuditEvent = {
      actorUserId: userId,
      action: 'credential.delete',
      targetType: 'repo_credential',
      targetId: id,
      ...(connection && {
        metadata: { connectionId: connection.id, providerId: connection.providerId },
      }),
    };
    await insertAuditEvent(tx, event);
    return event;
  });
  logAuditEvent(audit);
  return c.json({ ok: true });
});
