import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';

const log = logger.child({ module: 'ollama-provision' });

// The worker reaches the in-stack Ollama daemon over haive-network at this URL
// (the same daemon sandboxes reach over haive-models). Matches the OllamaAdapter
// default and the onboarding 'internal' tooling URL.
const IN_STACK_OLLAMA_URL = 'http://ollama:11434';
const IN_STACK_HOSTS = new Set(['ollama', 'haive-ollama']);
// Model pulls can be many GB; give them room. Best-effort, so a stuck pull just
// times out and is retried on the next boot.
const PULL_TIMEOUT_MS = 30 * 60_000;

/** True when a provider's ANTHROPIC_BASE_URL targets the in-stack daemon, so the
 *  worker can pull its model. Cloud (ollama.com) and external remotes are
 *  skipped: the worker neither owns nor should mutate their model store, and
 *  cloud models are not "pulled". */
function isInStackBaseUrl(baseUrl: string | undefined): boolean {
  const url = baseUrl ?? IN_STACK_OLLAMA_URL;
  try {
    return IN_STACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

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

/** Pull a model into the daemon, consuming the NDJSON stream to completion.
 *  Idempotent: re-pulling a present model is a fast no-op. Throws on an {error}
 *  line or a non-2xx response. Mirrors the API's /pull-ollama-model consumer. */
async function pullOllamaModel(url: string, model: string): Promise<void> {
  const resp = await fetch(`${url}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`/api/pull HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('no response body from /api/pull');
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

/** Pull each enabled in-stack Ollama provider's declared model so a fresh stack
 *  is usable without a manual pull. Best-effort and idempotent (skips models
 *  already resident; re-pull is a no-op). Cloud/remote providers are skipped.
 *  Never throws — callers fire-and-forget on boot. */
export async function ensureOllamaModels(db: Database): Promise<void> {
  const providers = await db.query.cliProviders.findMany({
    where: and(eq(schema.cliProviders.name, 'ollama'), eq(schema.cliProviders.enabled, true)),
    columns: { id: true, label: true, model: true, envVars: true },
  });

  const models = new Set<string>();
  for (const p of providers) {
    const baseUrl = (p.envVars as Record<string, string> | null)?.ANTHROPIC_BASE_URL;
    if (!isInStackBaseUrl(baseUrl)) continue;
    if (!p.model) {
      log.warn({ providerId: p.id, label: p.label }, 'ollama provider has no model; skipping pull');
      continue;
    }
    models.add(p.model);
  }
  if (models.size === 0) return;

  let present: Set<string>;
  try {
    present = await listOllamaModels(IN_STACK_OLLAMA_URL);
  } catch (err) {
    log.warn({ err }, 'could not list ollama models; attempting pulls anyway');
    present = new Set();
  }

  for (const model of models) {
    if (present.has(model)) {
      log.info({ model }, 'ollama model already present; skipping pull');
      continue;
    }
    log.info({ model }, 'pulling ollama model');
    try {
      await pullOllamaModel(IN_STACK_OLLAMA_URL, model);
      log.info({ model }, 'ollama model pull complete');
    } catch (err) {
      log.warn({ err, model }, 'ollama model pull failed');
    }
  }
}
