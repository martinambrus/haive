/**
 * Per-model token pricing: the rate shape, the feed parsers, and the pure cost
 * computation. No DB and no network here — the worker owns fetching and storage
 * (`cli-versions/model-prices.ts`), this module owns the shape and the arithmetic
 * so both are testable without a network call. Same split as
 * `openrouter-models.ts` next door.
 *
 * WHY this exists at all: the claude binary reports `total_cost_usd` priced
 * against ANTHROPIC's table no matter which backend answered, so for zai / muse /
 * openrouter / ollama that number is fiction (see the costBasis notes in
 * catalog.ts) and `resolveCostBasis` refuses to sum it. codex and gemini report no
 * cost at all. Pricing the four token buckets ourselves is the only way those
 * providers ever show real money.
 */

import type { AuthMode, CliProviderName } from '../types/index.js';
import { resolveCostBasis } from './catalog.js';

/** USD per single token, per bucket. Every bucket is independently nullable: a
 *  feed may price input/output and say nothing about caching, and a null must stay
 *  null rather than becoming 0 — a 0 rate reads as "free", which is the one wrong
 *  answer that costs money (same rule as `parsePrice` in openrouter-models.ts). */
export interface ModelPriceRates {
  inputRate: number | null;
  outputRate: number | null;
  cacheReadRate: number | null;
  /** Writing to the 5-minute cache (the default TTL). */
  cacheWriteRate: number | null;
  /** Writing to the 1-hour cache. A DIFFERENT rate, not a multiplier: Anthropic
   *  charges 2x base for 1h vs 1.25x for 5m, and both feeds publish it as its own
   *  field. Used only when CONFIG_KEYS.PROMPT_CACHING_1H was on for the run. */
  cacheWrite1hRate: number | null;
}

/** Where a stored rate came from. `manual` is admin-entered (a negotiated or
 *  enterprise rate) and is never touched by a sync. */
export type PriceFeed = 'openrouter' | 'litellm' | 'manual';

export const PRICE_FEEDS: PriceFeed[] = ['openrouter', 'litellm', 'manual'];

/** Public and unauthenticated, like the OpenRouter catalog — no key needed, which
 *  is what lets pricing populate before any provider secret exists. */
export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** ECB's daily euro reference rates. Public, no key, one small XML document.
 *  Quoted as "units of X per 1 EUR", so a USD-per-unit rate is derived, never
 *  read directly. */
export const ECB_DAILY_FX_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

/** True when a rate object prices nothing at all — used to skip feed entries that
 *  carry only metadata (embedding-only rows, image-per-unit rows, moderation
 *  models) rather than storing a row of nulls that looks like a failed fetch. */
export function hasAnyRate(rates: ModelPriceRates): boolean {
  return (
    rates.inputRate !== null ||
    rates.outputRate !== null ||
    rates.cacheReadRate !== null ||
    rates.cacheWriteRate !== null ||
    rates.cacheWrite1hRate !== null
  );
}

/** Byte-compare two rate sets. The sync inserts a new effective-dated row ONLY
 *  when this says the rates actually moved, so an unchanged 12-hourly refresh is a
 *  no-op instead of one history row per tick. */
export function ratesEqual(a: ModelPriceRates, b: ModelPriceRates): boolean {
  return (
    a.inputRate === b.inputRate &&
    a.outputRate === b.outputRate &&
    a.cacheReadRate === b.cacheReadRate &&
    a.cacheWriteRate === b.cacheWriteRate &&
    a.cacheWrite1hRate === b.cacheWrite1hRate
  );
}

/** Feeds send rates as decimal strings ("0.00001") or numbers. Anything else, and
 *  anything non-finite or negative, is null — see the ModelPriceRates note on why
 *  null must not collapse to 0. */
export function parseRate(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// --- Model keys ----------------------------------------------------------

/** Normalize a model id for price lookup: trim + lowercase, and NOTHING else.
 *
 *  Deliberately not the longest-substring matcher `resolveContextWindow` uses. A
 *  wrong context window skews a cosmetic percentage; a wrong price is wrong money,
 *  and `claude` alone would match both opus and haiku — rates roughly 15x apart.
 *  Variant markers are also kept verbatim (`glm-5.3[1m]`, `deepseek-v4-pro:cloud`,
 *  `gpt-5.6-sol`) because a context or hosting variant is frequently its own SKU at
 *  its own price. An id that matches nothing is UNPRICED, never guessed. */
export function normalizeModelKey(model: string | null | undefined): string | null {
  const key = (model ?? '').trim().toLowerCase();
  return key === '' ? null : key;
}

/** Explicit renames only: the same SKU published under two ids by two sources.
 *  Every entry is a measured equivalence, never a family guess — add one when a
 *  real lookup misses, and prefer a manual price row when in doubt. */
export const MODEL_KEY_ALIASES: Readonly<Record<string, string>> = {
  // LiteLLM keys Anthropic models bare; the OpenRouter feed prefixes the vendor.
  // Both name the same model, so a claude-code run can be priced from either feed.
  'anthropic/claude-opus-5': 'claude-opus-5',
  'anthropic/claude-sonnet-5': 'claude-sonnet-5',
  'anthropic/claude-haiku-4.5': 'claude-haiku-4-5',
};

/** Apply the alias map after normalization. Single hop only — an alias pointing at
 *  another alias is a data error, not a chain to follow. */
export function canonicalModelKey(model: string | null | undefined): string | null {
  const key = normalizeModelKey(model);
  if (key === null) return null;
  return MODEL_KEY_ALIASES[key] ?? key;
}

// --- LiteLLM feed --------------------------------------------------------

export interface LitellmPriceEntry {
  /** The feed's own top-level key, normalized. */
  key: string;
  /** `litellm_provider`, e.g. `anthropic`, `openai`, `vertex_ai`. Kept so a sync
   *  can prefer the direct-vendor row over a reseller row for the same model. */
  vendor: string | null;
  rates: ModelPriceRates;
}

interface RawLitellmEntry {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
  cache_creation_input_token_cost_above_1hr?: unknown;
  litellm_provider?: unknown;
  mode?: unknown;
}

/** Parse LiteLLM's `model_prices_and_context_window.json`.
 *
 *  Field names verified against the live document on 2026-08-18. Keeps only
 *  `mode: 'chat'` entries that price at least one bucket: the file also carries
 *  embedding, rerank, image and audio models whose per-image / per-second rates
 *  have nothing to do with an agent invocation, and a top-level `sample_spec` key
 *  that is documentation rather than a model. */
export function parseLitellmPrices(payload: unknown): LitellmPriceEntry[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  const out: LitellmPriceEntry[] = [];
  for (const [rawKey, rawValue] of Object.entries(payload as Record<string, unknown>)) {
    if (rawKey === 'sample_spec') continue;
    if (typeof rawValue !== 'object' || rawValue === null) continue;
    const raw = rawValue as RawLitellmEntry;
    if (raw.mode !== 'chat') continue;
    const key = normalizeModelKey(rawKey);
    if (key === null) continue;
    const rates: ModelPriceRates = {
      inputRate: parseRate(raw.input_cost_per_token),
      outputRate: parseRate(raw.output_cost_per_token),
      cacheReadRate: parseRate(raw.cache_read_input_token_cost),
      cacheWriteRate: parseRate(raw.cache_creation_input_token_cost),
      cacheWrite1hRate: parseRate(raw.cache_creation_input_token_cost_above_1hr),
    };
    if (!hasAnyRate(rates)) continue;
    out.push({
      key,
      vendor: typeof raw.litellm_provider === 'string' ? raw.litellm_provider : null,
      rates,
    });
  }
  // Stable order so a diff between two syncs is readable.
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/** Which LiteLLM `litellm_provider` values are the DIRECT vendor behind each Haive
 *  provider.
 *
 *  MEASURED against the live feed on 2026-08-18, not taken from any doc. The feed
 *  publishes one entry per (host, model) pair — `claude-opus-5` (anthropic),
 *  `azure_ai/claude-opus-5` (azure_ai) and `vertex_ai/claude-opus-5`
 *  (vertex_ai-anthropic_models) are three rows for one model, and the hosts do not
 *  all charge the same (`azure/us/gpt-5.6-sol` is 10% above `gpt-5.6-sol`). This
 *  list is the guard that keeps a reseller's rate from being applied to a direct
 *  API call: an entry is only considered when its vendor appears here.
 *
 *  Vendor is read from the `litellm_provider` FIELD rather than parsed off the key
 *  prefix, because the field is the feed's own discriminator while the prefix is
 *  just a naming habit (bare `claude-opus-5` and prefixed `zai/glm-4.6` are both
 *  direct-vendor rows).
 *
 *  Coverage as measured: anthropic 26 chat models, openai 90, gemini 50 +
 *  vertex_ai-language-models 29, xai 44, meta 3, zai 13, ollama 21 (all priced 0,
 *  which is the truth for local inference). Two Haive providers get nothing here by
 *  design:
 *    - `codex`/`amp` report no model at all, so a rate can only be resolved from the
 *      provider row's configured model.
 *    - `openrouter` is a gateway reselling at its own margin, so it is priced ONLY
 *      from its own catalog (`openrouter_model_cache`), never from a vendor rate. */
export const PROVIDER_LITELLM_VENDORS: Readonly<Partial<Record<CliProviderName, string[]>>> = {
  'claude-code': ['anthropic'],
  codex: ['openai'],
  // `gemini/*` is the AI Studio API the gemini CLI actually calls; the bare
  // `gemini-*` keys sit under vertex_ai-language-models and carry the same rates,
  // kept as a fallback for a model AI Studio has not been given its own row for.
  gemini: ['gemini', 'vertex_ai-language-models'],
  zai: ['zai'],
  muse: ['meta'],
  grok: ['xai'],
  // Every ollama row is priced 0, which is correct for local inference and harmless
  // for Ollama Cloud, whose plan is a flat subscription rather than per-token — the
  // `local` cost basis makes those non-billable regardless.
  ollama: ['ollama'],
};

/** The model id inside a LiteLLM key: everything after the last `/`, or the whole
 *  key when unprefixed. `xai/grok-4.6` -> `grok-4.6`, `claude-opus-5` -> itself,
 *  `fireworks_ai/accounts/fireworks/models/deepseek-v4-pro` -> `deepseek-v4-pro`.
 *
 *  Used ONLY to locate a key within an already-vendor-filtered set, never to match
 *  across vendors — on its own it would happily equate `azure/us/gpt-5.6-sol` with
 *  `gpt-5.6-sol`, which is a 10% error. */
export function litellmModelSegment(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx === -1 ? key : key.slice(idx + 1);
}

export interface ProviderPriceRow {
  provider: CliProviderName;
  modelKey: string;
  rates: ModelPriceRates;
  /** The feed key this row came from, for the admin table's provenance column. */
  sourceKey: string;
}

/** Resolve a parsed LiteLLM feed into provider-scoped rows.
 *
 *  The fuzzy part of matching (vendor filtering, prefix stripping) is done ONCE here
 *  at sync time, so the cost path only ever does an exact `(provider, model_key)`
 *  lookup. Rows land under the model's bare id, which is what a CLI reports as the
 *  model that answered.
 *
 *  When one vendor publishes two keys for the same model (`deepseek-v4-pro` and
 *  `deepseek/deepseek-v4-pro`, identical rates), the shorter key wins — an
 *  arbitrary but stable tie-break, so two syncs of the same feed do not alternate
 *  between them and manufacture a price-change history. */
export function litellmRowsForProviders(
  entries: LitellmPriceEntry[],
  providers: CliProviderName[],
): ProviderPriceRow[] {
  const out = new Map<string, ProviderPriceRow>();
  for (const provider of providers) {
    const vendors = PROVIDER_LITELLM_VENDORS[provider];
    if (!vendors || vendors.length === 0) continue;
    for (const entry of entries) {
      if (entry.vendor === null || !vendors.includes(entry.vendor)) continue;
      const modelKey = normalizeModelKey(litellmModelSegment(entry.key));
      if (modelKey === null) continue;
      const mapKey = `${provider} ${modelKey}`;
      const existing = out.get(mapKey);
      if (existing && existing.sourceKey.length <= entry.key.length) continue;
      out.set(mapKey, { provider, modelKey, rates: entry.rates, sourceKey: entry.key });
    }
  }
  return [...out.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.modelKey.localeCompare(b.modelKey),
  );
}

// --- Cost computation ----------------------------------------------------

export type CostBucket = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/** Which cache TTL the run used. Mirrors CONFIG_KEYS.PROMPT_CACHING_1H, which
 *  `exec-core.ts` turns into ENABLE_PROMPT_CACHING_1H for the claude binary. */
export type CacheTtl = '5m' | '1h';

export interface CostComputation {
  costUsd: number;
  perBucket: Record<CostBucket, number>;
  /** Buckets that carried tokens but had no rate. NON-EMPTY MEANS `costUsd` IS
   *  INCOMPLETE and must not be shown as a cost — the caller reports the
   *  invocation as unpriced instead. A bucket with zero tokens never lands here,
   *  so a model that simply does no caching still prices fine. */
  unpricedBuckets: CostBucket[];
}

/** Token counts a cost is computed from. Structurally `CliTokenUsage` minus the
 *  fields pricing does not read, so a caller can pass the stored usage directly. */
export interface PricedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Providers whose reported `inputTokens` INCLUDES the cached prefix.
 *
 *  This is the one arithmetic trap in the whole feature. Anthropic-shaped usage
 *  (claude-code, zai, ollama, muse, openrouter, grok, amp) reports `input_tokens`
 *  EXCLUSIVE of the cache buckets — see `normalizeClaudeUsage` in the worker's
 *  usage-extract.ts, which sums all four for the total. OpenAI-shaped codex usage
 *  reports `input_tokens` INCLUSIVE of `cached_input_tokens`
 *  (`tokenUsageFromCodexUsage`), and gemini's `stats.models[].tokens.prompt`
 *  likewise includes `cached`, which is why that mapping trusts gemini's own
 *  `total` instead of re-summing. Pricing those two without subtracting the cached
 *  prefix charges the full input rate for tokens that were billed at the cache-read
 *  rate — a systematic overcharge, largest on exactly the long-context steps that
 *  cache best. */
export const INPUT_INCLUDES_CACHE_PROVIDERS: CliProviderName[] = ['codex', 'gemini'];

export function inputIncludesCache(provider: CliProviderName | string | null | undefined): boolean {
  return INPUT_INCLUDES_CACHE_PROVIDERS.includes(provider as CliProviderName);
}

function bucketCost(
  tokens: number,
  rate: number | null,
  bucket: CostBucket,
  unpriced: CostBucket[],
): number {
  if (tokens <= 0) return 0;
  if (rate === null) {
    unpriced.push(bucket);
    return 0;
  }
  return tokens * rate;
}

/** Price the four token buckets. Pure arithmetic — no clamping of a "suspicious"
 *  total, no fallback rate. `cacheTtl: '1h'` requires `cacheWrite1hRate`: falling
 *  back to the 5-minute rate would understate a 1-hour write by roughly 40%, so a
 *  missing 1h rate reports the cacheWrite bucket as unpriced instead. */
export function computeInvocationCost(
  usage: PricedTokens,
  rates: ModelPriceRates,
  opts: { cacheTtl?: CacheTtl; inputIncludesCache?: boolean } = {},
): CostComputation {
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheCreationTokens ?? 0);
  const rawInput = Math.max(0, usage.inputTokens);
  const input = opts.inputIncludesCache ? Math.max(0, rawInput - cacheRead) : rawInput;
  const output = Math.max(0, usage.outputTokens);
  const writeRate = opts.cacheTtl === '1h' ? rates.cacheWrite1hRate : rates.cacheWriteRate;

  const unpricedBuckets: CostBucket[] = [];
  const perBucket: Record<CostBucket, number> = {
    input: bucketCost(input, rates.inputRate, 'input', unpricedBuckets),
    output: bucketCost(output, rates.outputRate, 'output', unpricedBuckets),
    cacheRead: bucketCost(cacheRead, rates.cacheReadRate, 'cacheRead', unpricedBuckets),
    cacheWrite: bucketCost(cacheWrite, writeRate, 'cacheWrite', unpricedBuckets),
  };
  return {
    costUsd: perBucket.input + perBucket.output + perBucket.cacheRead + perBucket.cacheWrite,
    perBucket,
    unpricedBuckets,
  };
}

// --- Which number to trust ----------------------------------------------

/** Where an invocation's stored cost came from.
 *  - `manual`   computed from an admin-entered rate (a negotiated deal wins outright)
 *  - `reported` the CLI's own total, kept only where the CLI prices its own backend
 *  - `computed` computed from a synced feed rate
 *  - `none`     no usable number; the UI says "unpriced" rather than showing 0 */
export type CostSource = 'manual' | 'reported' | 'computed' | 'none';

export interface CostDecision {
  source: CostSource;
  /** Whether this cost may be SUMMED as real money. False for a subscription plan
   *  (flat fee, so per-token dollars are notional) and for `none`. */
  billable: boolean;
}

/** Decide which number to keep for one invocation.
 *
 *  Precedence: manual rate > CLI-reported where the CLI prices its OWN backend >
 *  computed from a feed rate. The middle rule is why this is not simply "always
 *  compute": the claude binary's own total for a real Anthropic run includes side
 *  calls only the vendor can see (claude-code bills a haiku call for session
 *  titling) and any web-search surcharge, so recomputing it from four token buckets
 *  lands low. The same binary pointed at a NON-Anthropic backend produces fiction,
 *  which is exactly the case `resolveCostBasis` marks `estimate`/`local` — there,
 *  computed always wins.
 *
 *  Subscription auth short-circuits to non-billable regardless: a Pro/Max plan is a
 *  flat fee and the binary still emits a notional per-token total, which is the
 *  double-count this guard exists to prevent (see the AUTH-MODE COST GATING note in
 *  the token-telemetry work). */
export function resolveCostDecision(input: {
  provider: CliProviderName;
  authMode: AuthMode;
  hasManualRate: boolean;
  hasFeedRate: boolean;
  hasReportedCost: boolean;
}): CostDecision {
  const basis = resolveCostBasis(input.provider, input.authMode);
  if (basis === 'subscription') {
    // Priced for observability if we can, but never summed.
    const source: CostSource = input.hasManualRate
      ? 'manual'
      : input.hasReportedCost
        ? 'reported'
        : input.hasFeedRate
          ? 'computed'
          : 'none';
    return { source, billable: false };
  }
  if (input.hasManualRate) return { source: 'manual', billable: true };
  if (basis === 'metered' && input.hasReportedCost) return { source: 'reported', billable: true };
  if (input.hasFeedRate) return { source: 'computed', billable: true };
  return { source: 'none', billable: false };
}

/** What one invocation cost, as stored on `cli_invocations.cost`.
 *
 *  A snapshot: `rates` and `priceRowId` pin the price that was in force when the
 *  invocation ran, so a later vendor price change never restates a finished task.
 *  Keep in sync with the `$type` on that column (the database package cannot import
 *  this module — shared imports database, not the reverse). */
export interface InvocationCost {
  costUsd: number;
  /** Always 'USD' today; the display currency is applied at read time. */
  currency: string;
  source: CostSource;
  billable: boolean;
  /** The key the rate was looked up under — null when no model was resolvable
   *  (codex and amp report none) or when the cost came straight from the CLI. */
  modelKey: string | null;
  priceRowId: string | null;
  rates: ModelPriceRates | null;
  cacheTtl: CacheTtl;
  unpricedBuckets: CostBucket[];
}

// --- Choosing among live rows -------------------------------------------

export interface LivePriceRow {
  id: string;
  provider: CliProviderName | null;
  modelKey: string;
  source: PriceFeed;
  rates: ModelPriceRates;
  effectiveFrom: Date;
}

/** Two feeds can both price one model, so one `(provider, modelKey)` can have more
 *  than one live row. Order is fixed and explicit — manual first, then the
 *  provider's configured feed, then whatever else, newest `effectiveFrom` breaking
 *  a tie. Two feeds are never averaged: an average is a number no vendor charges.
 *  A provider-scoped row beats a vendor-wide (`provider: null`) row for the same
 *  model, since the scoped one was entered about this exact endpoint. */
export function pickLivePrice(
  rows: LivePriceRow[],
  preferredFeed: PriceFeed | null = null,
): LivePriceRow | null {
  if (rows.length === 0) return null;
  const rank = (row: LivePriceRow): number => {
    if (row.source === 'manual') return 0;
    if (preferredFeed && row.source === preferredFeed) return 1;
    return 2;
  };
  const sorted = [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byScope = (a.provider === null ? 1 : 0) - (b.provider === null ? 1 : 0);
    if (byScope !== 0) return byScope;
    return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  });
  return sorted[0] ?? null;
}

// --- Currency -----------------------------------------------------------

/** Currencies the display layer offers. USD is canonical — every stored cost is
 *  USD because that is what every vendor bills — and the rest are presentation,
 *  converted at the rate effective on the invocation's own date so an old task
 *  keeps reporting the same figure. Limited to what ECB publishes. */
export const DISPLAY_CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF', 'CZK', 'PLN', 'JPY'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export function isDisplayCurrency(value: unknown): value is DisplayCurrency {
  return typeof value === 'string' && (DISPLAY_CURRENCIES as readonly string[]).includes(value);
}

/** One ECB row: how many USD one unit of `currency` is worth. Derived from the
 *  EUR-quoted feed rather than stored as published, so every conversion is one
 *  multiplication against the canonical USD amount. */
export interface FxRate {
  currency: DisplayCurrency;
  usdPerUnit: number;
}

/** Parse ECB's eurofxref-daily.xml.
 *
 *  The document quotes units-per-EUR (`<Cube currency='USD' rate='1.1576'/>`), so
 *  USD-per-unit for currency X is `usdPerEur / xPerEur`. Returns the rate date
 *  alongside the rates because the whole point of storing them is dated lookup.
 *
 *  Parsed with a narrow regex rather than an XML library: the file is a flat list
 *  of self-closing `Cube` elements with two attributes, this adds no dependency to
 *  a package every server-side package imports, and a shape change yields zero
 *  matches — which the caller treats as an error and reports, never as "no rates
 *  today". Anchored on the ATTRIBUTES (the stable contract) rather than on element
 *  nesting or whitespace. */
export function parseEcbDailyRates(xml: string): { date: string | null; rates: FxRate[] } {
  const dateMatch = /time\s*=\s*['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml);
  const perEur = new Map<string, number>();
  const cubeRe = /currency\s*=\s*['"]([A-Z]{3})['"]\s+rate\s*=\s*['"]([0-9.]+)['"]/g;
  for (const m of xml.matchAll(cubeRe)) {
    const value = Number(m[2]);
    if (Number.isFinite(value) && value > 0) perEur.set(m[1]!, value);
  }
  const usdPerEur = perEur.get('USD');
  const rates: FxRate[] = [];
  if (usdPerEur !== undefined) {
    for (const currency of DISPLAY_CURRENCIES) {
      if (currency === 'USD') {
        rates.push({ currency, usdPerUnit: 1 });
        continue;
      }
      if (currency === 'EUR') {
        rates.push({ currency, usdPerUnit: usdPerEur });
        continue;
      }
      const unitsPerEur = perEur.get(currency);
      if (unitsPerEur !== undefined) {
        rates.push({ currency, usdPerUnit: usdPerEur / unitsPerEur });
      }
    }
  }
  return { date: dateMatch?.[1] ?? null, rates };
}

/** Convert a canonical USD amount into a display currency. Returns null when no
 *  rate is available for that date, so the caller can fall back to showing USD
 *  rather than inventing a conversion. */
export function convertFromUsd(costUsd: number, rate: FxRate | null | undefined): number | null {
  if (!rate || !Number.isFinite(rate.usdPerUnit) || rate.usdPerUnit <= 0) return null;
  return costUsd / rate.usdPerUnit;
}
