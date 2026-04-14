import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { schema } from '@haive/database';
import { encrypt, generateDek, encryptDek, secretsService } from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const createCredentialSchema = z.object({
  label: z.string().min(1).max(255),
  host: z.string().min(1).max(255),
  username: z.string().min(1).max(255),
  secret: z.string().min(1).max(4096),
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

  return c.json({ credential: inserted[0] }, 201);
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
  return c.json({ ok: true });
});
