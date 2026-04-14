import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema, type Database } from '@haive/database';
import {
  CLI_PROVIDER_CATALOG,
  CLI_PROVIDER_LIST,
  computeKeyFingerprint,
  createCliProviderRequestSchema,
  envelopeEncrypt,
  secretsService,
  setCliProviderSecretRequestSchema,
  updateCliProviderRequestSchema,
} from '@haive/shared';
import { HttpError, type AppEnv } from '../context.js';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

async function loadOwnedProvider(db: Database, userId: string, providerId: string) {
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)),
    columns: { id: true },
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');
  return provider;
}

export const cliProviderRoutes = new Hono<AppEnv>();

cliProviderRoutes.get('/catalog', (c) => {
  return c.json({ providers: CLI_PROVIDER_LIST });
});

cliProviderRoutes.use('*', requireAuth);

cliProviderRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    orderBy: [desc(schema.cliProviders.createdAt)],
  });
  return c.json({ providers: rows });
});

cliProviderRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const row = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
  });
  if (!row) throw new HttpError(404, 'CLI provider not found');
  return c.json({ provider: row });
});

cliProviderRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = createCliProviderRequestSchema.parse(await c.req.json());
  const meta = CLI_PROVIDER_CATALOG[body.name];

  const db = getDb();
  const existing = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.userId, userId), eq(schema.cliProviders.name, body.name)),
    columns: { id: true },
  });
  if (existing) {
    throw new HttpError(409, `Provider ${body.name} already configured`, 'duplicate_provider');
  }

  const inserted = await db
    .insert(schema.cliProviders)
    .values({
      userId,
      name: body.name,
      label: body.label,
      executablePath: body.executablePath?.trim() || null,
      wrapperPath: body.wrapperPath?.trim() || null,
      envVars: body.envVars ?? null,
      cliArgs: body.cliArgs ?? null,
      supportsSubagents: meta.supportsSubagents,
      authMode: body.authMode,
      enabled: body.enabled ?? true,
    })
    .returning();

  return c.json({ provider: inserted[0]! }, 201);
});

cliProviderRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = updateCliProviderRequestSchema.parse(await c.req.json());
  const db = getDb();

  const existing = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
  });
  if (!existing) throw new HttpError(404, 'CLI provider not found');

  if (body.name && body.name !== existing.name) {
    throw new HttpError(400, 'Provider name cannot be changed', 'name_immutable');
  }

  const updates: Partial<typeof schema.cliProviders.$inferInsert> = { updatedAt: new Date() };
  if (body.label !== undefined) updates.label = body.label;
  if (body.executablePath !== undefined) {
    updates.executablePath = body.executablePath.trim() || null;
  }
  if (body.wrapperPath !== undefined) {
    updates.wrapperPath = body.wrapperPath.trim() || null;
  }
  if (body.envVars !== undefined) updates.envVars = body.envVars;
  if (body.cliArgs !== undefined) updates.cliArgs = body.cliArgs;
  if (body.authMode !== undefined) updates.authMode = body.authMode;
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  const updated = await db
    .update(schema.cliProviders)
    .set(updates)
    .where(eq(schema.cliProviders.id, id))
    .returning();

  return c.json({ provider: updated[0]! });
});

cliProviderRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const result = await db
    .delete(schema.cliProviders)
    .where(and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)))
    .returning({ id: schema.cliProviders.id });
  if (result.length === 0) throw new HttpError(404, 'CLI provider not found');
  return c.json({ ok: true });
});

cliProviderRoutes.get('/:providerId/secrets', async (c) => {
  const userId = c.get('userId');
  const providerId = c.req.param('providerId');
  const db = getDb();
  await loadOwnedProvider(db, userId, providerId);

  const rows = await db.query.cliProviderSecrets.findMany({
    where: eq(schema.cliProviderSecrets.providerId, providerId),
    orderBy: [desc(schema.cliProviderSecrets.createdAt)],
    columns: {
      id: true,
      secretName: true,
      fingerprint: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return c.json({ secrets: rows });
});

cliProviderRoutes.post('/:providerId/secrets', async (c) => {
  const userId = c.get('userId');
  const providerId = c.req.param('providerId');
  const body = setCliProviderSecretRequestSchema.parse(await c.req.json());
  const db = getDb();
  await loadOwnedProvider(db, userId, providerId);

  const masterKek = await secretsService.getMasterKek();
  const envelope = envelopeEncrypt(body.value, masterKek);
  const fingerprint = computeKeyFingerprint(body.value);

  const existing = await db.query.cliProviderSecrets.findFirst({
    where: and(
      eq(schema.cliProviderSecrets.providerId, providerId),
      eq(schema.cliProviderSecrets.secretName, body.secretName),
    ),
    columns: { id: true },
  });

  if (existing) {
    const updated = await db
      .update(schema.cliProviderSecrets)
      .set({
        encryptedValue: envelope.encryptedValue,
        encryptedDek: envelope.encryptedDek,
        fingerprint,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviderSecrets.id, existing.id))
      .returning({
        id: schema.cliProviderSecrets.id,
        secretName: schema.cliProviderSecrets.secretName,
        fingerprint: schema.cliProviderSecrets.fingerprint,
        createdAt: schema.cliProviderSecrets.createdAt,
        updatedAt: schema.cliProviderSecrets.updatedAt,
      });
    return c.json({ secret: updated[0]! });
  }

  const inserted = await db
    .insert(schema.cliProviderSecrets)
    .values({
      providerId,
      secretName: body.secretName,
      encryptedValue: envelope.encryptedValue,
      encryptedDek: envelope.encryptedDek,
      fingerprint,
    })
    .returning({
      id: schema.cliProviderSecrets.id,
      secretName: schema.cliProviderSecrets.secretName,
      fingerprint: schema.cliProviderSecrets.fingerprint,
      createdAt: schema.cliProviderSecrets.createdAt,
      updatedAt: schema.cliProviderSecrets.updatedAt,
    });
  return c.json({ secret: inserted[0]! }, 201);
});

cliProviderRoutes.delete('/:providerId/secrets/:secretName', async (c) => {
  const userId = c.get('userId');
  const providerId = c.req.param('providerId');
  const secretName = c.req.param('secretName');
  const db = getDb();
  await loadOwnedProvider(db, userId, providerId);

  const result = await db
    .delete(schema.cliProviderSecrets)
    .where(
      and(
        eq(schema.cliProviderSecrets.providerId, providerId),
        eq(schema.cliProviderSecrets.secretName, secretName),
      ),
    )
    .returning({ id: schema.cliProviderSecrets.id });
  if (result.length === 0) throw new HttpError(404, 'Secret not found');
  return c.json({ ok: true });
});
