import { and, eq, ne, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { safeErrorMessage } from '@haive/shared/logger';
import {
  logger,
  isOllamaCloudModel,
  IN_STACK_OLLAMA_URL,
  isInStackOllamaBaseUrl,
  isOllamaModelAllowed,
  parseModelfile,
  configService,
  CONFIG_KEYS,
  OLLAMA_MODEL_NOT_ALLOWED_MESSAGE,
  type OllamaProvisionResult,
} from '@haive/shared';

const log = logger.child({ module: 'ollama-provision' });

// Pulls/builds can be many GB; give them room. Best-effort, so a stuck job just
// times out and is retried on the next boot.
const PROVISION_TIMEOUT_MS = 30 * 60_000;

/** Models currently resident in the daemon (both `name` and `model` aliases). */
async function listOllamaModels(url: string): Promise<Set<string>> {
  const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`/api/tags HTTP ${resp.status}`);
  const data = (await resp.json()) as { models?: { name?: string; model?: string }[] };
  const names = new Set<string>();
  for (const m of data.models ?? []) {
    if (m.name) names.add(m.name);
    if (m.model) names.add(m.model);
  }
  return names;
}

/** Consume an Ollama NDJSON progress stream to completion. Throws on a non-2xx
 *  response or any {error} line; ignores malformed/partial lines. Shared by the
 *  /api/pull and /api/create flows. */
async function consumeNdjsonStream(resp: Response, endpoint: string): Promise<void> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${endpoint} HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const reader = resp.body?.getReader();
  if (!reader) throw new Error(`no response body from ${endpoint}`);
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { status?: string; error?: string };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed/partial line
      }
      if (obj.error) throw new Error(obj.error);
    }
  }
}

/** Pull a model into the daemon. Idempotent: re-pulling a present model is a
 *  fast no-op. */
async function pullOllamaModel(url: string, model: string): Promise<void> {
  const resp = await fetch(`${url}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
  });
  await consumeNdjsonStream(resp, '/api/pull');
}

/* ------------------------------------------------------------------ */
/* Modelfile parsing                                                   */
/* ------------------------------------------------------------------ */

export { parseModelfile, type ParsedModelfile } from '@haive/shared';

/** Build a custom model on the daemon from a Modelfile via /api/create. The
 *  Modelfile is parsed to the structured body (the endpoint rejects a raw
 *  string). The FROM base is pulled by the daemon if not already resident. */
async function createOllamaModel(url: string, model: string, modelfileText: string): Promise<void> {
  const parsed = parseModelfile(modelfileText);
  if (!parsed.from) throw new Error('Modelfile must contain a FROM line');
  const body: Record<string, unknown> = { model, from: parsed.from, stream: true };
  if (parsed.system) body.system = parsed.system;
  if (parsed.template) body.template = parsed.template;
  if (Object.keys(parsed.parameters).length > 0) body.parameters = parsed.parameters;
  const resp = await fetch(`${url}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
  });
  await consumeNdjsonStream(resp, '/api/create');
}

/* ------------------------------------------------------------------ */
/* Boot provisioning                                                   */
/* ------------------------------------------------------------------ */

/** Persist a provider's model-provisioning status so the CLI provider form can
 *  reflect progress (and surface errors) without a worker restart. */
async function setProvisionStatus(
  db: Database,
  providerId: string,
  status: 'idle' | 'provisioning' | 'ready' | 'failed',
  error: string | null,
): Promise<void> {
  await db
    .update(schema.cliProviders)
    .set({ modelProvisionStatus: status, modelProvisionError: error, updatedAt: new Date() })
    .where(eq(schema.cliProviders.id, providerId));
}

/** Provision one provider's in-stack Ollama model: build it from a Modelfile (via
 *  /api/create) when set, otherwise pull it. Updates model_provision_status so the
 *  form shows progress. Idempotent (a resident model is left as-is). Cloud
 *  (-cloud) / external-remote / model-less providers are not ours to provision
 *  and settle to 'idle'. Never throws — failures land in model_provision_error.
 *  Shared by boot reconciliation and the on-save PROVISION_OLLAMA_MODEL job. */
export async function provisionOllamaProvider(
  db: Database,
  provider: {
    id: string;
    userId: string;
    model: string | null;
    modelfile: string | null;
    envVars: Record<string, string> | null;
  },
): Promise<OllamaProvisionResult> {
  const baseUrl = provider.envVars?.ANTHROPIC_BASE_URL;
  if (!provider.model || isOllamaCloudModel(provider.model) || !isInStackOllamaBaseUrl(baseUrl)) {
    await setProvisionStatus(db, provider.id, 'idle', null);
    return { ok: true, providerId: provider.id };
  }
  const model = provider.model;
  try {
    let present: Set<string>;
    try {
      present = await listOllamaModels(IN_STACK_OLLAMA_URL);
    } catch (err) {
      log.warn({ err }, 'could not list ollama models; attempting provisioning anyway');
      present = new Set();
    }
    if (!present.has(model)) {
      const owner = await db.query.users.findFirst({
        where: eq(schema.users.id, provider.userId),
        columns: { role: true },
      });
      if (owner?.role !== 'admin') {
        const policy = {
          embedModel: await configService.get(CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL),
          allowlist: null as string | null,
        };
        // /api/create pulls FROM, while model is only its output name.
        const from = provider.modelfile ? parseModelfile(provider.modelfile).from : undefined;
        const models = provider.modelfile ? (from ? [from] : []) : [model];
        if (models.some((candidate) => !isOllamaModelAllowed(owner?.role, candidate, policy))) {
          policy.allowlist = await configService.get(CONFIG_KEYS.OLLAMA_MODEL_ALLOWLIST);
        }
        const denied = models.find(
          (candidate) => !isOllamaModelAllowed(owner?.role, candidate, policy),
        );
        if (denied) {
          log.warn(
            { providerId: provider.id, model: denied },
            'skipping disallowed ollama model provisioning',
          );
          // A policy skip attempted no provisioning. Keep it idle rather than
          // persisting a failure that outlives the operator's policy decision.
          await setProvisionStatus(db, provider.id, 'idle', null);
          return {
            ok: false,
            providerId: provider.id,
            model,
            error: OLLAMA_MODEL_NOT_ALLOWED_MESSAGE,
          };
        }
      }
      await setProvisionStatus(db, provider.id, 'provisioning', null);
      if (provider.modelfile) {
        log.info({ model, providerId: provider.id }, 'building ollama model from Modelfile');
        await createOllamaModel(IN_STACK_OLLAMA_URL, model, provider.modelfile);
        log.info({ model, providerId: provider.id }, 'ollama model build complete');
      } else {
        log.info({ model, providerId: provider.id }, 'pulling ollama model');
        await pullOllamaModel(IN_STACK_OLLAMA_URL, model);
        log.info({ model, providerId: provider.id }, 'ollama model pull complete');
      }
    }
    await setProvisionStatus(db, provider.id, 'ready', null);
    return { ok: true, providerId: provider.id, model };
  } catch (err) {
    const message = safeErrorMessage(err);
    log.warn({ err, model, providerId: provider.id }, 'ollama model provisioning failed');
    await setProvisionStatus(db, provider.id, 'failed', message);
    return { ok: false, providerId: provider.id, model, error: message };
  }
}

/** Provision every enabled Ollama provider on boot so a fresh stack is usable
 *  without manual setup and model_provision_status is reconciled to reality.
 *  Best-effort + idempotent; never throws — callers fire-and-forget on boot. */
export async function ensureOllamaModels(db: Database): Promise<void> {
  const providers = await db.query.cliProviders.findMany({
    where: and(eq(schema.cliProviders.name, 'ollama'), eq(schema.cliProviders.enabled, true)),
    columns: { id: true, userId: true, model: true, modelfile: true, envVars: true },
  });
  for (const p of providers) {
    await provisionOllamaProvider(db, p).catch((err) =>
      log.warn({ err, providerId: p.id }, 'ensureOllamaModels: provision failed'),
    );
  }
}

/** After a task reaches a terminal state, immediately unload (keep_alive:0) the
 *  in-stack Ollama generative models its CLI invocations loaded, so GPU VRAM is
 *  freed at once instead of lingering for the daemon's keep_alive window. Skipped
 *  when another task is still live (it may need the model resident; keep_alive is
 *  the backstop there) and for cloud/remote models (nothing loads locally). The
 *  RAG embedding model is freed separately (maybeUnloadTaskEmbedModel). Never
 *  throws — it must not break the terminal transition. */
export async function unloadTaskOllamaCliModels(db: Database, taskId: string): Promise<void> {
  try {
    const rows = await db
      .select({ model: schema.cliProviders.model, envVars: schema.cliProviders.envVars })
      .from(schema.cliInvocations)
      .innerJoin(
        schema.cliProviders,
        eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId),
      )
      .where(and(eq(schema.cliInvocations.taskId, taskId), eq(schema.cliProviders.name, 'ollama')));
    const models = new Set<string>();
    for (const r of rows) {
      if (!r.model || isOllamaCloudModel(r.model)) continue;
      if (!isInStackOllamaBaseUrl(r.envVars?.ANTHROPIC_BASE_URL)) continue;
      models.add(r.model);
    }
    if (models.size === 0) return;
    for (const model of models) {
      // Keep a model resident only if another live task actually uses THIS model.
      // (A coarse "any live task" guard — like the shared embed model uses — would
      // wrongly pin this model whenever an unrelated task, e.g. on Claude Code, is
      // running.)
      const otherUsing = await db
        .select({ id: schema.tasks.id })
        .from(schema.cliInvocations)
        .innerJoin(
          schema.cliProviders,
          eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId),
        )
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
        .where(
          and(
            eq(schema.cliProviders.name, 'ollama'),
            eq(schema.cliProviders.model, model),
            ne(schema.tasks.id, taskId),
            notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
          ),
        )
        .limit(1);
      if (otherUsing.length > 0) {
        log.debug({ taskId, model }, 'skip ollama cli model unload — another live task uses it');
        continue;
      }
      try {
        const resp = await fetch(`${IN_STACK_OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: 0 }),
          signal: AbortSignal.timeout(10_000),
        });
        log.info({ taskId, model, ok: resp.ok }, 'requested ollama cli model unload');
      } catch (err) {
        log.warn({ err, taskId, model }, 'failed to unload ollama cli model');
      }
    }
  } catch (err) {
    log.warn({ err, taskId }, 'unloadTaskOllamaCliModels failed');
  }
}
