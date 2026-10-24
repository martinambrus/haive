import type { CliProviderName } from '../types/index.js';

/**
 * Per-model context-window sizes (max input tokens). Used only to compute the
 * display-only "context left %" frozen on a finished step (Surface B).
 * FALLBACK ONLY: used when neither the OpenRouter catalog nor the window recorded with the
 * invocation exists.
 *
 * VOLATILE: vendors bump these silently, so this is a best-effort lookup with a
 * conservative fallback, NOT a contract. A wrong value only skews a cosmetic
 * percentage; it never gates execution. Entries are matched case-insensitively
 * as substrings of the resolved model id, LONGEST match first (so 'gemini-2.5'
 * wins over a broad 'gemini').
 */
const MODEL_CONTEXT_WINDOWS: ReadonlyArray<{ match: string; tokens: number }> = [
  // The claude binary reports 1,000,000 for opus-5/opus-5-5/sonnet-5 and a claude-code provider
  // row carries no model, so this entry only covers runs that recorded no window.
  { match: 'claude', tokens: 200_000 },
  // OpenAI Codex / GPT family.
  { match: 'gpt-5', tokens: 400_000 },
  { match: 'o3', tokens: 200_000 },
  { match: 'o4', tokens: 200_000 },
  { match: 'codex', tokens: 200_000 },
  // Google Gemini — 1M.
  { match: 'gemini-2.5', tokens: 1_048_576 },
  { match: 'gemini', tokens: 1_048_576 },
  // Z.AI GLM.
  { match: 'glm-4.6', tokens: 200_000 },
  { match: 'glm', tokens: 128_000 },
  // Meta Muse Spark — 1M.
  { match: 'muse-spark', tokens: 1_048_576 },
  // xAI Grok. The 256000 is a single measurement on grok 1.0.3; stored runs report none.
  { match: 'grok', tokens: 256_000 },
];

/** Provider-level fallback when no model id matches above (display-only). */
const PROVIDER_FALLBACK_WINDOW: Partial<Record<CliProviderName, number>> = {
  'claude-code': 200_000,
  codex: 200_000,
  gemini: 1_048_576,
  zai: 200_000,
  amp: 200_000,
  antigravity: 1_048_576,
  ollama: 128_000,
  muse: 1_048_576,
  grok: 256_000,
  // Gateway: the real window belongs to the ROUTED model, and OpenRouter reports it
  // per model (`context_length`) in the cached catalog. This fallback only covers a
  // row whose model id matches nothing above — OpenRouter slugs are `vendor/model`,
  // so the substring matcher already resolves `anthropic/claude-*` to 200k and
  // `openai/gpt-5*` to 400k on its own.
  openrouter: 200_000,
};

/** Conservative global fallback when neither model nor provider is known. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Resolve the context-window size (max input tokens) for a provider/model.
 * Best-effort + volatile (see MODEL_CONTEXT_WINDOWS). Never throws; always
 * returns a positive number so callers can compute a percentage safely.
 *
 * `knownContextLength` is a value reported for this exact model: the OpenRouter
 * catalog's `context_length` or the window the CLI recorded. It wins outright,
 * because it is the vendor's own number for the specific model rather than the
 * substring guess the table below makes. Ignored unless it is a positive finite
 * number, so a null/0/NaN from a stale cache falls through to the old behaviour
 * rather than producing a divide-by-zero percentage.
 */
export function resolveContextWindow(
  providerName: CliProviderName | string | null | undefined,
  model: string | null | undefined,
  knownContextLength?: number | null,
): number {
  if (
    typeof knownContextLength === 'number' &&
    Number.isFinite(knownContextLength) &&
    knownContextLength > 0
  ) {
    return knownContextLength;
  }
  const m = (model ?? '').toLowerCase();
  if (m) {
    const matches = MODEL_CONTEXT_WINDOWS.filter((e) => m.includes(e.match)).sort(
      (a, b) => b.match.length - a.match.length,
    );
    if (matches[0]) return matches[0].tokens;
  }
  if (providerName && providerName in PROVIDER_FALLBACK_WINDOW) {
    const p = PROVIDER_FALLBACK_WINDOW[providerName as CliProviderName];
    if (p) return p;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
