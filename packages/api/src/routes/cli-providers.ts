import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema, type Database } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  CLI_POLLABLE_JOB_OPTS,
  CLI_INSTALL_METADATA,
  CLI_PROVIDER_CATALOG,
  CLI_PROVIDER_LIST,
  cliProviderNameSchema,
  createCliProviderRequestSchema,
  DEFAULT_AGENT_RULES,
  inheritsDefaultRules,
  isOllamaCloudModel,
  isRunnableCliVersion,
  logger,
  normalizeCliArgsArray,
  resolveDefaultCliProvider,
  secretsService,
  setCliProviderSecretRequestSchema,
  splitSecretLikeEnv,
  updateCliProviderRequestSchema,
  upsertProviderSecret,
  type CliPackageVersionsEntry,
  type CliProbeJobPayload,
  type CliProbeResult,
  type CliProviderName,
  type CliSignOutJobPayload,
  type CliSignOutJobResult,
  type OllamaProvisionJobPayload,
  type RefreshCliVersionsJobResult,
  type SandboxImageBuildJobPayload,
  type SandboxImageRemoveJobPayload,
} from '@haive/shared';
import { HttpError, type AppEnv } from '../context.js';
import { z } from 'zod';
import {
  CLAUDE_USAGE_OAUTH_SECRET,
  buildClaudeAuthorizeUrl,
  claudeTokensHaveUsageScope,
  createClaudePkceChallenge,
  exchangeClaudeAuthCode,
  parseClaudeAuthCode,
} from '@haive/shared/claude-oauth';
import { getDb } from '../db.js';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from '../lib/audit.js';
import { getRedis } from '../redis.js';
import { requireAuth } from '../middleware/auth.js';
import {
  admitNewWork,
  assertNewWorkAllowed,
  requireNewWorkAllowed,
} from '../middleware/maintenance.js';
import { getCliExecQueue, getUsagePollQueue } from '../queues.js';
import { enqueueCliVersionRefresh } from '../lib/cli-version-refresh.js';
import { loadPollableJob } from '../lib/cli-job-poll.js';

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

// A pin below a CLI's minRunnableVersion fails every run it is ever given, so it is refused here
// rather than discovered at the first task.
export function assertCliVersionRunnable(name: CliProviderName, version: string): void {
  if (isRunnableCliVersion(name, version)) return;
  throw new HttpError(
    400,
    `${CLI_PROVIDER_CATALOG[name].displayName} ${version} cannot run Haive's command line; pick ${CLI_INSTALL_METADATA[name].minRunnableVersion} or newer`,
    'cli_version_unsupported',
  );
}

// The picker offers only versions a run can use; the cached list stays raw, so a floor takes
// effect without waiting for the next refresh.
function runnableVersionsOf(name: string, versions: string[] | null): string[] {
  return (versions ?? []).filter((v) => isRunnableCliVersion(name as CliProviderName, v));
}

async function resolveCliVersionForSave(
  db: Database,
  name: CliProviderName,
  requested: string | null,
): Promise<string | null> {
  const meta = CLI_INSTALL_METADATA[name];
  if (!meta.versionPinnable) return null;
  if (requested) {
    assertCliVersionRunnable(name, requested);
    return requested;
  }
  const row = await db.query.cliPackageVersions.findFirst({
    where: eq(schema.cliPackageVersions.name, name),
  });
  return row?.latestVersion ?? null;
}

function assertOllamaHasModel(name: CliProviderName, model: string | null | undefined): void {
  if (name === 'ollama' && !model?.trim()) {
    throw new HttpError(
      400,
      'An ollama provider needs a model (set the model field).',
      'ollama_model_required',
    );
  }
}

// Drops any value the adapter does not declare. Adapters with no effort knob
// always store null so a stale UI cannot poison the column.
function resolveEffortLevelForSave(name: CliProviderName, requested: string | null): string | null {
  const scale = CLI_PROVIDER_CATALOG[name].effortScale;
  if (!scale) return null;
  if (requested === null) return null;
  return scale.values.includes(requested) ? requested : null;
}

// Reject auth modes the selected provider does not offer, mirroring the web
// form's option gating: the subscription option is shown only when
// defaultAuthMode !== 'api_key', and the api_key option only when apiKeyEnvName
// is set. This stops a stale or hand-crafted client from persisting an
// api-key-only provider (e.g. gemini, zai) back into subscription mode.
export function assertAuthModeSupported(
  name: CliProviderName,
  authMode: 'subscription' | 'api_key',
): void {
  const meta = CLI_PROVIDER_CATALOG[name];
  if (authMode === 'subscription' && meta.defaultAuthMode === 'api_key') {
    throw new HttpError(
      400,
      `${meta.displayName} does not support subscription (CLI login) authentication`,
      'auth_mode_unsupported',
    );
  }
  if (authMode === 'api_key' && meta.apiKeyEnvName === null) {
    throw new HttpError(
      400,
      `${meta.displayName} does not support API-key authentication`,
      'auth_mode_unsupported',
    );
  }
}

/** The caller has already written `building`, in the transaction that admitted the build. */
async function enqueueBuildForProvider(providerId: string, userId: string): Promise<void> {
  const payload: SandboxImageBuildJobPayload = { providerId, userId };
  const queue = getCliExecQueue();
  await queue.add(CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE, payload, {
    removeOnComplete: true,
    removeOnFail: CLI_POLLABLE_JOB_OPTS.removeOnFail,
  });
}

/** True when a provider has an in-stack Ollama model worth provisioning. Cloud
 *  (-cloud) models run on ollama.com and external remote daemons aren't ours to
 *  build, so both are skipped (the worker also re-checks and settles those to
 *  'idle'). */
function shouldProvisionOllamaModel(p: { name: string; model: string | null }): boolean {
  return p.name === 'ollama' && !!p.model && !isOllamaCloudModel(p.model);
}

/** Enqueue the worker job that pulls (or builds, when a Modelfile is set) a provider's
 *  model, so a new/edited Ollama model is ready without a worker restart. Mirrors
 *  enqueueBuildForProvider (sandbox image). */
async function enqueueOllamaProvisionForProvider(
  providerId: string,
  userId: string,
): Promise<void> {
  const payload: OllamaProvisionJobPayload = { providerId, userId };
  const queue = getCliExecQueue();
  await queue.add(CLI_EXEC_JOB_NAMES.PROVISION_OLLAMA_MODEL, payload, {
    removeOnComplete: true,
    removeOnFail: CLI_POLLABLE_JOB_OPTS.removeOnFail,
  });
}

export const cliProviderRoutes = new Hono<AppEnv>();
const log = logger.child({ module: 'cli-providers' });

/** `rulesInherited` lets the provider form show the live default, which follows template edits,
 *  instead of the possibly stale copy of it stored on the row. */
export function withRulesState<T extends { rulesContent: string }>(
  row: T,
): T & { rulesInherited: boolean } {
  return { ...row, rulesInherited: inheritsDefaultRules(row.rulesContent) };
}

cliProviderRoutes.use('*', requireAuth);

cliProviderRoutes.get('/catalog', async (c) => {
  const db = getDb();
  const versionRows = await db.query.cliPackageVersions.findMany();
  const versionMap = new Map<string, CliPackageVersionsEntry>();
  for (const row of versionRows) {
    versionMap.set(row.name, {
      name: row.name,
      versions: runnableVersionsOf(row.name, row.versions),
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
  // Parsed for the 400 on an unknown CLI name; the job itself refreshes every catalog entry.
  cliProviderNameSchema.parse(c.req.param('name'));
  const job = await enqueueCliVersionRefresh();
  if (!job.id) throw new HttpError(500, 'refresh was not queued', 'refresh_enqueue_failed');

  return c.json({ jobId: job.id }, 202);
});

/** Poll target for a refresh queued by POST /catalog/:name/refresh-versions. */
cliProviderRoutes.get('/catalog/:name/refresh-versions/:jobId', async (c) => {
  const name = cliProviderNameSchema.parse(c.req.param('name'));
  const jobId = c.req.param('jobId');
  const job = await loadPollableJob(jobId, CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS);

  const state = await job.getState();
  if (state === 'failed') {
    return c.json({ status: 'failed', error: job.failedReason || 'refresh failed' });
  }
  if (state !== 'completed') return c.json({ status: 'pending', state });

  // The job returns a summary across every CLI, while this route answers with one catalog
  // entry — so read the row the job just wrote, exactly as the blocking version did.
  const db = getDb();
  const row = await db.query.cliPackageVersions.findFirst({
    where: eq(schema.cliPackageVersions.name, name),
  });
  const entry: CliPackageVersionsEntry = row
    ? {
        name: row.name,
        versions: runnableVersionsOf(row.name, row.versions),
        latestVersion: row.latestVersion,
        fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
        fetchError: row.fetchError,
      }
    : { name, versions: [], latestVersion: null, fetchedAt: null, fetchError: null };
  // Only an admin gets the summary: /cli-pricing keeps its price and FX errors admin-only.
  if (c.get('userRole') !== 'admin') return c.json({ status: 'done', entry });
  // The summary rides along: the entry alone cannot say which other sources failed.
  return c.json({ status: 'done', entry, result: job.returnvalue as RefreshCliVersionsJobResult });
});

/** The cached OpenRouter model catalog, for the provider form's model picker.
 *
 *  Deliberately NOT folded into GET /catalog: that route is fetched on every settings
 *  page load, so adding 400+ models with pricing to it would be a large payload on a
 *  request that does not need it.
 *
 *  Degrades rather than fails. A missing row (never refreshed) answers with an empty
 *  list and a null fetchedAt, and the form falls back to a free-text model field —
 *  the picker is an affordance, never a gate on creating a provider. `fetchError`
 *  and `fetchedAt` are returned so the UI can say the list is stale instead of
 *  silently showing an old one. */
cliProviderRoutes.get('/openrouter/models', async (c) => {
  const db = getDb();
  const row = await db.query.openrouterModelCache.findFirst({
    where: eq(schema.openrouterModelCache.name, 'openrouter'),
  });
  return c.json({
    models: row?.models ?? [],
    fetchedAt: row?.fetchedAt ? row.fetchedAt.toISOString() : null,
    fetchError: row?.fetchError ?? null,
  });
});

cliProviderRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    orderBy: [desc(schema.cliProviders.createdAt), asc(schema.cliProviders.id)],
  });
  // Attach each provider's adapter effortScale (the per-CLI reasoning levels, or
  // null for knob-less CLIs) so the task UI can populate the per-step effort
  // dropdown and hide it for CLIs without an effort knob.
  const providers = rows.map((p) => ({
    ...withRulesState(p),
    effortScale: CLI_PROVIDER_CATALOG[p.name].effortScale,
  }));
  return c.json({ providers, defaultProviderId: resolveDefaultCliProvider(rows)?.id ?? null });
});

cliProviderRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const row = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
  });
  if (!row) throw new HttpError(404, 'CLI provider not found');
  return c.json({ provider: withRulesState(row) });
});

cliProviderRoutes.post('/', requireNewWorkAllowed, async (c) => {
  const userId = c.get('userId');
  const body = createCliProviderRequestSchema.parse(await c.req.json());
  const meta = CLI_PROVIDER_CATALOG[body.name];
  assertAuthModeSupported(body.name, body.authMode);
  assertOllamaHasModel(body.name, body.model);

  const db = getDb();
  const resolvedVersion = await resolveCliVersionForSave(
    db,
    body.name,
    body.cliVersion?.trim() || null,
  );
  const split = body.envVars ? splitSecretLikeEnv(body.envVars) : null;
  const model = body.model?.trim() || null;
  const provisioningModel = shouldProvisionOllamaModel({ name: body.name, model });
  let secretEvent: AuditEvent | undefined;
  const inserted = await db.transaction(async (tx) => {
    await admitNewWork(tx);
    const rows = await tx
      .insert(schema.cliProviders)
      .values({
        userId,
        name: body.name,
        label: body.label,
        executablePath: body.executablePath?.trim() || null,
        wrapperPath: body.wrapperPath?.trim() || null,
        wrapperContent: body.wrapperContent?.length ? body.wrapperContent : null,
        envVars: split?.envVars ?? null,
        cliArgs: body.cliArgs ? normalizeCliArgsArray(body.cliArgs) : null,
        supportsSubagents: meta.supportsSubagents,
        networkPolicy: body.networkPolicy ?? { mode: 'full', domains: [], ips: [] },
        egressDomains: body.egressDomains ?? [],
        authMode: body.authMode,
        cliVersion: resolvedVersion,
        effortLevel: resolveEffortLevelForSave(body.name, body.effortLevel ?? null),
        model,
        modelfile: body.modelfile?.trim() || null,
        sandboxDockerfileExtra: body.sandboxDockerfileExtra?.length
          ? body.sandboxDockerfileExtra
          : null,
        enabled: body.enabled ?? true,
        isolateAuth: body.isolateAuth ?? false,
        disableThinking: body.disableThinking ?? false,
        rulesContent: body.rulesContent ?? DEFAULT_AGENT_RULES,
        sandboxImageBuildStatus: 'building',
        ...(provisioningModel ? { modelProvisionStatus: 'provisioning' } : {}),
      })
      .returning();
    for (const [name, value] of Object.entries(split?.secrets ?? {})) {
      await upsertProviderSecret(tx, {
        providerId: rows[0]!.id,
        name,
        value,
        masterKek: await secretsService.getMasterKek(),
        onExisting: 'overwrite',
      });
    }
    if (Object.keys(split?.secrets ?? {}).length > 0) {
      secretEvent = {
        actorUserId: userId,
        action: 'cli_provider.secret.set',
        targetType: 'cli_provider',
        targetId: rows[0]!.id,
        metadata: {
          source: 'environment',
          secretCount: Object.keys(split?.secrets ?? {}).length,
          secretNames: Object.keys(split?.secrets ?? {}).sort(),
        },
      };
      await insertAuditEvent(tx, secretEvent);
    }
    return rows;
  });

  const created = inserted[0]!;
  if (secretEvent) logAuditEvent(secretEvent);
  await enqueueBuildForProvider(created.id, userId);
  if (provisioningModel) await enqueueOllamaProvisionForProvider(created.id, userId);
  return c.json(
    {
      provider: {
        ...withRulesState(created),
        sandboxImageBuildStatus: 'building' as const,
        ...(provisioningModel
          ? { modelProvisionStatus: 'provisioning' as const, modelProvisionError: null }
          : {}),
      },
    },
    201,
  );
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

  if (body.authMode !== undefined) {
    assertAuthModeSupported(existing.name, body.authMode);
  }

  if (body.model !== undefined) assertOllamaHasModel(existing.name, body.model);

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
  const split = body.envVars !== undefined ? splitSecretLikeEnv(body.envVars) : null;
  if (split) updates.envVars = split.envVars;
  if (body.cliArgs !== undefined) updates.cliArgs = normalizeCliArgsArray(body.cliArgs);
  if (body.authMode !== undefined) updates.authMode = body.authMode;
  if (body.networkPolicy !== undefined) updates.networkPolicy = body.networkPolicy;
  if (body.egressDomains !== undefined) updates.egressDomains = body.egressDomains;

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
  // Model is resolved at dispatch, not baked into the sandbox image — do not set
  // imageInputsChanged for it. But a changed model/Modelfile must be
  // (re)provisioned on the in-stack daemon (pull/build) without a restart.
  let modelInputsChanged = false;
  if (body.model !== undefined) {
    const nextModel = body.model?.trim() || null;
    if (nextModel !== existing.model) modelInputsChanged = true;
    updates.model = nextModel;
  }
  if (body.modelfile !== undefined) {
    const nextModelfile = body.modelfile?.trim() || null;
    if (nextModelfile !== existing.modelfile) modelInputsChanged = true;
    updates.modelfile = nextModelfile;
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;
  if (body.isolateAuth !== undefined) updates.isolateAuth = body.isolateAuth;
  if (body.disableThinking !== undefined) updates.disableThinking = body.disableThinking;
  if (body.rulesContent !== undefined) updates.rulesContent = body.rulesContent;
  // Discard the worker's learned model limitations. Only ever clears — the values
  // themselves are written by the worker from observed failures, never by the client.
  if (body.clearModelLimits) updates.modelLimits = null;

  const model = updates.model === undefined ? existing.model : updates.model;
  const provisioningModel =
    modelInputsChanged && shouldProvisionOllamaModel({ name: existing.name, model });
  const startsJob = imageInputsChanged || provisioningModel;
  if (startsJob) {
    await assertNewWorkAllowed();
    if (imageInputsChanged) {
      updates.sandboxImageBuildStatus = 'building';
      updates.sandboxImageBuildError = null;
    }
    if (provisioningModel) {
      updates.modelProvisionStatus = 'provisioning';
      updates.modelProvisionError = null;
    }
  }

  const secretEvent: AuditEvent | undefined = Object.keys(split?.secrets ?? {}).length
    ? {
        actorUserId: userId,
        action: 'cli_provider.secret.set',
        targetType: 'cli_provider',
        targetId: id,
        metadata: {
          source: 'environment',
          secretCount: Object.keys(split?.secrets ?? {}).length,
          secretNames: Object.keys(split?.secrets ?? {}).sort(),
        },
      }
    : undefined;
  const updated = await db.transaction(async (tx) => {
    if (startsJob) await admitNewWork(tx);
    const rows = await tx
      .update(schema.cliProviders)
      .set(updates)
      .where(eq(schema.cliProviders.id, id))
      .returning();
    for (const [name, value] of Object.entries(split?.secrets ?? {})) {
      await upsertProviderSecret(tx, {
        providerId: id,
        name,
        value,
        masterKek: await secretsService.getMasterKek(),
        onExisting: 'overwrite',
      });
    }
    if (secretEvent) await insertAuditEvent(tx, secretEvent);
    return rows;
  });
  const updatedRow = updated[0]!;
  if (secretEvent) logAuditEvent(secretEvent);

  if (provisioningModel) await enqueueOllamaProvisionForProvider(id, userId);
  const modelStatusOverride = provisioningModel
    ? { modelProvisionStatus: 'provisioning' as const, modelProvisionError: null }
    : {};

  if (imageInputsChanged) {
    await enqueueBuildForProvider(id, userId);
    return c.json({
      provider: {
        ...withRulesState(updatedRow),
        sandboxImageBuildStatus: 'building' as const,
        sandboxImageBuildError: null,
        ...modelStatusOverride,
      },
    });
  }

  return c.json({ provider: { ...withRulesState(updatedRow), ...modelStatusOverride } });
});

cliProviderRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const event: AuditEvent = {
    actorUserId: userId,
    action: 'cli_provider.delete',
    targetType: 'cli_provider',
    targetId: id,
  };
  const result = await db.transaction(async (tx) => {
    const result = await tx
      .delete(schema.cliProviders)
      .where(and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)))
      .returning({ id: schema.cliProviders.id, imageTag: schema.cliProviders.sandboxImageTag });
    if (result.length === 0) throw new HttpError(404, 'CLI provider not found');
    await insertAuditEvent(tx, event);
    return result;
  });
  logAuditEvent(event);
  const imageTag = result[0]!.imageTag;
  if (imageTag) {
    const payload: SandboxImageRemoveJobPayload = { providerId: id, imageTag };
    // The provider is gone either way, and a removal never queued only leaves its image behind.
    // Not awaited: the queue waits for redis rather than failing, which would hold this answer.
    void getCliExecQueue()
      .add(CLI_EXEC_JOB_NAMES.REMOVE_SANDBOX_IMAGE, payload, {
        removeOnComplete: true,
        removeOnFail: CLI_POLLABLE_JOB_OPTS.removeOnFail,
      })
      .catch((err: unknown) =>
        log.warn({ err, providerId: id, imageTag }, 'could not queue the sandbox image removal'),
      );
  }
  return c.json({ ok: true });
});

cliProviderRoutes.post('/:id/sandbox-image/build', requireNewWorkAllowed, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
    columns: { id: true },
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');

  await db.transaction(async (tx) => {
    await admitNewWork(tx);
    await tx
      .update(schema.cliProviders)
      .set({
        sandboxImageBuildStatus: 'building',
        sandboxImageBuildError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
  });

  const payload: SandboxImageBuildJobPayload = {
    providerId: provider.id,
    userId,
    force: true,
  };

  const queue = getCliExecQueue();
  await queue.add(CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE, payload, {
    removeOnComplete: true,
    removeOnFail: CLI_POLLABLE_JOB_OPTS.removeOnFail,
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

  const payload: CliProbeJobPayload = {
    providerId: provider.id,
    userId,
    targetMode: 'cli',
  };

  const queue = getCliExecQueue();
  const job = await queue.add(CLI_EXEC_JOB_NAMES.PROBE, payload, CLI_POLLABLE_JOB_OPTS);
  if (!job.id) throw new HttpError(500, 'probe was not queued', 'probe_enqueue_failed');

  return c.json({ jobId: job.id }, 202);
});

/** Poll target for a probe queued by POST /:id/test.
 *
 *  The probe shares `cli-exec-queue` with agent invocations and cannot preempt one, so it
 *  routinely sits queued for minutes behind multi-minute CLI runs. This used to be awaited
 *  inside the POST with a 30s deadline, which turned "the queue is busy" into a 504 that read
 *  as "this provider is broken" — observed against a provider that then probed OK 8s later. */
cliProviderRoutes.get('/:id/test/:jobId', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const jobId = c.req.param('jobId');
  const db = getDb();
  await loadOwnedProvider(db, userId, id);

  const job = await loadPollableJob(jobId, CLI_EXEC_JOB_NAMES.PROBE, {
    providerId: id,
    userId,
  });

  const state = await job.getState();
  if (state === 'completed') {
    return c.json({ status: 'done', result: job.returnvalue as CliProbeResult });
  }
  if (state === 'failed') {
    return c.json({ status: 'failed', error: job.failedReason || 'probe failed' });
  }
  return c.json({ status: 'pending', state });
});

cliProviderRoutes.post('/:id/sign-out', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
    columns: { id: true },
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');

  const payload: CliSignOutJobPayload = { providerId: provider.id, userId };
  const queue = getCliExecQueue();
  const job = await queue.add(CLI_EXEC_JOB_NAMES.SIGN_OUT, payload, CLI_POLLABLE_JOB_OPTS);
  if (!job.id) throw new HttpError(500, 'sign-out was not queued', 'sign_out_enqueue_failed');

  return c.json({ jobId: job.id }, 202);
});

/** Poll target for a sign-out queued by POST /:id/sign-out. Queued on the same shared
 *  cli-exec queue as the agent invocations, so the same minutes-long wait applies. */
cliProviderRoutes.get('/:id/sign-out/:jobId', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const jobId = c.req.param('jobId');
  const db = getDb();
  await loadOwnedProvider(db, userId, id);

  const job = await loadPollableJob(jobId, CLI_EXEC_JOB_NAMES.SIGN_OUT, {
    providerId: id,
    userId,
  });

  const state = await job.getState();
  if (state === 'completed') {
    return c.json({ status: 'done', result: job.returnvalue as CliSignOutJobResult });
  }
  if (state === 'failed') {
    return c.json({ status: 'failed', error: job.failedReason || 'sign-out failed' });
  }
  return c.json({ status: 'pending', state });
});

cliProviderRoutes.post('/:id/clone', requireNewWorkAllowed, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const source = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, id), eq(schema.cliProviders.userId, userId)),
  });
  if (!source) throw new HttpError(404, 'CLI provider not found');
  assertOllamaHasModel(source.name, source.model);

  const newLabel = await nextAvailableCloneLabel(db, userId, source.label);

  // A source saved before the split still holds secret-looking keys in envVars; the clone does not.
  const split = splitSecretLikeEnv(source.envVars ?? {});
  const provisioningModel = shouldProvisionOllamaModel(source);
  let cloneEvent: AuditEvent;
  const created = await db.transaction(async (tx) => {
    await admitNewWork(tx);
    const inserted = await tx
      .insert(schema.cliProviders)
      .values({
        userId: source.userId,
        name: source.name,
        label: newLabel,
        executablePath: source.executablePath,
        wrapperPath: source.wrapperPath,
        wrapperContent: source.wrapperContent,
        envVars: source.envVars ? split.envVars : null,
        cliArgs: source.cliArgs,
        supportsSubagents: source.supportsSubagents,
        networkPolicy: source.networkPolicy,
        egressDomains: source.egressDomains,
        authMode: source.authMode,
        cliVersion: source.cliVersion,
        effortLevel: source.effortLevel,
        model: source.model,
        modelfile: source.modelfile,
        sandboxDockerfileExtra: source.sandboxDockerfileExtra,
        enabled: source.enabled,
        isolateAuth: source.isolateAuth,
        disableThinking: source.disableThinking,
        rulesContent: source.rulesContent,
        sandboxImageBuildStatus: 'building',
        ...(provisioningModel ? { modelProvisionStatus: 'provisioning' } : {}),
      })
      .returning();
    const row = inserted[0]!;

    const sourceSecrets = await tx.query.cliProviderSecrets.findMany({
      where: eq(schema.cliProviderSecrets.providerId, source.id),
    });
    if (sourceSecrets.length > 0) {
      await tx.insert(schema.cliProviderSecrets).values(
        sourceSecrets.map((s) => ({
          providerId: row.id,
          secretName: s.secretName,
          encryptedValue: s.encryptedValue,
          encryptedDek: s.encryptedDek,
          fingerprint: s.fingerprint,
        })),
      );
    }
    const copied = new Set(sourceSecrets.map((s) => s.secretName));
    for (const [name, value] of Object.entries(split.secrets)) {
      if (!copied.has(name)) {
        await upsertProviderSecret(tx, {
          providerId: row.id,
          name,
          value,
          masterKek: await secretsService.getMasterKek(),
          onExisting: 'overwrite',
        });
      }
    }
    cloneEvent = {
      actorUserId: userId,
      action: 'cli_provider.clone',
      targetType: 'cli_provider',
      targetId: row.id,
      metadata: {
        sourceProviderId: source.id,
        secretNames: [
          ...new Set([...sourceSecrets.map((s) => s.secretName), ...Object.keys(split.secrets)]),
        ].sort(),
      },
    };
    await insertAuditEvent(tx, cloneEvent);
    return row;
  });

  logAuditEvent(cloneEvent!);
  await enqueueBuildForProvider(created.id, userId);
  if (provisioningModel) await enqueueOllamaProvisionForProvider(created.id, userId);
  return c.json(
    {
      provider: {
        ...withRulesState(created),
        sandboxImageBuildStatus: 'building' as const,
        ...(provisioningModel
          ? { modelProvisionStatus: 'provisioning' as const, modelProvisionError: null }
          : {}),
      },
    },
    201,
  );
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

  const existing = await db.query.cliProviderSecrets.findFirst({
    where: and(
      eq(schema.cliProviderSecrets.providerId, providerId),
      eq(schema.cliProviderSecrets.secretName, body.secretName),
    ),
    columns: { id: true },
  });
  const event: AuditEvent = {
    actorUserId: userId,
    action: 'cli_provider.secret.set',
    targetType: 'cli_provider',
    targetId: providerId,
    metadata: { source: 'manual', secretName: body.secretName },
  };
  const masterKek = await secretsService.getMasterKek();
  const secret = await db.transaction(async (tx) => {
    await insertAuditEvent(tx, event);
    const secret = await upsertProviderSecret(tx, {
      providerId,
      name: body.secretName,
      value: body.value,
      masterKek,
      onExisting: 'overwrite',
    });
    return secret;
  });
  logAuditEvent(event);
  return existing ? c.json({ secret }) : c.json({ secret }, 201);
});

// ---- Claude usage-tracking OAuth (PKCE) ----
// Mints a user:profile-scoped token for GET /api/oauth/usage, stored as the
// CLAUDE_USAGE_OAUTH secret. Separate from CLAUDE_CODE_OAUTH_TOKEN (the setup-token
// used to RUN claude, which is user:inference-only and 403s on the usage endpoint).
// Pure server-side OAuth: the user authorizes in their own browser and pastes back the
// code#state the callback page shows — no container, no claude binary, no TUI driving.
const USAGE_AUTH_STATE_TTL_S = 600; // 10 min for the browser round-trip
const usageAuthCompleteSchema = z.object({ code: z.string().min(1) });

function usageAuthStateKey(userId: string, providerId: string): string {
  return `usage-auth:claude:${userId}:${providerId}`;
}

// Compare and delete in one script: two completes cannot both take it; a wrong state keeps it.
const TAKE_USAGE_AUTH_STASH_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
if cjson.decode(raw).state ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return raw`;

cliProviderRoutes.post('/:providerId/usage-auth/start', async (c) => {
  const userId = c.get('userId');
  const providerId = c.req.param('providerId');
  const db = getDb();
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)),
    columns: { id: true, name: true },
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');
  if (provider.name !== 'claude-code') {
    throw new HttpError(400, 'Usage tracking auth is only available for Claude Code providers');
  }
  const { verifier, challenge, state } = createClaudePkceChallenge();
  await getRedis().set(
    usageAuthStateKey(userId, providerId),
    JSON.stringify({ verifier, state }),
    'EX',
    USAGE_AUTH_STATE_TTL_S,
  );
  return c.json({ authorizeUrl: buildClaudeAuthorizeUrl(challenge, state) });
});

cliProviderRoutes.post('/:providerId/usage-auth/complete', async (c) => {
  const userId = c.get('userId');
  const providerId = c.req.param('providerId');
  const body = usageAuthCompleteSchema.parse(await c.req.json());
  const db = getDb();
  await loadOwnedProvider(db, userId, providerId);

  const { code, state } = parseClaudeAuthCode(body.code);
  if (!state) {
    throw new HttpError(
      400,
      'The pasted code is missing its state part; copy the whole code, including the part after #.',
    );
  }
  const taken = (await getRedis().eval(
    TAKE_USAGE_AUTH_STASH_SCRIPT,
    1,
    usageAuthStateKey(userId, providerId),
    state,
  )) as string | 0 | null;
  if (taken === null) {
    throw new HttpError(400, 'Authorization expired or not started; please restart.');
  }
  if (taken === 0) {
    throw new HttpError(
      400,
      'The pasted code belongs to a different authorization; paste the code from this one, or restart it.',
    );
  }
  const { verifier } = JSON.parse(taken) as { verifier: string };
  const event: AuditEvent = {
    actorUserId: userId,
    action: 'cli_provider.secret.set',
    targetType: 'cli_provider',
    targetId: providerId,
    metadata: { source: 'usage_oauth', secretName: CLAUDE_USAGE_OAUTH_SECRET },
  };
  const masterKek = await secretsService.getMasterKek();
  const tokens = await db.transaction(async (tx) => {
    await insertAuditEvent(tx, event);
    let tokens;
    try {
      tokens = await exchangeClaudeAuthCode(code, verifier, state);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'Token exchange failed');
    }
    if (!claudeTokensHaveUsageScope(tokens)) {
      throw new HttpError(
        400,
        'The granted token is missing the user:profile scope required for usage tracking.',
      );
    }
    await upsertProviderSecret(tx, {
      providerId,
      name: CLAUDE_USAGE_OAUTH_SECRET,
      value: JSON.stringify(tokens),
      masterKek,
      onExisting: 'overwrite',
    });
    return tokens;
  });
  logAuditEvent(event);
  // Kick an immediate usage poll so the header meter refreshes within seconds instead of
  // waiting for the ~5-min repeatable tick: the freshly rotated token clears the worker's
  // dead-token gate and this poll overwrites the needs_reconnect snapshot with a live one.
  await getUsagePollQueue()
    .add('usage-poll-tick', {}, { removeOnComplete: true, removeOnFail: 10 })
    .catch(() => {});
  return c.json({ connected: true, scopes: tokens.scopes, expiresAt: tokens.expiresAt });
});

// Connection status for the UI. Presence of the secret = connected; we don't decrypt
// just to report it (a revoked token surfaces later as an error usage-snapshot).
cliProviderRoutes.get('/:providerId/usage-auth', async (c) => {
  const userId = c.get('userId');
  const providerId = c.req.param('providerId');
  const db = getDb();
  await loadOwnedProvider(db, userId, providerId);
  const row = await db.query.cliProviderSecrets.findFirst({
    where: and(
      eq(schema.cliProviderSecrets.providerId, providerId),
      eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET),
    ),
    columns: { updatedAt: true },
  });
  return c.json({ connected: !!row, connectedAt: row?.updatedAt ?? null });
});

cliProviderRoutes.delete('/:providerId/usage-auth', async (c) => {
  const userId = c.get('userId');
  const providerId = c.req.param('providerId');
  const db = getDb();
  await loadOwnedProvider(db, userId, providerId);
  const event: AuditEvent = {
    actorUserId: userId,
    action: 'cli_provider.secret.delete',
    targetType: 'cli_provider',
    targetId: providerId,
    metadata: { source: 'usage_oauth', secretName: CLAUDE_USAGE_OAUTH_SECRET },
  };
  const deleted = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(schema.cliProviderSecrets)
      .where(
        and(
          eq(schema.cliProviderSecrets.providerId, providerId),
          eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET),
        ),
      )
      .returning({ id: schema.cliProviderSecrets.id });
    if (rows.length > 0) await insertAuditEvent(tx, event);
    // Drop the last usage snapshot too: with no token the poller will never touch this row
    // again, so a stale meter / needs_reconnect chip would otherwise linger indefinitely.
    await tx
      .delete(schema.usageWindowSnapshots)
      .where(eq(schema.usageWindowSnapshots.providerId, providerId));
    return rows.length > 0;
  });
  if (deleted) logAuditEvent(event);
  return c.json({ connected: false });
});

cliProviderRoutes.delete('/:providerId/secrets/:secretName', async (c) => {
  const userId = c.get('userId');
  const providerId = c.req.param('providerId');
  const secretName = c.req.param('secretName');
  const db = getDb();
  await loadOwnedProvider(db, userId, providerId);

  const event: AuditEvent = {
    actorUserId: userId,
    action: 'cli_provider.secret.delete',
    targetType: 'cli_provider',
    targetId: providerId,
    metadata: { source: 'manual', secretName },
  };
  await db.transaction(async (tx) => {
    const result = await tx
      .delete(schema.cliProviderSecrets)
      .where(
        and(
          eq(schema.cliProviderSecrets.providerId, providerId),
          eq(schema.cliProviderSecrets.secretName, secretName),
        ),
      )
      .returning({ id: schema.cliProviderSecrets.id });
    if (result.length === 0) throw new HttpError(404, 'Secret not found');
    await insertAuditEvent(tx, event);
  });
  logAuditEvent(event);
  return c.json({ ok: true });
});
