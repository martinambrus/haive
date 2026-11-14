/**
 * OpenRouter's model catalog, trimmed to what Haive actually reads.
 *
 * The gateway fronts 400+ models, so the provider form cannot offer a static list
 * and a hand-typed slug is a 404 that only surfaces on the first run. The worker
 * caches `GET https://openrouter.ai/api/v1/models` into `openrouter_model_cache`
 * on the same job that refreshes CLI package versions; this module owns the shape
 * and the pure trim, so the parsing is testable without a network call.
 */

import {
  normalizePriceRates,
  parseRate,
  parseTierRate,
  type ModelPriceRates,
  type PriceTier,
  type PricingUnsupportedReason,
} from './model-pricing.js';

/** One cached model. Mirrors the `$type` on `openrouter_model_cache.models` — the
 *  database package cannot import this (shared imports database, not the reverse),
 *  so the two are kept in sync by hand, exactly like `cli_providers.model_limits`. */
export interface OpenRouterModelEntry {
  /** OpenRouter slug, e.g. `anthropic/claude-opus-5`. Stored in cli_providers.model. */
  id: string;
  /** Human label, e.g. "Anthropic: Claude Opus 5". */
  name: string;
  /** Max input tokens the gateway reports. Feeds the context-window display. */
  contextLength: number | null;
  /** USD per token. Upstream sends these as decimal STRINGS; parsed on ingest. */
  promptPrice: number | null;
  completionPrice: number | null;
  /** USD per token for the cache buckets, from the same `pricing` object
   *  (`input_cache_read`, `input_cache_write`, `input_cache_write_1h` — verified
   *  live 2026-08-18). Feeds the price sync, which needs all four buckets to price
   *  an invocation; the model picker itself only reads prompt/completion. Null when
   *  the routed provider does not offer caching, which is common — a null bucket is
   *  only a problem when an invocation actually reports tokens in it. */
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  cacheWrite1hPrice: number | null;
  /** Complete prompt-size overrides after feed-order inheritance, ready for price sync. */
  tiers?: PriceTier[] | null;
  pricingState?: 'unsupported';
  pricingReason?: PricingUnsupportedReason;
  unsupportedOverrideCount?: number;
  /** Whether `supported_parameters` advertises a reasoning knob. Drives whether the
   *  effort selector is worth offering — NOT a correctness gate: OpenRouter validates
   *  `output_config.effort` globally and models without reasoning accept every level
   *  with a 200, normalizing it away. See the effort note in cli-adapters/openrouter.ts. */
  supportsReasoning: boolean;
  /** Whether `supported_parameters` advertises `tools`. This one IS load-bearing:
   *  Claude Code drives everything through native tool use, so a model without it
   *  cannot run a Haive step at all. */
  supportsTools: boolean;
  /** Whether `architecture.input_modalities` includes `image`. */
  supportsImages: boolean;
}

/** The subset of OpenRouter's `/api/v1/models` payload this module reads. Everything
 *  is optional because the gateway adds fields freely and a missing one must degrade
 *  to a conservative default rather than throw. */
interface RawOpenRouterModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: {
    overrides?: unknown;
    prompt?: unknown;
    completion?: unknown;
    input_cache_read?: unknown;
    input_cache_write?: unknown;
    input_cache_write_1h?: unknown;
  };
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown };
}

const OVERRIDE_RATE_FIELDS = {
  prompt: 'inputRate',
  completion: 'outputRate',
  input_cache_read: 'cacheReadRate',
  input_cache_write: 'cacheWriteRate',
  input_cache_write_1h: 'cacheWrite1hRate',
} as const;

/** VOLATILE: price fields outside Haive's text buckets, observed in the public
 * OpenRouter catalog on 2026-11-14. Unknown fields remain conditions, regardless
 * of whether their value looks numeric. */
const IGNORED_OVERRIDE_PRICE_FIELDS = new Set([
  'audio',
  'audio_output',
  'input_audio_cache',
  'image',
  'image_output',
  'web_search',
  'internal_reasoning',
]);

/** Later matching entries win per bucket, including explicit nulls. */
function parseOverrides(
  pricing: RawOpenRouterModel['pricing'],
): Pick<
  OpenRouterModelEntry,
  'tiers' | 'pricingState' | 'pricingReason' | 'unsupportedOverrideCount'
> {
  if (!pricing || !('overrides' in pricing)) return {};
  const overrides = pricing.overrides;
  if (!Array.isArray(overrides))
    return {
      pricingState: 'unsupported',
      pricingReason: 'invalid-tier',
      unsupportedOverrideCount: 1,
    };
  const supported: Record<string, unknown>[] = [];
  let unsupportedOverrideCount = 0;
  let timeWindowCount = 0;
  for (const entry of overrides) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      unsupportedOverrideCount++;
      continue;
    }
    const conditions = Object.keys(entry).filter(
      (k) =>
        k !== 'min_prompt_tokens' &&
        !Object.hasOwn(OVERRIDE_RATE_FIELDS, k) &&
        !IGNORED_OVERRIDE_PRICE_FIELDS.has(k),
    );
    if (conditions.length || !Object.hasOwn(entry, 'min_prompt_tokens')) {
      unsupportedOverrideCount++;
      if (conditions.length && conditions.every((k) => k === 'utc_start' || k === 'utc_end'))
        timeWindowCount++;
      continue;
    }
    supported.push(entry);
  }
  if (unsupportedOverrideCount)
    return {
      pricingState: 'unsupported',
      pricingReason:
        timeWindowCount === unsupportedOverrideCount ? 'time-window' : 'unsupported-condition',
      unsupportedOverrideCount,
    };
  try {
    const base: ModelPriceRates = {
      inputRate: parseRate(pricing.prompt),
      outputRate: parseRate(pricing.completion),
      cacheReadRate: parseRate(pricing.input_cache_read),
      cacheWriteRate: parseRate(pricing.input_cache_write),
      cacheWrite1hRate: parseRate(pricing.input_cache_write_1h),
    };
    const thresholds = [...new Set(supported.map((e) => e.min_prompt_tokens))];
    const tiers = thresholds.map((aboveTokens) => {
      // Validate before comparisons: string/NaN thresholds must never participate in inheritance.
      if (typeof aboveTokens !== 'number' || !Number.isSafeInteger(aboveTokens) || aboveTokens <= 0)
        throw new Error('Invalid threshold');
      const tier: PriceTier = { ...base, aboveTokens, inclusive: false };
      for (const entry of supported) {
        if (typeof entry.min_prompt_tokens !== 'number' || entry.min_prompt_tokens > aboveTokens)
          continue;
        for (const [field, bucket] of Object.entries(OVERRIDE_RATE_FIELDS)) {
          if (Object.hasOwn(entry, field)) tier[bucket] = parseTierRate(entry[field]);
        }
      }
      return tier;
    });
    const normalized = normalizePriceRates({ ...base, tiers });
    return normalized.tiers?.length ? { tiers: normalized.tiers } : {};
  } catch {
    return {
      pricingState: 'unsupported',
      pricingReason: 'invalid-tier',
      unsupportedOverrideCount: overrides.length,
    };
  }
}

function hasStringItem(value: unknown, item: string): boolean {
  return Array.isArray(value) && value.some((entry) => entry === item);
}

/** Trim a raw `/api/v1/models` payload to the cached shape.
 *
 *  Skips entries with no usable `id` (the slug is the only field that is truly
 *  required — it is what gets written to cli_providers.model). Capability flags
 *  default to FALSE when the field is absent: an unknown capability must not be
 *  advertised, since `supportsTools` decides whether a model is offered at all. */
export function trimOpenRouterModels(payload: unknown): OpenRouterModelEntry[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: OpenRouterModelEntry[] = [];
  for (const raw of data as RawOpenRouterModel[]) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!id) continue;
    const params = raw.supported_parameters;
    out.push({
      id,
      ...parseOverrides(raw.pricing),
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : id,
      contextLength:
        typeof raw.context_length === 'number' && Number.isFinite(raw.context_length)
          ? raw.context_length
          : null,
      promptPrice: parseRate(raw.pricing?.prompt),
      completionPrice: parseRate(raw.pricing?.completion),
      cacheReadPrice: parseRate(raw.pricing?.input_cache_read),
      cacheWritePrice: parseRate(raw.pricing?.input_cache_write),
      cacheWrite1hPrice: parseRate(raw.pricing?.input_cache_write_1h),
      supportsReasoning: hasStringItem(params, 'reasoning'),
      supportsTools: hasStringItem(params, 'tools'),
      supportsImages: hasStringItem(raw.architecture?.input_modalities, 'image'),
    });
  }
  // Stable order so the picker does not reshuffle between refreshes.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
