import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const OLLAMA_TIMEOUT_MS = 30_000;
export const EMBED_BATCH_SIZE = 8;

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
    body: JSON.stringify({ model, input: inputs }),
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
