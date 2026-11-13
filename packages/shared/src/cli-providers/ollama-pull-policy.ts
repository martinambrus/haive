import { z } from 'zod';
import { DEFAULT_EMBED_MODEL } from '../global-kb/connection.js';

export const OLLAMA_ALLOWLIST_LIMITS = { maxChars: 16_384, maxEntries: 256 } as const;

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
  const host = parts.pop() ?? 'registry.ollama.ai';
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

/** Only operator-controlled configuration grants pull authority. A stored provider
 * is user-controlled and cannot authorize either a save or a later re-pull. */
export function isOllamaModelAllowed(
  role: string | undefined,
  model: string,
  policy: { embedModel: string | null; allowlist: string | null },
): boolean {
  if (role === 'admin') return true;
  const wanted = normalizeOllamaModel(model);
  if (!wanted) return false;
  if (normalizeOllamaModel(policy.embedModel || DEFAULT_EMBED_MODEL) === wanted) return true;
  if (normalizeOllamaModel(DEFAULT_EMBED_MODEL) === wanted) return true;
  const parsed = allowlistSchema.safeParse({ allowlist: policy.allowlist ?? '' });
  return (
    parsed.success &&
    entriesOf(parsed.data.allowlist).some((entry) => normalizeOllamaModel(entry) === wanted)
  );
}

export const OLLAMA_MODEL_NOT_ALLOWED_MESSAGE =
  'This model is not the Global KB embedding model or an allowed Ollama model. Ask an administrator to add it to the Ollama model allowlist.';
