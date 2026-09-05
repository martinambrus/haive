import { createHash } from 'node:crypto';
import { configService, CONFIG_KEYS } from '../config/config.service.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Fallback budgets, used verbatim when ConfigService is unavailable (see
 *  `resolveEmbedBudget`). Kept in step with the CONFIG_KEYS.RAG_EMBED_* entries
 *  in DEFAULTS — config.service.ts cannot import this module without a cycle, so
 *  the two literals are paired by comment rather than by reference. */
export const OLLAMA_TIMEOUT_MS = 240_000;
/** The interactive half. A query embed is one short input — MEASURED 0.44s on a
 *  CPU-only 8-core host — so it must never inherit the ingest budget: an agent
 *  waiting on rag_search is waiting on a tool call, not on a background job. */
export const OLLAMA_QUERY_TIMEOUT_MS = 20_000;
export const EMBED_BATCH_SIZE = 8;
/** Sent on every embed so Ollama keeps the model resident between batches (and
 *  after warmup) instead of unloading it (default 5m) and reloading cold. */
export const OLLAMA_KEEP_ALIVE = '30m';
/** Generous timeout for the one-off warmup call: a cold multi-billion-parameter
 *  embedding model on CPU can take far longer to LOAD than a normal embed's
 *  timeout, so the load must be given room to finish once. */
export const OLLAMA_WARMUP_TIMEOUT_MS = 300_000;

export interface EmbedBudget {
  /** Per-batch budget for bulk ingestion. */
  embedTimeoutMs: number;
  /** Per-call budget for an interactive query embed. */
  queryTimeoutMs: number;
  warmupTimeoutMs: number;
  batchSize: number;
  /** False = the pre-fix per-batch hash fallback. */
  strict: boolean;
}

/** Admin-tunable embedding budgets. Resolved per call — ConfigService caches
 *  locally for 30s, so this is cheap and a change takes effect on the next
 *  invocation rather than at the next worker boot.
 *
 *  Falls back to the constants above when ConfigService is not initialized:
 *  `packages/worker/scripts/rag-eval.ts` imports this module standalone, and a
 *  throw there would break a diagnostic script over a setting it does not use. */
export async function resolveEmbedBudget(): Promise<EmbedBudget> {
  try {
    const [embedTimeoutMs, queryTimeoutMs, warmupTimeoutMs, batchSize, strict] = await Promise.all([
      configService.getNumber(CONFIG_KEYS.RAG_EMBED_TIMEOUT_MS, OLLAMA_TIMEOUT_MS),
      configService.getNumber(CONFIG_KEYS.RAG_QUERY_EMBED_TIMEOUT_MS, OLLAMA_QUERY_TIMEOUT_MS),
      configService.getNumber(CONFIG_KEYS.RAG_EMBED_WARMUP_TIMEOUT_MS, OLLAMA_WARMUP_TIMEOUT_MS),
      configService.getNumber(CONFIG_KEYS.RAG_EMBED_BATCH_SIZE, EMBED_BATCH_SIZE),
      configService.getBoolean(CONFIG_KEYS.RAG_EMBED_STRICT_ENABLED, true),
    ]);
    // A zero or negative budget is a mis-set knob, not a request for an instant
    // abort — every embed would fail and (with strict off) hash-poison the index.
    return {
      embedTimeoutMs: embedTimeoutMs > 0 ? embedTimeoutMs : OLLAMA_TIMEOUT_MS,
      queryTimeoutMs: queryTimeoutMs > 0 ? queryTimeoutMs : OLLAMA_QUERY_TIMEOUT_MS,
      warmupTimeoutMs: warmupTimeoutMs > 0 ? warmupTimeoutMs : OLLAMA_WARMUP_TIMEOUT_MS,
      batchSize: batchSize > 0 ? batchSize : EMBED_BATCH_SIZE,
      strict,
    };
  } catch {
    return {
      embedTimeoutMs: OLLAMA_TIMEOUT_MS,
      queryTimeoutMs: OLLAMA_QUERY_TIMEOUT_MS,
      warmupTimeoutMs: OLLAMA_WARMUP_TIMEOUT_MS,
      batchSize: EMBED_BATCH_SIZE,
      strict: true,
    };
  }
}

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

/** `timeoutMs` omitted = the configured INGEST budget. Interactive callers must
 *  pass the query budget explicitly (`embedQuery` does); inheriting the ingest
 *  one would let a stalled search hold an agent's tool call for minutes. */
export async function ollamaEmbed(
  url: string,
  model: string,
  inputs: string[],
  opts: { timeoutMs?: number } = {},
): Promise<number[][]> {
  const timeoutMs = opts.timeoutMs ?? (await resolveEmbedBudget()).embedTimeoutMs;
  const resp = await fetch(`${url}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: inputs, keep_alive: OLLAMA_KEEP_ALIVE }),
    signal: AbortSignal.timeout(timeoutMs),
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
  timeoutMs?: number,
): Promise<boolean> {
  try {
    const budget = timeoutMs ?? (await resolveEmbedBudget()).warmupTimeoutMs;
    const resp = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'warmup', keep_alive: OLLAMA_KEEP_ALIVE }),
      signal: AbortSignal.timeout(budget),
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

export type EmbedDevicePlacement = 'gpu' | 'cpu' | 'not_resident' | 'unreachable';

/** Where Ollama actually loaded a model — GPU (VRAM) vs CPU (RAM). Reads `/api/ps`
 *  and inspects the model's `size_vram`: > 0 means layers are resident on the GPU,
 *  0 means a full CPU fallback. A CPU fallback while a GPU is present is the
 *  signature of a driver/runtime mismatch (e.g. the host GPU driver was upgraded
 *  without a reboot — `nvidia-smi` and the container runtime still pass, but
 *  `cuInit` fails, so Ollama silently loads on CPU and embeds far slower).
 *  Returns 'not_resident' when the model isn't loaded (caller can't conclude
 *  placement) and 'unreachable' when Ollama can't be reached. Never throws —
 *  mirrors listResidentOllamaModels. */
export async function getOllamaModelPlacement(
  url: string,
  model: string,
  timeoutMs = 5000,
): Promise<EmbedDevicePlacement> {
  try {
    const resp = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return 'unreachable';
    const data = (await resp.json()) as {
      models?: Array<{ name?: string; model?: string; size_vram?: number }>;
    };
    const m = (data.models ?? []).find((x) => x.name === model || x.model === model);
    if (!m) return 'not_resident';
    return (m.size_vram ?? 0) > 0 ? 'gpu' : 'cpu';
  } catch {
    return 'unreachable';
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

/** Cosine similarity of two embedding vectors, in [-1, 1]. Returns 0 when either
 *  vector is empty, the lengths differ, or a vector has zero magnitude — callers
 *  treat 0 as "no signal" so a degenerate input can never read as a false match. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Embed a single query string, falling back to the deterministic hash
 *  embedding when Ollama is unreachable or errors. Mirrors the populate
 *  path's behaviour so query vectors live in the same space as stored rows. */
export async function embedQuery(
  text: string,
  opts: { ollamaUrl: string | null; model: string | null; dimensions: number },
): Promise<number[]> {
  return (await embedQueryOrNull(text, opts)) ?? hashEmbed(text, opts.dimensions);
}

/** Embed a query, or return null when there is no usable vector — no endpoint
 *  configured, or the embed failed. Callers that can fall back to LEXICAL-ONLY
 *  search should prefer this over `embedQuery`: a hash vector is not a degraded
 *  embedding but noise, and feeding one into the dense half of the RRF fusion can
 *  push a genuine lexical hit down the ranking. `embedQuery` keeps the hash
 *  fallback for callers that must have a vector of the right width. */
export async function embedQueryOrNull(
  text: string,
  opts: { ollamaUrl: string | null; model: string | null; dimensions: number },
): Promise<number[] | null> {
  const { ollamaUrl, model } = opts;
  if (ollamaUrl && model) {
    try {
      const { queryTimeoutMs } = await resolveEmbedBudget();
      const [vec] = await ollamaEmbed(ollamaUrl, model, [text], { timeoutMs: queryTimeoutMs });
      if (vec && vec.length > 0) return vec;
    } catch {
      // fall through
    }
  }
  return null;
}
