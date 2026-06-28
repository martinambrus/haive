import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { schema } from '@haive/database';
import { encrypt, generateDek, encryptDek, decryptDek, secretsService } from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { recordAuditEvent } from '../lib/audit.js';

const createCredentialSchema = z.object({
  label: z.string().min(1).max(255),
  host: z.string().min(1).max(255),
  username: z.string().min(1).max(255),
  secret: z.string().min(1).max(4096),
});

// Edit: label/host always; username/secret optional — blank means "keep the
// current value" (the encrypted values are never sent to the client, so the
// edit form can't pre-fill them and only replaces what the user re-types).
const updateCredentialSchema = z.object({
  label: z.string().min(1).max(255),
  host: z.string().min(1).max(255),
  username: z.string().max(255).optional(),
  secret: z.string().max(4096).optional(),
});

export const repoCredentialsRoutes = new Hono<AppEnv>();
repoCredentialsRoutes.use('*', requireAuth);

repoCredentialsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.repoCredentials.findMany({
    where: eq(schema.repoCredentials.userId, userId),
    orderBy: [desc(schema.repoCredentials.createdAt)],
    columns: { id: true, label: true, host: true, createdAt: true, updatedAt: true },
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

  const inserted = await db
    .insert(schema.repoCredentials)
    .values({
      userId,
      label: body.label,
      host: body.host,
      usernameEncrypted,
      secretEncrypted,
      encryptedDek,
    })
    .returning({
      id: schema.repoCredentials.id,
      label: schema.repoCredentials.label,
      host: schema.repoCredentials.host,
      createdAt: schema.repoCredentials.createdAt,
    });

  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'credential.create',
    targetType: 'repo_credential',
    targetId: inserted[0]?.id ?? null,
    metadata: { host: body.host, label: body.label },
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
    updatedAt: Date;
  } = { label: body.label, host: body.host, updatedAt: new Date() };

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
