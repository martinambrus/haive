import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService, type ModelPriceRates, type RequestUsageCapture } from '@haive/shared';
import { resolveInvocationCost } from '../src/queues/cli-exec/invocation-cost.js';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import { extractGeminiJsonOutput } from '../src/cli-executor/usage-extract.js';

beforeEach(() => vi.spyOn(configService, 'getBoolean').mockResolvedValue(false));
afterEach(() => vi.restoreAllMocks());
const base = {
  inputRate: 1e-7,
  outputRate: 5e-7,
  cacheReadRate: 1e-8,
  cacheWriteRate: 1.25e-7,
  cacheWrite1hRate: 2e-7,
};
const rates: ModelPriceRates = {
  ...base,
  tiers: [{ ...base, aboveTokens: 100_000, inclusive: false, inputRate: 5e-7, outputRate: 2.5e-6 }],
};
function db(source = 'litellm', price = rates, authMode = 'api_key'): Database {
  return {
    query: {
      cliProviders: { findFirst: async () => ({ authMode, model: 'model' }) },
      cliPricingSync: { findFirst: async () => undefined },
    },
    select: () => ({
      from: () => ({
        where: async () => [
          {
            id: 'price',
            provider: null,
            modelKey: 'model',
            source,
            rates: price,
            effectiveFrom: new Date('2026-01-01'),
          },
        ],
      }),
    }),
  } as unknown as Database;
}
function streamed(
  inputs: number[],
  outputs: number[],
  resultOutput = outputs.reduce((a, b) => a + b, 0),
  results = 1,
) {
  const collector = createStreamJsonCollector();
  const events: unknown[] = [
    { type: 'system', subtype: 'init', model: 'model' },
    ...inputs.map((input_tokens, i) => ({
      type: 'assistant',
      message: { id: `r${i}`, model: 'model', usage: { input_tokens, output_tokens: outputs[i] } },
    })),
    ...Array.from({ length: results }, () => ({
      type: 'result',
      usage: {
        input_tokens: inputs.reduce((a, b) => a + b, 0),
        output_tokens: resultOutput,
      },
    })),
  ];
  collector.onChunk(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { tokenUsage: collector.getTokenUsage(), requestUsage: collector.getRequestUsage() };
}
const resolve = (providerName: string, evidence: ReturnType<typeof streamed>, store = db()) =>
  resolveInvocationCost(store, {
    cliProviderId: 'provider',
    providerName,
    ...evidence,
    modelIdentity: null,
  });

it('passes reconciled Claude mixed-tier prompts through to an unpriced output range', async () => {
  const evidence = streamed([99_999, 100_001], [0, 0], 40);
  expect(evidence.requestUsage.coverage).toBe('complete');
  const cost = await resolve('claude-code', evidence);
  expect(cost).toMatchObject({
    source: 'none',
    billable: false,
    costUsd: 0,
    tier: { state: 'unknown', lowUsd: expect.any(Number), highUsd: expect.any(Number) },
  });
});
it('prices same-tier Claude and exact-output Grok mixed tiers', async () => {
  expect(await resolve('claude-code', streamed([100_001, 100_002], [0, 0], 40))).toMatchObject({
    source: 'computed',
    tier: { state: 'exact', split: [{ requests: 2, outputTokens: 40 }] },
  });
  expect(await resolve('grok', streamed([99_999, 100_001], [11, 29]))).toMatchObject({
    source: 'computed',
    tier: { state: 'exact', split: [{ outputTokens: 11 }, { outputTokens: 29 }] },
  });
});
it('keeps a steered two-result run unpriced without a fabricated finite range', async () => {
  const cost = await resolve('claude-code', streamed([10], [1], 1, 2));
  expect(cost).toMatchObject({ source: 'none', billable: false, tier: { state: 'unknown' } });
  expect(cost!.tier).not.toHaveProperty('lowUsd');
});
it('uses validated single-request Gemini stats to price the entire prompt tier exactly', async () => {
  const parsed = extractGeminiJsonOutput(
    JSON.stringify({
      response: 'ok',
      stats: {
        models: {
          model: {
            api: { totalRequests: 1 },
            tokens: {
              prompt: 100_001,
              cached: 99_000,
              candidates: 30,
              thoughts: 10,
              total: 100_041,
            },
          },
        },
      },
    }),
  )!;
  const cost = await resolveInvocationCost(db(), {
    cliProviderId: 'provider',
    providerName: 'gemini',
    modelIdentity: null,
    tokenUsage: parsed.tokenUsage,
    requestUsage: parsed.requestUsage,
  });
  expect(cost).toMatchObject({
    source: 'computed',
    tier: { state: 'exact', split: [{ aboveTokens: 100_000, requests: 1 }] },
  });
  expect(cost!.costUsd).toBeCloseTo(1001 * 5e-7 + 99_000e-8 + 40 * 2.5e-6);
});
it('refuses malformed Gemini aggregate proofs and bounds a complete multi-request run', async () => {
  for (const tokens of [
    { prompt: 100_001, candidates: 10, cached: 200_000 },
    { prompt: 100_001, candidates: 10, total: 1 },
    { prompt: 100_001, candidates: -1 },
    { candidates: 10 },
  ]) {
    const parsed = extractGeminiJsonOutput(
      JSON.stringify({
        response: 'ok',
        stats: {
          models: {
            model: { api: { totalRequests: 1 }, tokens },
          },
        },
      }),
    )!;
    const cost = await resolveInvocationCost(db(), {
      cliProviderId: 'provider',
      providerName: 'gemini',
      modelIdentity: null,
      tokenUsage: parsed.tokenUsage,
      requestUsage: parsed.requestUsage,
    });
    expect(cost).toMatchObject({ source: 'none', tier: { state: 'unknown' } });
    expect(cost!.tier).not.toHaveProperty('lowUsd');
  }
  const parsed = extractGeminiJsonOutput(
    JSON.stringify({
      response: 'ok',
      stats: {
        models: {
          model: { api: { totalRequests: 2 }, tokens: { prompt: 100_001, candidates: 10 } },
        },
      },
    }),
  )!;
  const cost = await resolveInvocationCost(db(), {
    cliProviderId: 'provider',
    providerName: 'gemini',
    modelIdentity: null,
    tokenUsage: parsed.tokenUsage,
    requestUsage: parsed.requestUsage,
  });
  expect(cost).toMatchObject({
    source: 'none',
    tier: { state: 'unknown', lowUsd: expect.any(Number), highUsd: expect.any(Number) },
  });
});
it('preserves reported precedence, manual precedence, subscription gating and nested snapshot isolation', async () => {
  const evidence = streamed([100_001], [10]);
  evidence.tokenUsage!.costUsd = 7;
  expect(await resolve('claude-code', evidence)).toMatchObject({ source: 'reported', costUsd: 7 });
  const manual = await resolve('claude-code', evidence, db('manual'));
  expect(manual).toMatchObject({ source: 'manual', tier: { state: 'exact' } });
  expect(manual!.rates).not.toBe(rates);
  expect(manual!.rates!.tiers).not.toBe(rates.tiers);
  const subscription = await resolve(
    'codex',
    {
      tokenUsage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      requestUsage: {
        requests: [
          {
            requestId: 'r',
            turnId: 't',
            model: 'model',
            inputTokens: 10,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cacheCreation5mTokens: 0,
            cacheCreation1hTokens: 0,
          },
        ],
        coverage: 'complete',
        inputConvention: 'inclusive',
        requestCount: 1,
        modelCoverage: 'single',
        reasons: [],
      },
    },
    db('litellm', rates, 'subscription'),
  );
  expect(subscription).toMatchObject({
    source: 'computed',
    billable: false,
    tier: { state: 'exact' },
  });
});
it.each(['codex', 'claude-code'])(
  'keeps an untiered %s snapshot byte-identical with request evidence present',
  async (provider) => {
    const tokenUsage = {
      inputTokens: 1234,
      outputTokens: 23,
      cacheReadTokens: 400,
      totalTokens: 1257,
    };
    const input = {
      cliProviderId: 'provider',
      providerName: provider,
      tokenUsage,
      modelIdentity: null,
    };
    const without = await resolveInvocationCost(db('manual', base), input);
    const withEvidence = await resolveInvocationCost(db('manual', base), {
      ...input,
      requestUsage: { coverage: 'incomplete' } as RequestUsageCapture,
    });
    const baseline: Record<string, string> = {
      codex:
        '{"costUsd":0.00009889999999999999,"currency":"USD","source":"manual","billable":true,"modelKey":"model","priceRowId":"price","rates":{"inputRate":1e-7,"outputRate":5e-7,"cacheReadRate":1e-8,"cacheWriteRate":1.25e-7,"cacheWrite1hRate":2e-7},"cacheTtl":"5m","unpricedBuckets":[]}',
      'claude-code':
        '{"costUsd":0.0001389,"currency":"USD","source":"manual","billable":true,"modelKey":"model","priceRowId":"price","rates":{"inputRate":1e-7,"outputRate":5e-7,"cacheReadRate":1e-8,"cacheWriteRate":1.25e-7,"cacheWrite1hRate":2e-7},"cacheTtl":"5m","unpricedBuckets":[]}',
    };
    expect(JSON.stringify(withEvidence)).toBe(baseline[provider]);
    expect(JSON.stringify(without)).toBe(baseline[provider]);
    expect(withEvidence).not.toHaveProperty('tier');
  },
);

it('refuses whole-run tier proof when Gemini includes an unnamed model or an array catalog', async () => {
  const known = { api: { totalRequests: 1 }, tokens: { prompt: 1, candidates: 1 } };
  const unnamed = { api: { totalRequests: 0 }, tokens: { prompt: 100000, candidates: 10 } };
  for (const models of [{ model: known, '': unnamed }, { model: known, ' ': unnamed }, [known]]) {
    const parsed = extractGeminiJsonOutput(JSON.stringify({ response: 'ok', stats: { models } }))!;
    expect(parsed.requestUsage.coverage).toBe('unknown');
    const cost = await resolveInvocationCost(db(), {
      cliProviderId: 'provider',
      providerName: 'gemini',
      modelIdentity: null,
      tokenUsage: parsed.tokenUsage,
      requestUsage: parsed.requestUsage,
    });
    expect(cost).toMatchObject({ source: 'none', billable: false, tier: { state: 'unknown' } });
    expect(cost!.tier).not.toHaveProperty('lowUsd');
  }
});
