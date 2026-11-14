import { describe, expect, it } from 'vitest';
import * as pricing from '../src/cli-providers/model-pricing.js';
import { trimOpenRouterModels } from '../src/cli-providers/openrouter-models.js';
import litellm from './fixtures/pricing/litellm.json' with { type: 'json' };
import openrouter from './fixtures/pricing/openrouter.json' with { type: 'json' };

import modalities from './fixtures/pricing/litellm-modalities.json' with { type: 'json' };

const base = {
  inputRate: 1,
  outputRate: 2,
  cacheReadRate: null,
  cacheWriteRate: null,
  cacheWrite1hRate: null,
};
const tier = { ...base, aboveTokens: 100, inclusive: false, inputRate: 5 };

it('ignores service-tier variants and 12-hour TTL rates', () => {
  const ignored = Object.fromEntries(
    ['batches', 'flex', 'priority', 'ultrafast', 'decisions'].map((suffix) => [
      `input_cost_per_token_above_1k_tokens_${suffix}`,
      9,
    ]),
  );
  const [row] = pricing.parseLitellmPrices({
    x: {
      mode: 'chat',
      input_cost_per_token: 1,
      ...ignored,
      cache_creation_input_token_cost_above_12hr: 2,
      cache_creation_input_token_cost_above_12hr_above_1k_tokens: 3,
    },
  });
  expect(row!.rates).toEqual({ ...base, outputRate: null });
});

describe('context tier storage', () => {
  it('materializes the five named LiteLLM models and xAI boundary', () => {
    const rows = pricing.litellmRowsForProviders(pricing.parseLitellmPrices(litellm), [
      'claude-code',
      'codex',
      'gemini',
      'grok',
      'muse',
    ]);
    expect(rows).toHaveLength(5);
    expect(pricing.MAX_PRICE_TIERS).toBe(4);
    for (const row of rows) {
      expect(row.rates.pricingState).toBeUndefined();
      const multiplier = row.provider === 'claude-code' ? 5 : row.provider === 'muse' ? 3 : 2;
      expect(row.rates.tiers![0]!.inputRate).toBeCloseTo(row.rates.inputRate! * multiplier, 12);
    }
    expect(
      rows.map((r) => [r.provider, r.rates.tiers?.[0]?.aboveTokens, r.rates.tiers?.[0]?.inclusive]),
    ).toEqual([
      ['claude-code', 100000, false],
      ['codex', 272000, false],
      ['gemini', 200000, false],
      ['grok', 200000, true],
      ['muse', 200000, false],
    ]);
    expect(rows[0]!.rates.tiers![0]).toMatchObject({
      inputRate: 5e-7,
      outputRate: 2.5e-6,
      cacheWrite1hRate: 1e-6,
    });
  });
  it('equates all empty tier representations but detects tier changes', () => {
    for (const tiers of [undefined, null, []])
      expect(pricing.ratesEqual(base, { ...base, tiers })).toBe(true);
    expect(pricing.ratesEqual(base, { ...base, tiers: [tier] })).toBe(false);
    expect(
      pricing.ratesEqual(
        { ...base, tiers: [tier] },
        { ...base, tiers: [{ ...tier, inclusive: true }] },
      ),
    ).toBe(false);
  });
  it('normalizes ingress and refuses invalid, duplicate and excessive tiers', () => {
    expect(
      pricing
        .normalizePriceRates({ ...base, tiers: [{ ...tier, aboveTokens: 200 }, tier] })
        .tiers?.map((t) => t.aboveTokens),
    ).toEqual([100, 200]);
    for (const bad of [0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        pricing.normalizePriceRates({ ...base, tiers: [{ ...tier, aboveTokens: bad }] }),
      ).toThrow();
    for (const bad of [-1, NaN, Infinity, undefined, '1'])
      expect(() =>
        pricing.normalizePriceRates({ ...base, tiers: [{ ...tier, inputRate: bad }] }),
      ).toThrow();
    expect(() => pricing.normalizePriceRates({ ...base, tiers: [tier, tier] })).toThrow();
    expect(() =>
      pricing.normalizePriceRates({
        ...base,
        tiers: [1, 2, 3, 4, 5].map((aboveTokens) => ({ ...tier, aboveTokens })),
      }),
    ).toThrow();
    expect(
      pricing.normalizePriceRates({ ...base, tiers: [{ ...tier, inputRate: null }] }).tiers![0]!
        .inputRate,
    ).toBeNull();
  });
  it('selects only the highest crossed complete tier, by value', () => {
    const rates = {
      ...base,
      tiers: [tier, { ...tier, aboveTokens: 200, inclusive: true, inputRate: 10 }],
    };
    expect(pricing.tierRatesFor(rates, 100).inputRate).toBe(1);
    expect(pricing.tierRatesFor(rates, 101).inputRate).toBe(5);
    expect(pricing.tierRatesFor(rates, 200).inputRate).toBe(10);
    const chosen = pricing.tierRatesFor(rates, 101);
    chosen.inputRate = 99;
    expect(tier.inputRate).toBe(5);
  });
  it('keeps LiteLLM absent keys at base and explicit nulls unknown', () => {
    const [row] = pricing.parseLitellmPrices({
      x: {
        mode: 'chat',
        litellm_provider: 'openai',
        input_cost_per_token: 1,
        output_cost_per_token: 2,
        input_cost_per_token_above_1k_tokens: null,
        output_cost_per_token_above_2k_tokens: 4,
      },
    });
    expect(row!.rates.tiers).toEqual([
      { ...base, aboveTokens: 1000, inclusive: false, inputRate: null },
      { ...base, aboveTokens: 2000, inclusive: false, outputRate: 4 },
    ]);
  });
  it.each([
    { tiered_pricing: [] },
    { input_cost_per_token_above_new_condition: 2 },
    { input_cost_per_token_above_1k_tokens: 'invalid' },
  ])('marks an unreadable LiteLLM tier unsupported (%j)', (extra) => {
    const [row] = pricing.parseLitellmPrices({
      x: { mode: 'chat', litellm_provider: 'openai', input_cost_per_token: 1, ...extra },
    });
    expect(row!.rates.pricingState).toBe('unsupported');
    expect(
      pricing.pickLivePrice([
        {
          id: 'x',
          provider: 'codex',
          modelKey: 'x',
          source: 'litellm',
          rates: row!.rates,
          effectiveFrom: new Date(),
        },
      ]),
    ).toBeNull();
  });
  it('keeps OpenRouter tiers and counts time-window overrides', () => {
    const models = trimOpenRouterModels(openrouter);
    expect(models.find((m) => m.id.startsWith('qwen/'))!.tiers).toHaveLength(2);
    const timed = models.find((m) => m.id.startsWith('minimax/'))!;
    expect(timed.pricingState).toBe('unsupported');
    expect(timed.unsupportedOverrideCount).toBe(2);
  });
  it('applies OpenRouter overrides in feed order per key at each threshold', () => {
    const [m] = trimOpenRouterModels({
      data: [
        {
          id: 'qwen/test',
          pricing: {
            prompt: '1',
            completion: '2',
            overrides: [
              { min_prompt_tokens: 200, completion: '9' },
              { min_prompt_tokens: 100, prompt: '3' },
              { min_prompt_tokens: 100, input_cache_read: null },
              { min_prompt_tokens: 200, prompt: '4' },
            ],
          },
        },
      ],
    });
    expect(m!.tiers).toEqual([
      { ...base, aboveTokens: 100, inclusive: false, inputRate: 3 },
      { ...base, aboveTokens: 200, inclusive: false, inputRate: 4, outputRate: 9 },
    ]);
  });
  it('does not inherit explicit nulls or turn invalid OpenRouter prices into zero', () => {
    const [m] = trimOpenRouterModels({
      data: [
        {
          id: 'x',
          pricing: {
            prompt: '1',
            completion: '2',
            overrides: [{ min_prompt_tokens: 100, prompt: null }],
          },
        },
      ],
    });
    expect(m!.tiers![0]!.inputRate).toBeNull();
    const [bad] = trimOpenRouterModels({
      data: [
        { id: 'x', pricing: { prompt: '1', overrides: [{ min_prompt_tokens: 100, prompt: '' }] } },
      ],
    });
    expect(bad!.pricingState).toBe('unsupported');
  });
});

it('validates OpenRouter boundaries and never inherits unknown lower-tier rates', () => {
  const parse = (overrides: unknown[]) =>
    trimOpenRouterModels({
      data: [
        { id: 'x', pricing: { prompt: '1', completion: '2', input_cache_read: '3', overrides } },
      ],
    })[0]!;
  expect(
    parse([
      { min_prompt_tokens: 100, input_cache_read: null },
      { min_prompt_tokens: 200, completion: '4' },
    ]).tiers![1]!.cacheReadRate,
  ).toBeNull();
  for (const boundary of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', null]) {
    expect(parse([{ min_prompt_tokens: boundary, prompt: '3' }]).pricingState).toBe('unsupported');
  }
  expect(
    parse([1, 2, 3, 4, 5].map((min_prompt_tokens) => ({ min_prompt_tokens, prompt: '3' })))
      .pricingState,
  ).toBe('unsupported');
  expect(
    parse([{ min_prompt_tokens: 100, region: 'new', prompt: '3' }]).unsupportedOverrideCount,
  ).toBe(1);
});

it('blocks a stale fallback feed behind the preferred unsupported marker', () => {
  const common = { provider: 'codex' as const, modelKey: 'x', effectiveFrom: new Date() };
  const fallback = { ...common, id: 'old', source: 'openrouter' as const, rates: base };
  const unsupported = {
    ...common,
    id: 'blocked',
    source: 'litellm' as const,
    rates: {
      ...base,
      pricingState: 'unsupported' as const,
      pricingReason: 'unsupported-tier' as const,
    },
  };
  expect(pricing.pickLivePrice([fallback, unsupported], 'litellm')).toBeNull();
  expect(
    pricing.pickLivePrice(
      [fallback, unsupported, { ...common, id: 'manual', source: 'manual', rates: base }],
      'litellm',
    )!.id,
  ).toBe('manual');
});

it('prices live Gemini text buckets despite non-text threshold rates', () => {
  const rows = pricing.litellmRowsForProviders(pricing.parseLitellmPrices(modalities), ['gemini']);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.rates.pricingState).toBeUndefined();
    expect(pricing.hasAnyRate(row.rates)).toBe(true);
  }
});
it.each(['audio', 'image', 'video', 'character', 'per_second', 'per_query'])(
  'ignores the non-text %s threshold family',
  (family) => {
    const [row] = pricing.parseLitellmPrices({
      x: {
        mode: 'chat',
        input_cost_per_token: 1,
        [`input_cost_${family}_above_128k_tokens`]: 3,
      },
    });
    expect(row!.rates.pricingState).toBeUndefined();
  },
);
it('fails loud for an unclassified threshold family', () => {
  const [row] = pricing.parseLitellmPrices({
    x: {
      mode: 'chat',
      input_cost_per_token: 1,
      unknown_cost_above_128k_tokens: 3,
    },
  });
  expect(row!.rates.pricingReason).toBe('unsupported-tier');
});
