import type { CliProviderName } from '../types/index.js';

/**
 * Per-model context-window sizes (max input tokens). Used only to compute the
 * display-only "context left %" frozen on a finished step (Surface B).
 *
 * VOLATILE: vendors bump these silently, so this is a best-effort lookup with a
 * conservative fallback, NOT a contract. A wrong value only skews a cosmetic
 * percentage; it never gates execution. Entries are matched case-insensitively
 * as substrings of the resolved model id, LONGEST match first (so 'gemini-2.5'
 * wins over a broad 'gemini').
 */
const MODEL_CONTEXT_WINDOWS: ReadonlyArray<{ match: string; tokens: number }> = [
  // Anthropic Claude — standard 200k window (the 1M window is an opt-in beta,
  // not the default for a Haive provider's configured model).
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
};

/** Conservative global fallback when neither model nor provider is known. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Resolve the context-window size (max input tokens) for a provider/model.
 * Best-effort + volatile (see MODEL_CONTEXT_WINDOWS). Never throws; always
 * returns a positive number so callers can compute a percentage safely.
 */
export function resolveContextWindow(
  providerName: CliProviderName | string | null | undefined,
  model: string | null | undefined,
): number {
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
