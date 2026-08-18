import { describe, expect, it } from 'vitest';
import {
  canonicalModelKey,
  computeInvocationCost,
  convertFromUsd,
  hasAnyRate,
  inputIncludesCache,
  normalizeModelKey,
  parseEcbDailyRates,
  parseLitellmPrices,
  parseRate,
  pickLivePrice,
  litellmModelSegment,
  litellmRowsForProviders,
  ratesEqual,
  resolveCostDecision,
  type LivePriceRow,
  type ModelPriceRates,
} from '../src/cli-providers/model-pricing.js';

const RATES: ModelPriceRates = {
  inputRate: 5e-6,
  outputRate: 2.5e-5,
  cacheReadRate: 5e-7,
  cacheWriteRate: 6.25e-6,
  cacheWrite1hRate: 1e-5,
};

const NO_RATES: ModelPriceRates = {
  inputRate: null,
  outputRate: null,
  cacheReadRate: null,
  cacheWriteRate: null,
  cacheWrite1hRate: null,
};

describe('parseRate', () => {
  it('accepts the upstream string form and plain numbers', () => {
    expect(parseRate('0.00001')).toBe(0.00001);
    expect(parseRate(5e-7)).toBe(5e-7);
    expect(parseRate('0')).toBe(0);
  });

  it('returns null rather than 0 for anything unusable', () => {
    // A 0 rate reads as "free", which is the one wrong answer that costs money.
    for (const bad of ['', '   ', 'free', null, undefined, {}, NaN, Infinity, -1, '-0.5']) {
      expect(parseRate(bad)).toBeNull();
    }
  });
});

describe('parseLitellmPrices', () => {
  // Shape taken from the live model_prices_and_context_window.json (2026-08-18).
  const REAL = {
    sample_spec: { input_cost_per_token: 0.0, mode: 'chat', note: 'docs, not a model' },
    'claude-opus-5': {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 2.5e-5,
      cache_read_input_token_cost: 5e-7,
      cache_creation_input_token_cost: 6.25e-6,
      cache_creation_input_token_cost_above_1hr: 1e-5,
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 1000000,
    },
    'text-embedding-3-large': {
      input_cost_per_token: 1.3e-7,
      litellm_provider: 'openai',
      mode: 'embedding',
    },
    'nano-banana-pro': { output_cost_per_image: 0.195, mode: 'image_generation' },
  };

  it('maps a real chat entry onto the rate shape', () => {
    expect(parseLitellmPrices(REAL)).toEqual([
      {
        key: 'claude-opus-5',
        vendor: 'anthropic',
        rates: {
          inputRate: 5e-6,
          outputRate: 2.5e-5,
          cacheReadRate: 5e-7,
          cacheWriteRate: 6.25e-6,
          cacheWrite1hRate: 1e-5,
        },
      },
    ]);
  });

  it('drops the sample_spec key, non-chat modes and rate-less entries', () => {
    const keys = parseLitellmPrices(REAL).map((e) => e.key);
    expect(keys).not.toContain('sample_spec');
    expect(keys).not.toContain('text-embedding-3-large');
    expect(keys).not.toContain('nano-banana-pro');
  });

  it('keeps an entry that prices only some buckets', () => {
    const [entry] = parseLitellmPrices({
      'vendor/no-cache': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
    });
    expect(entry!.rates).toEqual({
      inputRate: 1e-6,
      outputRate: 2e-6,
      cacheReadRate: null,
      cacheWriteRate: null,
      cacheWrite1hRate: null,
    });
  });

  it('sorts by key and degrades to empty on a malformed payload', () => {
    const out = parseLitellmPrices({
      'z/last': { input_cost_per_token: 1e-6, mode: 'chat' },
      'a/first': { input_cost_per_token: 1e-6, mode: 'chat' },
    });
    expect(out.map((e) => e.key)).toEqual(['a/first', 'z/last']);
    expect(parseLitellmPrices(null)).toEqual([]);
    expect(parseLitellmPrices([])).toEqual([]);
    expect(parseLitellmPrices('nope')).toEqual([]);
  });
});

describe('model keys', () => {
  it('normalizes case and whitespace only', () => {
    expect(normalizeModelKey('  Claude-Opus-5 ')).toBe('claude-opus-5');
    expect(normalizeModelKey('')).toBeNull();
    expect(normalizeModelKey(null)).toBeNull();
  });

  it('KEEPS variant markers, which are separate SKUs at separate prices', () => {
    expect(normalizeModelKey('glm-5.3[1m]')).toBe('glm-5.3[1m]');
    expect(normalizeModelKey('deepseek-v4-pro:cloud')).toBe('deepseek-v4-pro:cloud');
  });

  it('applies an explicit alias but never chains or guesses a family', () => {
    expect(canonicalModelKey('anthropic/claude-opus-5')).toBe('claude-opus-5');
    expect(canonicalModelKey('claude-something-unlisted')).toBe('claude-something-unlisted');
  });
});

describe('litellmRowsForProviders', () => {
  // Vendor/key shapes taken verbatim from the live feed (2026-08-18).
  const ENTRIES = parseLitellmPrices({
    'claude-opus-5': { input_cost_per_token: 5e-6, litellm_provider: 'anthropic', mode: 'chat' },
    'azure_ai/claude-opus-5': {
      input_cost_per_token: 9e-6,
      litellm_provider: 'azure_ai',
      mode: 'chat',
    },
    'xai/grok-4.6': { input_cost_per_token: 2e-6, litellm_provider: 'xai', mode: 'chat' },
    'meta/muse-spark-1.2': {
      input_cost_per_token: 1.25e-6,
      litellm_provider: 'meta',
      mode: 'chat',
    },
    'zai/glm-4.6': { input_cost_per_token: 6e-7, litellm_provider: 'zai', mode: 'chat' },
    'dashscope/glm-5.2': {
      input_cost_per_token: 1.4e-6,
      litellm_provider: 'dashscope',
      mode: 'chat',
    },
  });

  it('scopes each vendor row to the Haive provider that calls that vendor', () => {
    const rows = litellmRowsForProviders(ENTRIES, ['claude-code', 'grok', 'muse', 'zai']);
    expect(rows.map((r) => `${r.provider}:${r.modelKey}`)).toEqual([
      'claude-code:claude-opus-5',
      'grok:grok-4.6',
      'muse:muse-spark-1.2',
      'zai:glm-4.6',
    ]);
  });

  it('REJECTS a reseller row for the same model', () => {
    // azure_ai republishes claude-opus-5 at its own price; applying it to a direct
    // Anthropic call would be wrong money, and `azure/us/*` really is 10% off list.
    const rows = litellmRowsForProviders(ENTRIES, ['claude-code']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceKey).toBe('claude-opus-5');
    expect(rows[0]!.rates.inputRate).toBe(5e-6);
  });

  it('leaves a model with no direct-vendor row unpriced rather than borrowing one', () => {
    // glm-5.2 exists in the feed only under resellers, so zai gets nothing for it —
    // the admin's manual rate is the intended answer.
    const rows = litellmRowsForProviders(ENTRIES, ['zai']);
    expect(rows.map((r) => r.modelKey)).toEqual(['glm-4.6']);
  });

  it('gives a gateway provider nothing, since it resells at its own margin', () => {
    expect(litellmRowsForProviders(ENTRIES, ['openrouter'])).toEqual([]);
    // amp reports no model at all, so it has no vendor list either.
    expect(litellmRowsForProviders(ENTRIES, ['amp'])).toEqual([]);
  });

  it('prefers the shorter key when one vendor publishes a model twice', () => {
    // Identical rates under two keys; a stable tie-break stops two syncs of the same
    // feed alternating and manufacturing a price-change history.
    const dupes = parseLitellmPrices({
      'deepseek-v4-pro': { input_cost_per_token: 4.35e-7, litellm_provider: 'zai', mode: 'chat' },
      'zai/deepseek-v4-pro': {
        input_cost_per_token: 4.35e-7,
        litellm_provider: 'zai',
        mode: 'chat',
      },
    });
    const rows = litellmRowsForProviders(dupes, ['zai']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceKey).toBe('deepseek-v4-pro');
  });

  it('strips only the path prefix from a key', () => {
    expect(litellmModelSegment('xai/grok-4.6')).toBe('grok-4.6');
    expect(litellmModelSegment('claude-opus-5')).toBe('claude-opus-5');
    expect(litellmModelSegment('fireworks_ai/accounts/fireworks/models/deepseek-v4-pro')).toBe(
      'deepseek-v4-pro',
    );
    // A colon variant marker is part of the model id, not a path.
    expect(litellmModelSegment('ollama/gpt-oss:120b-cloud')).toBe('gpt-oss:120b-cloud');
  });
});

describe('computeInvocationCost', () => {
  it('prices the four buckets independently', () => {
    const out = computeInvocationCost(
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheCreationTokens: 2000 },
      RATES,
    );
    expect(out.perBucket).toEqual({
      input: 1000 * 5e-6,
      output: 500 * 2.5e-5,
      cacheRead: 10_000 * 5e-7,
      cacheWrite: 2000 * 6.25e-6,
    });
    expect(out.costUsd).toBeCloseTo(0.005 + 0.0125 + 0.005 + 0.0125, 12);
    expect(out.unpricedBuckets).toEqual([]);
  });

  it('uses the 1h write rate only when that TTL was in force', () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1000 };
    expect(computeInvocationCost(usage, RATES, { cacheTtl: '5m' }).costUsd).toBeCloseTo(
      1000 * 6.25e-6,
      12,
    );
    expect(computeInvocationCost(usage, RATES, { cacheTtl: '1h' }).costUsd).toBeCloseTo(
      1000 * 1e-5,
      12,
    );
  });

  it('reports a missing 1h rate as unpriced instead of falling back to the 5m rate', () => {
    // Falling back would understate a 1-hour write by roughly 40%. Unpriced is loud;
    // a quietly low number is not.
    const out = computeInvocationCost(
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1000 },
      { ...RATES, cacheWrite1hRate: null },
      { cacheTtl: '1h' },
    );
    expect(out.unpricedBuckets).toEqual(['cacheWrite']);
    expect(out.costUsd).toBe(0);
  });

  it('subtracts the cached prefix for providers whose input INCLUDES it', () => {
    // codex/gemini report input inclusive of cache; Anthropic-shaped usage does not.
    // Pricing the inclusive form without subtracting overcharges the cached prefix at
    // the full input rate.
    const usage = { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 9000 };
    const anthropicShaped = computeInvocationCost(usage, RATES);
    const openaiShaped = computeInvocationCost(usage, RATES, { inputIncludesCache: true });
    expect(anthropicShaped.perBucket.input).toBeCloseTo(10_000 * 5e-6, 12);
    expect(openaiShaped.perBucket.input).toBeCloseTo(1000 * 5e-6, 12);
    // The cache-read bucket is charged identically either way.
    expect(openaiShaped.perBucket.cacheRead).toBeCloseTo(anthropicShaped.perBucket.cacheRead, 12);
  });

  it('never lets the subtraction go negative', () => {
    const out = computeInvocationCost(
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: 5000 },
      RATES,
      { inputIncludesCache: true },
    );
    expect(out.perBucket.input).toBe(0);
  });

  it('flags only the buckets that carried tokens without a rate', () => {
    const out = computeInvocationCost(
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      { ...NO_RATES, inputRate: 1e-6 },
    );
    expect(out.unpricedBuckets).toEqual(['output']);
    expect(out.perBucket.input).toBeCloseTo(100 * 1e-6, 12);
  });

  it('prices a cache-less model cleanly when no cache tokens were used', () => {
    const out = computeInvocationCost(
      { inputTokens: 100, outputTokens: 50 },
      { ...NO_RATES, inputRate: 1e-6, outputRate: 2e-6 },
    );
    expect(out.unpricedBuckets).toEqual([]);
    expect(out.costUsd).toBeCloseTo(100 * 1e-6 + 50 * 2e-6, 12);
  });

  it('knows which providers report inclusive input', () => {
    expect(inputIncludesCache('codex')).toBe(true);
    expect(inputIncludesCache('gemini')).toBe(true);
    expect(inputIncludesCache('claude-code')).toBe(false);
    expect(inputIncludesCache('zai')).toBe(false);
    expect(inputIncludesCache(null)).toBe(false);
  });
});

describe('resolveCostDecision', () => {
  const base = { hasManualRate: false, hasFeedRate: false, hasReportedCost: false };

  it('keeps the CLI total where the CLI prices its own backend', () => {
    expect(
      resolveCostDecision({
        ...base,
        provider: 'grok',
        authMode: 'api_key',
        hasReportedCost: true,
        hasFeedRate: true,
      }),
    ).toEqual({ source: 'reported', billable: true });
  });

  it('computes for a claude-binary wrapper, whose reported total is Anthropic fiction', () => {
    for (const provider of ['zai', 'muse', 'openrouter', 'ollama'] as const) {
      expect(
        resolveCostDecision({
          ...base,
          provider,
          authMode: 'api_key',
          hasReportedCost: true,
          hasFeedRate: true,
        }),
      ).toEqual({ source: 'computed', billable: true });
    }
  });

  it('computes for a metered CLI that reports no cost at all', () => {
    expect(
      resolveCostDecision({ ...base, provider: 'gemini', authMode: 'api_key', hasFeedRate: true }),
    ).toEqual({ source: 'computed', billable: true });
  });

  it('lets a manual rate win over everything', () => {
    expect(
      resolveCostDecision({
        provider: 'claude-code',
        authMode: 'api_key',
        hasManualRate: true,
        hasFeedRate: true,
        hasReportedCost: true,
      }),
    ).toEqual({ source: 'manual', billable: true });
  });

  it('never marks a subscription plan billable, however it was priced', () => {
    // A flat fee already paid; the binary still emits a notional per-token total, and
    // summing it is the double-count this guard exists to prevent.
    expect(
      resolveCostDecision({
        ...base,
        provider: 'claude-code',
        authMode: 'subscription',
        hasReportedCost: true,
      }),
    ).toEqual({ source: 'reported', billable: false });
    expect(
      resolveCostDecision({
        provider: 'claude-code',
        authMode: 'subscription',
        hasManualRate: true,
        hasFeedRate: true,
        hasReportedCost: true,
      }),
    ).toEqual({ source: 'manual', billable: false });
  });

  it('reports nothing usable as unpriced rather than as zero spend', () => {
    expect(resolveCostDecision({ ...base, provider: 'codex', authMode: 'api_key' })).toEqual({
      source: 'none',
      billable: false,
    });
  });
});

describe('pickLivePrice', () => {
  const row = (over: Partial<LivePriceRow>): LivePriceRow => ({
    id: 'r',
    provider: null,
    modelKey: 'm',
    source: 'litellm',
    rates: RATES,
    effectiveFrom: new Date('2026-01-01'),
    ...over,
  });

  it('prefers manual, then the preferred feed, then the rest', () => {
    const rows = [
      row({ id: 'litellm', source: 'litellm' }),
      row({ id: 'openrouter', source: 'openrouter' }),
      row({ id: 'manual', source: 'manual' }),
    ];
    expect(pickLivePrice(rows, 'openrouter')!.id).toBe('manual');
    expect(pickLivePrice(rows.slice(0, 2), 'openrouter')!.id).toBe('openrouter');
    expect(pickLivePrice(rows.slice(0, 2), null)!.id).toBe('litellm');
  });

  it('prefers a provider-scoped row over a vendor-wide one', () => {
    const rows = [row({ id: 'wide', provider: null }), row({ id: 'scoped', provider: 'zai' })];
    expect(pickLivePrice(rows)!.id).toBe('scoped');
  });

  it('breaks a tie on the newest effective_from', () => {
    const rows = [
      row({ id: 'old', effectiveFrom: new Date('2026-01-01') }),
      row({ id: 'new', effectiveFrom: new Date('2026-08-01') }),
    ];
    expect(pickLivePrice(rows)!.id).toBe('new');
  });

  it('returns null on no rows', () => {
    expect(pickLivePrice([])).toBeNull();
  });
});

describe('rate helpers', () => {
  it('detects a rate-less set and compares sets exactly', () => {
    expect(hasAnyRate(NO_RATES)).toBe(false);
    expect(hasAnyRate({ ...NO_RATES, cacheReadRate: 1e-9 })).toBe(true);
    expect(ratesEqual(RATES, { ...RATES })).toBe(true);
    expect(ratesEqual(RATES, { ...RATES, outputRate: 2.6e-5 })).toBe(false);
    // null and 0 are different facts and must not compare equal.
    expect(ratesEqual({ ...NO_RATES }, { ...NO_RATES, inputRate: 0 })).toBe(false);
  });
});

describe('parseEcbDailyRates', () => {
  // Trimmed from the live eurofxref-daily.xml (2026-08-18).
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01">
 <Cube><Cube time='2026-08-18'>
  <Cube currency='USD' rate='1.1576'/>
  <Cube currency='JPY' rate='170.55'/>
  <Cube currency='GBP' rate='0.86285'/>
  <Cube currency='CZK' rate='24.35'/>
 </Cube></Cube>
</gesmes:Envelope>`;

  it('reads the rate date and derives USD-per-unit from the EUR quotes', () => {
    const { date, rates } = parseEcbDailyRates(XML);
    expect(date).toBe('2026-08-18');
    const byCurrency = new Map(rates.map((r) => [r.currency, r.usdPerUnit]));
    expect(byCurrency.get('USD')).toBe(1);
    expect(byCurrency.get('EUR')).toBeCloseTo(1.1576, 10);
    // 1 GBP = (1.1576 USD/EUR) / (0.86285 GBP/EUR)
    expect(byCurrency.get('GBP')).toBeCloseTo(1.1576 / 0.86285, 10);
    expect(byCurrency.get('CZK')).toBeCloseTo(1.1576 / 24.35, 10);
  });

  it('omits a currency the feed did not quote rather than defaulting it', () => {
    const { rates } = parseEcbDailyRates(XML);
    expect(rates.map((r) => r.currency)).not.toContain('CHF');
  });

  it('yields no rates when the shape changes, so the caller can report an error', () => {
    // Zero matches must not be mistaken for "no rates published today".
    expect(parseEcbDailyRates('<html>we redesigned our site</html>').rates).toEqual([]);
    // USD is the pivot: without it nothing can be derived.
    expect(
      parseEcbDailyRates(`<Cube time='2026-08-18'><Cube currency='JPY' rate='170.55'/>`).rates,
    ).toEqual([]);
  });
});

describe('convertFromUsd', () => {
  it('divides by USD-per-unit', () => {
    expect(convertFromUsd(1.1576, { currency: 'EUR', usdPerUnit: 1.1576 })).toBeCloseTo(1, 12);
  });

  it('returns null on a missing or nonsensical rate so the caller can show USD', () => {
    expect(convertFromUsd(5, null)).toBeNull();
    expect(convertFromUsd(5, { currency: 'EUR', usdPerUnit: 0 })).toBeNull();
    expect(convertFromUsd(5, { currency: 'EUR', usdPerUnit: Number.NaN })).toBeNull();
  });
});
