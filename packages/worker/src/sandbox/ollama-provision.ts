import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { isOllamaCloudModel } from '../cli-adapters/ollama.js';

const log = logger.child({ module: 'ollama-provision' });

// The worker reaches the in-stack Ollama daemon over haive-network at this URL
// (the same daemon sandboxes reach over haive-models). Matches the OllamaAdapter
// default and the onboarding 'internal' tooling URL.
const IN_STACK_OLLAMA_URL = 'http://ollama:11434';
const IN_STACK_HOSTS = new Set(['ollama', 'haive-ollama']);
// Pulls/builds can be many GB; give them room. Best-effort, so a stuck job just
// times out and is retried on the next boot.
const PROVISION_TIMEOUT_MS = 30 * 60_000;

/** True when a provider's ANTHROPIC_BASE_URL targets the in-stack daemon, so the
 *  worker can provision its model. Cloud (ollama.com) and external remotes are
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

type ModelfileParams = Record<string, string | number | (string | number)[]>;

export interface ParsedModelfile {
  from?: string;
  system?: string;
  template?: string;
  parameters: ModelfileParams;
}

/** Coerce a PARAMETER value: ints/floats become numbers (Ollama expects typed
 *  values, e.g. num_ctx), surrounding quotes are stripped, everything else stays
 *  a string. */
function coerceParamValue(raw: string): string | number {
  const v = raw.trim().replace(/^"(.*)"$/, '$1');
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

/** Parse an Ollama Modelfile into the structured fields /api/create expects (it
 *  rejects a raw Modelfile string). Supports FROM, SYSTEM, TEMPLATE (including
 *  multi-line triple-quoted blocks, which carry Go-template `{{ }}` verbatim),
 *  and PARAMETER (repeated keys collapse to an array, e.g. stop). Other
 *  directives (ADAPTER/LICENSE/MESSAGE) are ignored — out of scope for the
 *  no-upload path. */
export function parseModelfile(text: string): ParsedModelfile {
  const lines = text.split(/\r?\n/);
  const parameters: ModelfileParams = {};
  const result: ParsedModelfile = { parameters };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.search(/\s/);
    const directive = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();

    // Read a directive value that may be a triple-quoted multi-line block,
    // a single-quoted string, or a bare remainder. Advances `i` past a
    // multi-line block's closing delimiter.
    const readBlock = (): string => {
      if (rest.startsWith('"""')) {
        const afterOpen = rest.slice(3);
        const closeIdx = afterOpen.indexOf('"""');
        if (closeIdx !== -1) return afterOpen.slice(0, closeIdx);
        const buf = [afterOpen];
        i += 1;
        for (; i < lines.length; i += 1) {
          const l = lines[i]!;
          const idx = l.indexOf('"""');
          if (idx !== -1) {
            buf.push(l.slice(0, idx));
            break;
          }
          buf.push(l);
        }
        return buf.join('\n');
      }
      if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
      return rest;
    };

    switch (directive) {
      case 'FROM':
        result.from = rest;
        break;
      case 'SYSTEM':
        result.system = readBlock();
        break;
      case 'TEMPLATE':
        result.template = readBlock();
        break;
      case 'PARAMETER': {
        const m = rest.match(/^(\S+)\s+(.*)$/);
        if (!m) break;
        const key = m[1]!;
        const value = coerceParamValue(m[2]!);
        const existing = parameters[key];
        if (existing === undefined) parameters[key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else parameters[key] = [existing, value];
        break;
      }
      default:
        break; // ADAPTER / LICENSE / MESSAGE / unknown — ignored
    }
  }
  return result;
}

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

/** Provision each enabled in-stack Ollama provider's declared model so a fresh
 *  stack is usable without manual setup. A provider with a Modelfile is built
 *  via `ollama create`; otherwise the model name is pulled. Best-effort and
 *  idempotent (skips models already resident; editing a Modelfile rebuilds only
 *  when the model name changes or the model is deleted). Cloud/remote providers
 *  are skipped. Never throws — callers fire-and-forget on boot. */
export async function ensureOllamaModels(db: Database): Promise<void> {
  const providers = await db.query.cliProviders.findMany({
    where: and(eq(schema.cliProviders.name, 'ollama'), eq(schema.cliProviders.enabled, true)),
    columns: { id: true, label: true, model: true, modelfile: true, envVars: true },
  });

  // Distinct models targeting the in-stack daemon, each with its Modelfile (if any).
  const jobs = new Map<string, { model: string; modelfile: string | null }>();
  for (const p of providers) {
    const baseUrl = (p.envVars as Record<string, string> | null)?.ANTHROPIC_BASE_URL;
    if (!isInStackBaseUrl(baseUrl)) continue;
    if (!p.model) {
      log.warn({ providerId: p.id, label: p.label }, 'ollama provider has no model; skipping');
      continue;
    }
    // Cloud models run on Ollama Cloud (ollama.com), not the local daemon, so
    // there is nothing to pull or build for them here.
    if (isOllamaCloudModel(p.model)) continue;
    if (!jobs.has(p.model)) jobs.set(p.model, { model: p.model, modelfile: p.modelfile ?? null });
  }
  if (jobs.size === 0) return;

  let present: Set<string>;
  try {
    present = await listOllamaModels(IN_STACK_OLLAMA_URL);
  } catch (err) {
    log.warn({ err }, 'could not list ollama models; attempting provisioning anyway');
    present = new Set();
  }

  for (const { model, modelfile } of jobs.values()) {
    if (present.has(model)) {
      log.info({ model }, 'ollama model already present; skipping');
      continue;
    }
    try {
      if (modelfile) {
        log.info({ model }, 'building ollama model from Modelfile');
        await createOllamaModel(IN_STACK_OLLAMA_URL, model, modelfile);
        log.info({ model }, 'ollama model build complete');
      } else {
        log.info({ model }, 'pulling ollama model');
        await pullOllamaModel(IN_STACK_OLLAMA_URL, model);
        log.info({ model }, 'ollama model pull complete');
      }
    } catch (err) {
      log.warn({ err, model }, 'ollama model provisioning failed');
    }
  }
}
