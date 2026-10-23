import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { userSecretsService } from '@haive/shared';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  getIntegrationProvider,
  listIntegrationModules,
  listIntegrationProviders,
  loadDeactivatedModuleIds,
  loadProviderEnablement,
  oauthRedirectUri,
  resolveOauthClient,
  resolveOauthClientById,
} from '@haive/shared/integrations';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db.js';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from '../lib/audit.js';
import {
  listAdminDefaults,
  removePreference,
  requireValidChoice,
  upsertPreference,
} from '../lib/integration-choice.js';
import { getRedis } from '../redis.js';
import { HttpError, type AppEnv } from '../context.js';
import { pollDeviceSignIn, startDeviceSignIn } from '../lib/integration-device.js';
import { webOrigin } from '../lib/request-origin.js';
import {
  disconnectConnection,
  linkCredential,
  listConnections,
  setWriteSwitch,
} from '../lib/integration-connections.js';
import {
  CLIENT_CHANGED_MESSAGE,
  INVALID_STATE_MESSAGE,
  connectableMethods,
  notConfigured,
  requestedScopes,
  requireEnabled,
  requireOauth2Method,
  requireProvider,
  viaVendor,
  writeAccessOf,
} from '../lib/integration-provider.js';
import { finishSignIn } from '../lib/integration-sign-in.js';
import { putOauthAttempt, takeOauthAttempt } from '../lib/integration-state.js';

const GITHUB_CLIENT_ID_KEY = 'github_client_id';

const putGithubSchema = z.object({
  clientId: z.string().max(256),
});

const completeSchema = z.union([
  z
    .object({
      providerId: z.string().min(1).max(256),
      state: z.string().min(1).max(512),
      code: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      providerId: z.string().min(1).max(256),
      state: z.string().min(1).max(512),
      error: z.string().min(1).max(256),
    })
    .strict(),
]);
const pollSchema = z.object({ handle: z.string().min(1).max(512) });
const writeSchema = z.object({ writeEnabled: z.boolean() });
const linkSchema = z.object({ repoCredentialId: z.string().uuid() });
const preferenceSchema = z.object({
  providerId: z.string().min(1).max(256),
  connectionId: z.string().uuid().nullish(),
});

/** What the provider's `error` parameter said, cut down to a code that is safe to echo. */
const errorCodeOf = (raw: string) => raw.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64) || 'unknown';

export const integrationsRoutes = new Hono<AppEnv>();

integrationsRoutes.use('*', requireAuth);

integrationsRoutes.get('/github', async (c) => {
  // The resolver the sign-in itself uses, so what this reports and what the button does agree.
  const client = await resolveOauthClient(getDb(), 'github', c.get('userId'), 'device');
  return c.json({ configured: client !== null, source: client?.source ?? null });
});

integrationsRoutes.put('/github', async (c) => {
  const userId = c.get('userId');
  const clientId = putGithubSchema.parse(await c.req.json()).clientId.trim();
  const audit: AuditEvent = {
    actorUserId: userId,
    action: 'integration.github_client.update',
    targetType: 'integration_provider',
    metadata: { clientIdSet: clientId.length > 0 },
  };
  await getDb().transaction(async (tx) => {
    if (clientId.length === 0) {
      await userSecretsService.delete(userId, GITHUB_CLIENT_ID_KEY, tx);
    } else {
      await userSecretsService.set(
        userId,
        GITHUB_CLIENT_ID_KEY,
        clientId,
        'GitHub OAuth Client ID',
        tx,
      );
    }
    await insertAuditEvent(tx, audit);
  });
  logAuditEvent(audit);
  return c.json({ ok: true });
});

integrationsRoutes.get('/providers', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const switches = new Map(
    (
      await db
        .select()
        .from(schema.integrationUserSettings)
        .where(eq(schema.integrationUserSettings.userId, userId))
    ).map((setting) => [setting.providerId, setting.writeEnabled]),
  );
  const enablement = await loadProviderEnablement(db);
  const providers = [];
  for (const spec of listIntegrationProviders()) {
    const enabled = enablement.get(spec.id) === true;
    providers.push({
      id: spec.id,
      displayName: spec.displayName,
      categories: spec.categories,
      selfHosted: spec.selfHosted,
      enabled,
      writeEnabled: switches.get(spec.id) ?? false,
      ...writeAccessOf(spec),
      connect: enabled ? await connectableMethods(db, userId, spec) : [],
    });
  }
  return c.json({ providers });
});

integrationsRoutes.get('/categories', async (c) => {
  const deactivated = await loadDeactivatedModuleIds(getDb());
  return c.json({
    categories: [
      ...CORE_INTEGRATION_CATEGORY_SPECS.map((spec) => ({
        ...spec,
        moduleId: null,
        moduleName: null,
      })),
      ...listIntegrationModules()
        .filter((module) => !deactivated.has(module.id))
        .flatMap((module) =>
          module.categories.map((category) => ({
            ...category,
            moduleId: module.id,
            moduleName: module.name,
          })),
        ),
    ],
  });
});

integrationsRoutes.post('/providers/:id/connect', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const spec = requireProvider(c.req.param('id'));
  const method = requireOauth2Method(spec);
  await requireEnabled(db, spec);
  const client = await resolveOauthClient(db, spec.id, userId, 'oauth2');
  if (!client) throw notConfigured(spec);

  const scopes = await requestedScopes(db, userId, spec, method);
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(32).toString('base64url');
  const redirectUri = oauthRedirectUri(webOrigin(), spec.id);
  await putOauthAttempt(getRedis(), userId, spec.id, state, {
    verifier,
    redirectUri,
    scopes,
    clientId: client.clientId,
  });
  return c.json({
    authorizeUrl: buildAuthorizeUrl({
      authorizeUrl: method.authorizeUrl,
      clientId: client.clientId,
      redirectUri,
      scopes,
      state,
      challenge,
      authorizeParams: method.authorizeParams,
    }),
  });
});

integrationsRoutes.post('/oauth/complete', async (c) => {
  const userId = c.get('userId');
  const body = completeSchema.parse(await c.req.json());
  const spec = getIntegrationProvider(body.providerId);
  if (!spec) throw new HttpError(400, INVALID_STATE_MESSAGE);
  // Nothing is asked of the provider or written before this takes the attempt this session started.
  const attempt = await takeOauthAttempt(getRedis(), userId, spec.id, body.state);
  if (!attempt) throw new HttpError(400, INVALID_STATE_MESSAGE);
  if ('error' in body) {
    throw new HttpError(400, `The provider refused the sign-in (${errorCodeOf(body.error)})`);
  }

  const db = getDb();
  await requireEnabled(db, spec);
  const method = requireOauth2Method(spec);
  const client = await resolveOauthClientById(db, spec.id, userId, 'oauth2', attempt.clientId);
  if (!client) throw new HttpError(400, CLIENT_CHANGED_MESSAGE);
  const tokens = await viaVendor(() =>
    exchangeAuthorizationCode(fetch, {
      tokenUrl: method.tokenUrl,
      client,
      code: body.code,
      redirectUri: attempt.redirectUri,
      verifier: attempt.verifier,
    }),
  );
  const { connection } = await finishSignIn({
    db,
    userId,
    spec,
    method,
    client,
    tokens,
    requestedScopes: attempt.scopes,
  });
  return c.json({ connection });
});

integrationsRoutes.post('/providers/:id/device/start', async (c) => {
  const started = await startDeviceSignIn({
    db: getDb(),
    userId: c.get('userId'),
    spec: requireProvider(c.req.param('id')),
    checkEnabled: true,
  });
  return c.json(started);
});

integrationsRoutes.post('/providers/:id/device/poll', async (c) => {
  const { handle } = pollSchema.parse(await c.req.json());
  const polled = await pollDeviceSignIn({
    db: getDb(),
    userId: c.get('userId'),
    spec: requireProvider(c.req.param('id')),
    handle,
    checkEnabled: true,
  });
  return c.json(
    polled.status === 'pending' ? polled : { status: 'ok', connection: polled.result.connection },
  );
});

integrationsRoutes.get('/connections', async (c) => {
  return c.json({ connections: await listConnections(getDb(), c.get('userId')) });
});

integrationsRoutes.delete('/connections/:id', async (c) => {
  const revoked = await disconnectConnection(getDb(), c.get('userId'), c.req.param('id'));
  return c.json({ ok: true, revoked });
});

integrationsRoutes.put('/providers/:id/write', async (c) => {
  const { writeEnabled } = writeSchema.parse(await c.req.json());
  const spec = requireProvider(c.req.param('id'));
  await setWriteSwitch(getDb(), c.get('userId'), spec, writeEnabled);
  return c.json({ providerId: spec.id, writeEnabled });
});

integrationsRoutes.post('/providers/:id/link-credential', async (c) => {
  const { repoCredentialId } = linkSchema.parse(await c.req.json());
  const connection = await linkCredential(
    getDb(),
    c.get('userId'),
    requireProvider(c.req.param('id')),
    repoCredentialId,
  );
  return c.json({ connection }, 201);
});

integrationsRoutes.get('/preferences', async (c) => {
  const preferences = await getDb()
    .select({
      categoryId: schema.integrationCategoryPreferences.categoryId,
      providerId: schema.integrationCategoryPreferences.providerId,
      connectionId: schema.integrationCategoryPreferences.connectionId,
    })
    .from(schema.integrationCategoryPreferences)
    .where(eq(schema.integrationCategoryPreferences.userId, c.get('userId')))
    .orderBy(asc(schema.integrationCategoryPreferences.categoryId));
  return c.json({ preferences });
});

integrationsRoutes.put('/preferences/:categoryId', async (c) => {
  const userId = c.get('userId');
  const categoryId = c.req.param('categoryId');
  const body = preferenceSchema.parse(await c.req.json());
  const pick = { categoryId, providerId: body.providerId, connectionId: body.connectionId ?? null };
  const db = getDb();
  await requireValidChoice(db, userId, pick);
  await upsertPreference(db, { userId, ...pick });
  return c.json(pick);
});

integrationsRoutes.delete('/preferences/:categoryId', async (c) => {
  await removePreference(getDb(), c.get('userId'), c.req.param('categoryId'));
  return c.json({ ok: true });
});

integrationsRoutes.get('/defaults', async (c) => {
  return c.json({ defaults: await listAdminDefaults(getDb()) });
});
