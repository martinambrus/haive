import { inputIncludesCache } from '../cli-providers/model-pricing.js';

/**
 * Token totals, normalised so providers can be compared or summed.
 *
 * The trap this exists for: Anthropic-shaped usage reports `input_tokens` EXCLUSIVE of the
 * cache buckets, while codex and gemini report it INCLUSIVE of the cached prefix
 * (`INPUT_INCLUDES_CACHE_PROVIDERS`). A single cache-hit ratio formula therefore gives two
 * different answers for the same underlying behaviour, and the wrong one looks plausible.
 *
 * MEASURED on the live install:
 *   claude-code  input      7,172   cacheRead 172,352,411  -> 100.0% cached
 *   codex        input 88,345,977   cacheRead  74,774,784  ->  84.6% cached
 * The naive `cacheRead / (input + cacheRead)` reports codex as 45.8% — off by nearly 2x, in
 * the direction that makes an efficient provider look wasteful.
 *
 * Cache-CREATION is not subtracted, and that is measurement rather than an oversight: only
 * claude-code and amp ever report cache-creation tokens at all (0 across 6,204 invocations
 * for every other provider), and neither of those is a cache-inclusive reporter. So the
 * inclusive providers' `input` contains the cache READ and nothing else.
 */
export interface RawTokenTotals {
  /** CliProviderName. An unknown or missing provider is treated as EXCLUSIVE — the shape
   *  every provider but two uses, and the reading that under-reports the cache ratio rather
   *  than inventing cache hits that were never reported. */
  provider?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface NormalizedTokens {
  /** Prompt tokens that were genuinely new — `input` with any cached prefix removed. */
  freshInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** freshInput + output + cacheRead + cacheCreation. Comparable across providers, which
   *  a raw sum of the reported fields is not. */
  totalTokens: number;
  /** cacheRead / (freshInput + cacheRead): the share of the PROMPT side served from cache.
   *  null when there was no prompt side at all — 0% and "nothing to measure" are different
   *  claims and a KPI tile must not render them the same way. */
  cacheHitRatio: number | null;
  /** cacheCreation / (cacheCreation + cacheRead): the share of CACHED traffic that was
   *  re-written rather than reused. null when nothing was cached either way, for the same
   *  reason cacheHitRatio is.
   *
   *  NOT a restatement of cacheHitRatio, which cannot see this at all: cache CREATION is
   *  absent from that ratio's denominator. MEASURED on step 00-plan-sequence — 499 fan-out
   *  agents averaging input 2, cacheRead 24,263, cacheCreation 84,305 — cacheHitRatio reports
   *  0.9999, a near-perfect cache hit, for a step writing 84k cache tokens per agent. A write
   *  bills at 1.25x input against a read's 0.1x, so the two figures disagree about money by
   *  more than 12x on exactly the steps that cost the most.
   *
   *  Denominator is the cached traffic alone. Folding in freshInput/output would dilute it
   *  with volume that has nothing to do with whether a prefix was reused. */
  cacheWriteShare: number | null;
}

function nonNegative(n: number | null | undefined): number {
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : 0;
}

/** Normalise one provider's totals. */
export function normalizeTokens(raw: RawTokenTotals): NormalizedTokens {
  const input = nonNegative(raw.inputTokens);
  const outputTokens = nonNegative(raw.outputTokens);
  const cacheReadTokens = nonNegative(raw.cacheReadTokens);
  const cacheCreationTokens = nonNegative(raw.cacheCreationTokens);

  // Floored at 0: a provider that reports slightly less input than cache-read (rounding, or a
  // partial usage record) must not produce a negative "fresh" figure that then subtracts from
  // a cross-provider total.
  const freshInputTokens = inputIncludesCache(raw.provider)
    ? Math.max(0, input - cacheReadTokens)
    : input;

  const promptSide = freshInputTokens + cacheReadTokens;
  const cachedSide = cacheCreationTokens + cacheReadTokens;
  return {
    freshInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: freshInputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    cacheHitRatio: promptSide > 0 ? cacheReadTokens / promptSide : null,
    cacheWriteShare: cachedSide > 0 ? cacheCreationTokens / cachedSide : null,
  };
}

/** Normalise each provider's totals first, THEN add them up.
 *
 *  The order is the whole point: summing the raw fields across providers and normalising once
 *  at the end is meaningless, because the sum mixes two different definitions of `input`. */
export function sumNormalizedTokens(rows: RawTokenTotals[]): NormalizedTokens {
  let freshInputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const row of rows) {
    const n = normalizeTokens(row);
    freshInputTokens += n.freshInputTokens;
    outputTokens += n.outputTokens;
    cacheReadTokens += n.cacheReadTokens;
    cacheCreationTokens += n.cacheCreationTokens;
  }
  const promptSide = freshInputTokens + cacheReadTokens;
  const cachedSide = cacheCreationTokens + cacheReadTokens;
  return {
    freshInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: freshInputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    cacheHitRatio: promptSide > 0 ? cacheReadTokens / promptSide : null,
    cacheWriteShare: cachedSide > 0 ? cacheCreationTokens / cachedSide : null,
  };
}
