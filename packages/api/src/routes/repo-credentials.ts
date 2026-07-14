import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  encrypt,
  generateDek,
  encryptDek,
  decryptDek,
  emailSchema,
  forgeProviderSchema,
  secretsService,
} from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { recordAuditEvent } from '../lib/audit.js';

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

const createCredentialSchema = z
  .object({
    label: z.string().min(1).max(255),
    host: z.string().min(1).max(255),
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
  .refine(identityIsWhole, { message: BOTH_OR_NEITHER, path: ['gitEmail'] });

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
    host: z.string().min(1).max(255),
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
  return c.json({ credentials: rows });
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

  const inserted = await db
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

  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'credential.create',
    targetType: 'repo_credential',
    targetId: inserted[0]?.id ?? null,
    metadata: { host: body.host, label: body.label, identitySet },
  });
  return c.json({ credential: inserted[0] }, 201);
});

repoCredentialsRoutes.put('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = updateCredentialSchema.parse(await c.req.json());
  const db = getDb();

  const existing = await db.query.repoCredentials.findFirst({
    where: and(eq(schema.repoCredentials.id, id), eq(schema.repoCredentials.userId, userId)),
    columns: { id: true, encryptedDek: true },
  });
  if (!existing) throw new HttpError(404, 'Credential not found');

  const update: {
    label: string;
    host: string;
    usernameEncrypted?: string;
    secretEncrypted?: string;
    gitName?: string | null;
    gitEmail?: string | null;
    provider?: string | null;
    apiBaseUrl?: string | null;
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
  if (newUsername || newSecret !== null) {
    const masterKek = await secretsService.getMasterKek();
    const dekHex = decryptDek(existing.encryptedDek, masterKek);
    if (newUsername) update.usernameEncrypted = encrypt(newUsername, dekHex);
    if (newSecret !== null) update.secretEncrypted = encrypt(newSecret, dekHex);
  }

  const updated = await db
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

  await recordAuditEvent(db, {
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
  });
  return c.json({ credential: updated[0] });
});

repoCredentialsRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const result = await db
    .delete(schema.repoCredentials)
    .where(and(eq(schema.repoCredentials.id, id), eq(schema.repoCredentials.userId, userId)))
    .returning({ id: schema.repoCredentials.id });
  if (result.length === 0) throw new HttpError(404, 'Credential not found');
  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'credential.delete',
    targetType: 'repo_credential',
    targetId: id,
  });
  return c.json({ ok: true });
});
