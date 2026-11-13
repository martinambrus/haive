import { z } from 'zod';
import { DEFAULT_EMBED_MODEL } from '../global-kb/connection.js';

export const OLLAMA_ALLOWLIST_LIMITS = { maxChars: 16_384, maxEntries: 256 } as const;
const DEFAULT_OLLAMA_REGISTRY = 'registry.ollama.ai';

/** Ollama ParseName defaults host, namespace and tag; Name.EqualFold compares all
 * four parts case-insensitively (types/model/name.go). Accept registry model names,
 * not URL schemes or wildcard patterns. Each part follows Ollama's ASCII grammar. */
export function normalizeOllamaModel(raw: string): string | null {
  let name = raw.trim();
  let tag = 'latest';
  if (name.lastIndexOf(':') > name.lastIndexOf('/')) {
    tag = name.slice(name.lastIndexOf(':') + 1);
    name = name.slice(0, name.lastIndexOf(':'));
  }
  const parts = name.split('/');
  if (parts.length > 3) return null;
  const model = parts.pop() ?? '';
  const namespace = parts.pop() ?? 'library';
  const host = parts.pop() ?? DEFAULT_OLLAMA_REGISTRY;
  if (
    !/^[a-z0-9_][a-z0-9_.:-]{0,349}$/i.test(host) ||
    !/^[a-z0-9_][a-z0-9_-]{0,79}$/i.test(namespace) ||
    !/^[a-z0-9_][a-z0-9_.-]{0,79}$/i.test(model) ||
    !/^[a-z0-9_][a-z0-9_.-]{0,79}$/i.test(tag)
  )
    return null;
  return `${host}/${namespace}/${model}:${tag}`.toLowerCase();
}

const entriesOf = (raw: string) =>
  raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

export function ollamaModelAllowlistSchema(
  limits: { maxChars: number; maxEntries: number } = OLLAMA_ALLOWLIST_LIMITS,
) {
  return z.object({
    allowlist: z
      .string()
      .max(limits.maxChars)
      .superRefine((raw, ctx) => {
        const entries = entriesOf(raw);
        if (entries.length > limits.maxEntries) {
          ctx.addIssue({
            code: 'custom',
            message: `At most ${limits.maxEntries} model names are allowed`,
          });
        }
        const invalid = entries.find((entry) => normalizeOllamaModel(entry) === null);
        if (invalid !== undefined) {
          ctx.addIssue({ code: 'custom', message: `Invalid Ollama model name: ${invalid}` });
        }
      }),
  });
}

const allowlistSchema = ollamaModelAllowlistSchema();

/** Keep registry authority separate from case-insensitive model equality. A port
 * or a differently spelled default host needs explicit administrator approval.
 * Ollama parses three-part names from the right; also treat a two-part name's
 * leading dot/colon/localhost segment conservatively as a registry. */
function pullRegistry(raw: string): string {
  const parts = raw.trim().split('/');
  const first = parts[0]!;
  if (
    parts.length === 3 ||
    (parts.length === 2 &&
      (first.includes('.') || first.includes(':') || first.toLowerCase() === 'localhost'))
  )
    return first;
  return DEFAULT_OLLAMA_REGISTRY;
}

/** Only operator-controlled configuration grants pull authority. A stored provider
 * is user-controlled and cannot authorize either a save or a later re-pull.
 * Embedding defaults grant only the default registry; an exact allowlist entry
 * is explicit administrator approval of its registry as well as its model. */
export function isOllamaModelAllowed(
  role: string | undefined,
  model: string,
  policy: { embedModel: string | null; allowlist: string | null },
): boolean {
  if (role === 'admin') return true;
  const wanted = normalizeOllamaModel(model);
  if (!wanted) return false;
  const registry = pullRegistry(model);
  if (registry === DEFAULT_OLLAMA_REGISTRY) {
    if (normalizeOllamaModel(policy.embedModel || DEFAULT_EMBED_MODEL) === wanted) return true;
    if (normalizeOllamaModel(DEFAULT_EMBED_MODEL) === wanted) return true;
  }
  const parsed = allowlistSchema.safeParse({ allowlist: policy.allowlist ?? '' });
  return (
    parsed.success &&
    entriesOf(parsed.data.allowlist).some(
      (entry) => pullRegistry(entry) === registry && normalizeOllamaModel(entry) === wanted,
    )
  );
}

export const OLLAMA_MODEL_NOT_ALLOWED_MESSAGE =
  'Ask an administrator to allow this model and registry in the Ollama model allowlist.';
