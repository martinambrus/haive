import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { DEFAULT_EMBED_MODEL } from '@haive/shared/global-kb';
import { getDb } from '../db.js';

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

export async function mayPullOllamaModel(
  userId: string,
  role: string,
  model: string,
): Promise<boolean> {
  if (role === 'admin') return true;
  const wanted = normalizeOllamaModel(model);
  if (!wanted) return false;
  // Providers have a non-null owner and their list/dispatch paths scope to that
  // owner. There is no shared/system provider scope to borrow from.
  const providers = await getDb().query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    columns: { model: true },
  });
  if (
    providers.some((provider) => provider.model && normalizeOllamaModel(provider.model) === wanted)
  ) {
    return true;
  }
  // Read just the model, avoiding the Global KB resolver's secret/database reads.
  // Its empty/missing value has the same effective default as that resolver.
  const embedModel =
    (await configService.get(CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL)) || DEFAULT_EMBED_MODEL;
  if (normalizeOllamaModel(embedModel) === wanted) return true;
  // The onboarding embedding default stays pullable after an admin changes the Global KB model.
  if (normalizeOllamaModel(DEFAULT_EMBED_MODEL) === wanted) return true;
  const raw = (await configService.get(CONFIG_KEYS.OLLAMA_MODEL_ALLOWLIST)) ?? '';
  const parsed = allowlistSchema.safeParse({ allowlist: raw });
  return (
    parsed.success &&
    entriesOf(parsed.data.allowlist).some((entry) => normalizeOllamaModel(entry) === wanted)
  );
}
