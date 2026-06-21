import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const OLLAMA_TIMEOUT_MS = 60_000;
export const EMBED_BATCH_SIZE = 8;
/** Sent on every embed so Ollama keeps the model resident between batches (and
 *  after warmup) instead of unloading it (default 5m) and reloading cold. */
export const OLLAMA_KEEP_ALIVE = '30m';
/** Generous timeout for the one-off warmup call: a cold multi-billion-parameter
 *  embedding model on CPU can take far longer to LOAD than a normal embed's
 *  timeout, so the load must be given room to finish once. */
export const OLLAMA_WARMUP_TIMEOUT_MS = 300_000;

/* ------------------------------------------------------------------ */
/* Ollama connectivity                                                 */
/* ------------------------------------------------------------------ */

export async function probeOllama(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function ollamaEmbed(
  url: string,
  model: string,
  inputs: string[],
): Promise<number[][]> {
  const resp = await fetch(`${url}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: inputs, keep_alive: OLLAMA_KEEP_ALIVE }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Ollama embed failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { embeddings?: number[][] };
  if (!data.embeddings || data.embeddings.length === 0) {
    throw new Error('Ollama returned no embeddings');
  }
  return data.embeddings;
}

/** Preload an embedding model so it is resident before a populate run. A cold
 *  model can take longer to load than a single embed's timeout — without this,
 *  every batch would abort and fall back to (weak) hash embeddings. Loads it once
 *  with a generous timeout and a long keep_alive; subsequent embeds are warm and
 *  fast. Best-effort: returns false on any failure (caller proceeds regardless). */
export async function warmOllamaModel(
  url: string,
  model: string,
  timeoutMs: number = OLLAMA_WARMUP_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'warmup', keep_alive: OLLAMA_KEEP_ALIVE }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Evict an embedding model from Ollama immediately (keep_alive:0) so its
 *  VRAM/RAM is freed for other processes (games etc.) once Haive is idle.
 *  Sends a tiny non-empty input — `/api/embed` can reject an empty input,
 *  which would skip the unload — with keep_alive:0 so the model is dropped
 *  right after. Best-effort: returns false on any failure (the model also
 *  self-unloads once its keep_alive window lapses, so a miss is not fatal). */
export async function unloadOllamaModel(
  url: string,
  model: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'unload', keep_alive: 0 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** List the models Ollama currently holds resident (loaded in VRAM/RAM) via
 *  `/api/ps`. Eviction must gate on this: `unloadOllamaModel` sends a dummy embed
 *  with keep_alive:0, which would LOAD a non-resident model just to unload it — the
 *  opposite of intent. Returns the resident model identifiers (both the `name` and
 *  `model` fields, deduped, since callers may hold either form). Returns null when
 *  Ollama is unreachable, distinguishing "down" from "up but nothing loaded" ([]). */
export async function listResidentOllamaModels(
  url: string,
  timeoutMs = 5000,
): Promise<string[] | null> {
  try {
    const resp = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = new Set<string>();
    for (const m of data.models ?? []) {
      if (m.name) names.add(m.name);
      if (m.model) names.add(m.model);
    }
    return Array.from(names);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic hash embedding fallback                               */
/* ------------------------------------------------------------------ */

export function hashEmbed(text: string, dimensions: number): number[] {
  const out = new Array<number>(dimensions).fill(0);
  let blockIndex = 0;
  let produced = 0;
  while (produced < dimensions) {
    const hash = createHash('sha256').update(`${blockIndex}:${text}`).digest();
    for (let i = 0; i < hash.length && produced < dimensions; i += 2) {
      const raw = hash.readUInt16BE(i);
      out[produced] = raw / 65535 - 0.5;
      produced += 1;
    }
    blockIndex += 1;
  }
  let sumSq = 0;
  for (const v of out) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = out[i]! / norm;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Vector literal for pgvector INSERT                                  */
/* ------------------------------------------------------------------ */

export function vectorLiteral(values: number[]): string {
  return `[${values.map((v) => v.toFixed(6)).join(',')}]`;
}

/** Embed a single query string, falling back to the deterministic hash
 *  embedding when Ollama is unreachable or errors. Mirrors the populate
 *  path's behaviour so query vectors live in the same space as stored rows. */
export async function embedQuery(
  text: string,
  opts: { ollamaUrl: string | null; model: string | null; dimensions: number },
): Promise<number[]> {
  const { ollamaUrl, model, dimensions } = opts;
  if (ollamaUrl && model) {
    try {
      const [vec] = await ollamaEmbed(ollamaUrl, model, [text]);
      if (vec && vec.length > 0) return vec;
    } catch {
      // fall through to hash embedding
    }
  }
  return hashEmbed(text, dimensions);
}
