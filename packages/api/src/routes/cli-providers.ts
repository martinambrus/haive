import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema, type Database } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  CLI_INSTALL_METADATA,
  CLI_PROVIDER_CATALOG,
  CLI_PROVIDER_LIST,
  cliProviderNameSchema,
  computeKeyFingerprint,
  createCliProviderRequestSchema,
  DEFAULT_AGENT_RULES,
  envelopeEncrypt,
  normalizeCliArgsArray,
  secretsService,
  setCliProviderSecretRequestSchema,
  updateCliProviderRequestSchema,
  type CliPackageVersionsEntry,
  type CliProbeJobPayload,
  type CliProbeResult,
  type CliProbeTargetMode,
  type CliProviderName,
  type RefreshCliVersionsJobPayload,
  type SandboxImageBuildJobPayload,
} from '@haive/shared';
import { HttpError, type AppEnv } from '../context.js';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getCliExecQueue, getCliExecQueueEvents } from '../queues.js';

async function loadOwnedProvider(db: Database, userId: string, providerId: string) {
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)),
    columns: { id: true },
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');
  return provider;
}

const CLI_PROVIDER_LABEL_MAX_LENGTH = 255;
const MAX_CLONE_ATTEMPTS = 1000;

export function makeCopyLabel(base: string, n: number): string {
  const suffix = n === 1 ? ' Copy' : ` Copy ${n}`;
  const room = CLI_PROVIDER_LABEL_MAX_LENGTH - suffix.length;
  const trimmedBase = room > 0 && base.length > room ? base.slice(0, room) : base;
  const combined = `${trimmedBase}${suffix}`;
  return combined.length > CLI_PROVIDER_LABEL_MAX_LENGTH
    ? combined.slice(0, CLI_PROVIDER_LABEL_MAX_LENGTH)
    : combined;
}

export async function nextAvailableCloneLabel(
  db: Database,
  userId: string,
  originalLabel: string,
): Promise<string> {
  const rows = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    columns: { label: true },
  });
  const existing = new Set(rows.map((r) => r.label));
  for (let n = 1; n <= MAX_CLONE_ATTEMPTS; n++) {
    const candidate = makeCopyLabel(originalLabel, n);
    if (!existing.has(candidate)) return candidate;
  }
  throw new HttpError(409, 'too many clones of this provider', 'clone_limit_reached');
}

async function resolveCliVersionForSave(
  db: Database,
  name: CliProviderName,
  requested: string | null,
): Promise<string | null> {
  const meta = CLI_INSTALL_METADATA[name];
  if (!meta.versionPinnable) return null;
  if (requested) return requested;
  const row = await db.query.cliPackageVersions.findFirst({
    where: eq(schema.cliPackageVersions.name, name),
  });
  return row?.latestVersion ?? null;
}

// Drops any value the adapter does not declare. Adapters with no effort knob
// always store null so a stale UI cannot poison the column.
function resolveEffortLevelForSave(name: CliProviderName, requested: string | null): string | null {
  const scale = CLI_PROVIDER_CATALOG[name].effortScale;
  if (!scale) return null;
  if (requested === null) return null;
  return scale.values.includes(requested) ? requested : null;
}

async function enqueueBuildForProvider(providerId: string, userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.cliProviders)
    .set({
      sandboxImageBuildStatus: 'building',
      sandboxImageBuildError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.cliProviders.id, providerId));
  const payload: SandboxImageBuildJobPayload = { providerId, userId };
  const queue = getCliExecQueue();
  await queue.add(CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE, payload, {
    removeOnComplete: true,
    removeOnFail: 50,
  });
}

export const cliProviderRoutes = new Hono<AppEnv>();

cliProviderRoutes.get('/catalog', async (c) => {
  const db = getDb();
  const versionRows = await db.query.cliPackageVersions.findMany();
  const versionMap = new Map<string, CliPackageVersionsEntry>();
  for (const row of versionRows) {
    versionMap.set(row.name, {
      name: row.name,
      versions: row.versions ?? [],
      latestVersion: row.latestVersion,
      fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
      fetchError: row.fetchError,
    });
  }
  const providers = CLI_PROVIDER_LIST.map((p) => {
    const name = p.name as CliProviderName;
    const meta = CLI_INSTALL_METADATA[name];
    return {
      ...p,
      versionPinnable: meta.versionPinnable,
      installSupported: meta.install.kind !== 'unsupported',
      versionCache: versionMap.get(name) ?? null,
    };
  });
  return c.json({ providers });
});

cliProviderRoutes.post('/catalog/:name/refresh-versions', async (c) => {
  const name = cliProviderNameSchema.parse(c.req.param('name'));
  const payload: RefreshCliVersionsJobPayload = { force: true };
  const queue = getCliExecQueue();
  const events = getCliExecQueueEvents();
  const job = await queue.add(CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS, payload, {
    removeOnComplete: true,
    removeOnFail: 20,
  });
  try {
    await job.waitUntilFinished(events, 30_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(504, `refresh timed out or failed: ${message}`, 'refresh_failed');
  }
  const db = getDb();
  const row = await db.query.cliPackageVersions.findFirst({
    where: eq(schema.cliPackageVersions.name, name),
  });
  if (!row) {
    return c.json({
      entry: {
        name,
        versions: [],
        latestVersion: null,
        fetchedAt: null,
        fetchError: null,
      } satisfies CliPackageVersionsEntry,
    });
  }
  const entry: CliPackageVersionsEntry = {
    name: row.name,
    versions: row.versions ?? [],
    latestVersion: row.latestVersion,
    fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
    fetchError: row.fetchError,
  };
  return c.json({ entry });
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
  const resolvedVersion = await resolveCliVersionForSave(
    db,
    body.name,
    body.cliVersion?.trim() || null,
  );
  const inserted = await db
    .insert(schema.cliProviders)
    .values({
      userId,
      name: body.name,
      label: body.label,
      executablePath: body.executablePath?.trim() || null,
      wrapperPath: body.wrapperPath?.trim() || null,
      wrapperContent: body.wrapperContent?.length ? body.wrapperContent : null,
      envVars: body.envVars ?? null,
      cliArgs: body.cliArgs ? normalizeCliArgsArray(body.cliArgs) : null,
      supportsSubagents: meta.supportsSubagents,
      networkPolicy: body.networkPolicy ?? { mode: 'full', domains: [], ips: [] },
      authMode: body.authMode,
      cliVersion: resolvedVersion,
      effortLevel: resolveEffortLevelForSave(body.name, body.effortLevel ?? null),
      sandboxDockerfileExtra: body.sandboxDockerfileExtra?.length
        ? body.sandboxDockerfileExtra
        : null,
      enabled: body.enabled ?? true,
      rulesContent: body.rulesContent ?? DEFAULT_AGENT_RULES,
    })
    .returning();

  const created = inserted[0]!;
  await enqueueBuildForProvider(created.id, userId);
  return c.json({ provider: { ...created, sandboxImageBuildStatus: 'building' as const } }, 201);
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
  if (body.wrapperContent !== undefined) {
    updates.wrapperContent = body.wrapperContent.length ? body.wrapperContent : null;
  }
  if (body.envVars !== undefined) updates.envVars = body.envVars;
  if (body.cliArgs !== undefined) updates.cliArgs = normalizeCliArgsArray(body.cliArgs);
  if (body.authMode !== undefined) updates.authMode = body.authMode;
  if (body.networkPolicy !== undefined) updates.networkPolicy = body.networkPolicy;

  let imageInputsChanged = false;
  if (body.cliVersion !== undefined) {
    const resolved = await resolveCliVersionForSave(
      db,
      existing.name,
      body.cliVersion?.trim() || null,
    );
    if (resolved !== existing.cliVersion) imageInputsChanged = true;
    updates.cliVersion = resolved;
  }
  if (body.sandboxDockerfileExtra !== undefined) {
    const nextExtra = body.sandboxDockerfileExtra.length ? body.sandboxDockerfileExtra : null;
    if (nextExtra !== existing.sandboxDockerfileExtra) imageInputsChanged = true;
    updates.sandboxDockerfileExtra = nextExtra;
  }
  if (body.effortLevel !== undefined) {
    updates.effortLevel = resolveEffortLevelForSave(existing.name, body.effortLevel);
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;
  if (body.rulesContent !== undefined) updates.rulesContent = body.rulesContent;

  const updated = await db
    .update(schema.cliProviders)
    .set(updates)
    .where(eq(schema.cliProviders.id, id))
    .returning();

  if (imageInputsChanged) {
    await enqueueBuildForProvider(id, userId);
    return c.json({
      provider: {
        ...updated[0]!,
        sandboxImageBuildStatus: 'building' as const,
        sandboxImageBuildError: null,
      },
    });
  }

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

cliProviderRoutes.post('/:id/sandbox-image/build', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
    columns: { id: true },
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');

  await db
    .update(schema.cliProviders)
    .set({
      sandboxImageBuildStatus: 'building',
      sandboxImageBuildError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.cliProviders.id, provider.id));

  const payload: SandboxImageBuildJobPayload = {
    providerId: provider.id,
    userId,
    force: true,
  };

  const queue = getCliExecQueue();
  await queue.add(CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE, payload, {
    removeOnComplete: true,
    removeOnFail: 50,
  });

  return c.json({ ok: true, status: 'building' }, 202);
});

cliProviderRoutes.post('/:id/test', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');

  const targetMode: CliProbeTargetMode =
    provider.authMode === 'subscription' ? 'cli' : provider.authMode === 'api_key' ? 'api' : 'both';

  const payload: CliProbeJobPayload = {
    providerId: provider.id,
    userId,
    targetMode,
  };

  const queue = getCliExecQueue();
  const events = getCliExecQueueEvents();
  const job = await queue.add(CLI_EXEC_JOB_NAMES.PROBE, payload, {
    removeOnComplete: true,
    removeOnFail: true,
  });

  try {
    const result = (await job.waitUntilFinished(events, 30_000)) as CliProbeResult;
    return c.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(504, `probe timed out or failed: ${message}`, 'probe_failed');
  }
});

cliProviderRoutes.post('/:id/clone', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const source = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
  });
  if (!source) throw new HttpError(404, 'CLI provider not found');

  const newLabel = await nextAvailableCloneLabel(db, userId, source.label);

  const inserted = await db
    .insert(schema.cliProviders)
    .values({
      userId: source.userId,
      name: source.name,
      label: newLabel,
      executablePath: source.executablePath,
      wrapperPath: source.wrapperPath,
      wrapperContent: source.wrapperContent,
      envVars: source.envVars,
      cliArgs: source.cliArgs,
      supportsSubagents: source.supportsSubagents,
      networkPolicy: source.networkPolicy,
      authMode: source.authMode,
      cliVersion: source.cliVersion,
      effortLevel: source.effortLevel,
      sandboxDockerfileExtra: source.sandboxDockerfileExtra,
      enabled: source.enabled,
      rulesContent: source.rulesContent,
    })
    .returning();
  const created = inserted[0]!;

  const sourceSecrets = await db.query.cliProviderSecrets.findMany({
    where: eq(schema.cliProviderSecrets.providerId, source.id),
  });
  if (sourceSecrets.length > 0) {
    await db.insert(schema.cliProviderSecrets).values(
      sourceSecrets.map((s) => ({
        providerId: created.id,
        secretName: s.secretName,
        encryptedValue: s.encryptedValue,
        encryptedDek: s.encryptedDek,
        fingerprint: s.fingerprint,
      })),
    );
  }

  await enqueueBuildForProvider(created.id, userId);
  return c.json({ provider: { ...created, sandboxImageBuildStatus: 'building' as const } }, 201);
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
