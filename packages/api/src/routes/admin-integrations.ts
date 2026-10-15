import { Hono } from 'hono';
import { z } from 'zod';
import { schema } from '@haive/database';
import { envelopeEncrypt, secretsService } from '@haive/shared';
import {
  defaultProviderEnabled,
  envClientSource,
  getIntegrationProvider,
  listIntegrationProviders,
  oauthRedirectUri,
} from '@haive/shared/integrations';
import type { IntegrationProviderSpec } from '@haive/shared/modularity';
import { getDb } from '../db.js';
import { recordAuditEvent } from '../lib/audit.js';
import {
  listAdminDefaults,
  removePreference,
  requireValidChoice,
  upsertPreference,
} from '../lib/integration-choice.js';
import { webOrigin } from '../lib/request-origin.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

type ConfigRow = typeof schema.integrationProviderConfigs.$inferSelect;

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    oauthClientId: z
      .string()
      .max(256)
      .transform((value) => value.trim())
      .optional(),
    oauthClientSecret: z
      .string()
      .max(4096)
      .transform((value) => value.trim())
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to change',
  });

const defaultSchema = z.object({ providerId: z.string().min(1).max(256).nullable() });

function providerJson(spec: IntegrationProviderSpec, row: ConfigRow | undefined) {
  return {
    id: spec.id,
    name: spec.displayName,
    categories: spec.categories,
    authKinds: spec.auth.map((method) => method.kind),
    enabled: row ? row.enabled : defaultProviderEnabled(spec.id),
    rowExists: row !== undefined,
    oauthClientId: row?.oauthClientId ?? null,
    hasClientSecret: Boolean(row?.oauthClientSecretEncrypted && row.encryptedDek),
    redirectUri: oauthRedirectUri(webOrigin(), spec.id),
    precedence: envClientSource(spec.id),
  };
}

async function secretColumns(secret: string) {
  if (secret === '') return { oauthClientSecretEncrypted: null, encryptedDek: null };
  const sealed = envelopeEncrypt(secret, await secretsService.getMasterKek());
  return { oauthClientSecretEncrypted: sealed.encryptedValue, encryptedDek: sealed.encryptedDek };
}

export const adminIntegrationRoutes = new Hono<AppEnv>();
adminIntegrationRoutes.use('*', requireAuth);
adminIntegrationRoutes.use('*', requireAdmin);

adminIntegrationRoutes.get('/providers', async (c) => {
  const rows = await getDb().select().from(schema.integrationProviderConfigs);
  const byId = new Map(rows.map((row) => [row.providerId, row]));
  return c.json({
    providers: listIntegrationProviders().map((spec) => providerJson(spec, byId.get(spec.id))),
  });
});

adminIntegrationRoutes.put('/providers/:id', async (c) => {
  const spec = getIntegrationProvider(c.req.param('id'));
  if (!spec) throw new HttpError(404, 'Integration provider not found');
  const body = updateSchema.parse(await c.req.json());
  const userId = c.get('userId');
  const db = getDb();

  const changes: Partial<typeof schema.integrationProviderConfigs.$inferInsert> = {
    updatedBy: userId,
    updatedAt: new Date(),
  };
  if (body.enabled !== undefined) changes.enabled = body.enabled;
  if (body.oauthClientId !== undefined) changes.oauthClientId = body.oauthClientId || null;
  if (body.oauthClientSecret !== undefined) {
    Object.assign(changes, await secretColumns(body.oauthClientSecret));
  }

  // A new row takes the provider's current default, not the column's FALSE, so a save that
  // only sets a client id leaves a core provider enabled.
  const [saved] = await db
    .insert(schema.integrationProviderConfigs)
    .values({ providerId: spec.id, enabled: defaultProviderEnabled(spec.id), ...changes })
    .onConflictDoUpdate({ target: schema.integrationProviderConfigs.providerId, set: changes })
    .returning();

  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'integration.provider_config.update',
    targetType: 'integration_provider_config',
    metadata: {
      providerId: spec.id,
      enabledChanged: body.enabled !== undefined,
      oauthClientIdChanged: body.oauthClientId !== undefined,
      oauthClientSecretChanged: body.oauthClientSecret !== undefined,
    },
  });
  return c.json({ provider: providerJson(spec, saved) });
});

adminIntegrationRoutes.get('/defaults', async (c) => {
  return c.json({ defaults: await listAdminDefaults(getDb()) });
});

adminIntegrationRoutes.put('/defaults/:categoryId', async (c) => {
  const categoryId = c.req.param('categoryId');
  const { providerId } = defaultSchema.parse(await c.req.json());
  const userId = c.get('userId');
  const db = getDb();

  if (providerId === null) {
    await removePreference(db, null, categoryId);
  } else {
    await requireValidChoice(db, userId, { categoryId, providerId, connectionId: null });
    await upsertPreference(db, { userId: null, categoryId, providerId, connectionId: null });
  }

  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'integration.category_default.update',
    targetType: 'integration_category_default',
    metadata: { categoryId, providerId },
  });
  return c.json({ categoryId, providerId });
});
