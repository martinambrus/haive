import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { computeInvocationCost, configService, type ModelPriceRates } from '@haive/shared';
import { runSequentialSubAgent } from '../src/cli-executor/sub-agent-runner.js';
import { aggregateRequestUsage, unknownRequestUsage } from '../src/cli-executor/request-usage.js';
import { createCodexJsonlCollector } from '../src/cli-executor/codex-jsonl.js';
import { resolveInvocationCost } from '../src/queues/cli-exec/invocation-cost.js';

const base = {
  inputRate: 1e-6,
  outputRate: 2e-6,
  cacheReadRate: 1e-7,
  cacheWriteRate: null,
  cacheWrite1hRate: null,
};
const rates: ModelPriceRates = {
  ...base,
  tiers: [{ ...base, aboveTokens: 272000, inclusive: false, inputRate: 2e-6, outputRate: 3e-6 }],
};
const tokens = (inputTokens: number, outputTokens = 10) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});
const stdout = (input: number) =>
  [
    { type: 'thread.started', thread_id: 'thread' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
    { type: 'turn.completed', usage: { input_tokens: input, output_tokens: 10 } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n';
function part(input: number) {
  const collector = createCodexJsonlCollector();
  collector.onChunk(stdout(input));
  return { id: 'process', tokenUsage: tokens(input), usage: collector.getRequestUsage('model') };
}
function compute(parts: ReturnType<typeof part>[], price = rates) {
  return computeInvocationCost(
    parts.reduce(
      (a, p) => ({
        inputTokens: a.inputTokens + p.tokenUsage.inputTokens,
        outputTokens: a.outputTokens + p.tokenUsage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
    price,
    { inputIncludesCache: true, modelKey: 'model', requestUsage: aggregateRequestUsage(parts) },
  );
}
beforeEach(() => vi.spyOn(configService, 'getBoolean').mockResolvedValue(false));
afterEach(() => vi.restoreAllMocks());

describe('independent process pricing', () => {
  it('keeps two 150k Codex sub-steps exact at base through runner and resolver', async () => {
    const run = await runSequentialSubAgent(
      {
        mode: 'sequential',
        steps: [{ id: 'scan', prompt: 'scan', expectJsonOutput: false }],
        synthesis: { id: 'finish', prompt: 'finish', expectJsonOutput: false },
      },
      () => ({
        command: 'codex',
        args: ['--model', 'model'],
        env: {},
        outputFormat: 'codex-jsonl',
      }),
      async () => ({
        stdout: stdout(150000),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        resolvedCommand: 'codex',
        wrapperId: null,
      }),
    );
    const db = {
      query: {
        cliProviders: { findFirst: async () => ({ authMode: 'api_key', model: 'model' }) },
        cliPricingSync: { findFirst: async () => undefined },
      },
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: 'price',
              provider: 'codex',
              modelKey: 'model',
              source: 'litellm',
              rates,
              effectiveFrom: new Date(),
            },
          ],
        }),
      }),
    } as unknown as Database;
    const cost = await resolveInvocationCost(db, {
      cliProviderId: 'provider',
      providerName: 'codex',
      tokenUsage: run.tokenUsage,
      modelIdentity: null,
      requestUsage: run.requestUsage,
    });
    expect(cost).toMatchObject({ source: 'computed', billable: true, tier: { state: 'exact' } });
    expect(cost!.costUsd).toBeCloseTo(300000e-6 + 20 * 2e-6, 12);
    expect(JSON.stringify(run.trace)).not.toContain('requestUsage');
  });
  it("sums each over-threshold part's bounds with the exact base part", () => {
    const result = compute([part(150000), part(300000)]);
    expect(result).toMatchObject({ costUsd: 0, tier: { state: 'unknown' } });
    expect(result.tier!.lowUsd).toBeCloseTo(0.45004, 12);
    expect(result.tier!.highUsd).toBeCloseTo(0.75005, 12);
  });
  it('prices a proven single high request independently', () => {
    const high = part(300000);
    high.usage.wholeRun!.requestCount = 1;
    const result = compute([part(150000), high]);
    expect(result.tier!.state).toBe('exact');
    expect(result.costUsd).toBeCloseTo(0.75005, 12);
  });
  it('does not make an unknown part exact even when its bound rates coincide', () => {
    const flatTier = { ...rates, tiers: [{ ...base, aboveTokens: 272000, inclusive: false }] };
    const result = compute([part(150000), part(300000)], flatTier);
    expect(result.tier).toMatchObject({ state: 'unknown', lowUsd: result.tier!.highUsd });
    expect(result.costUsd).toBe(0);
  });
  it('keeps absent whole-run and request proof unpriced, without borrowing a sibling proof', () => {
    const missing = part(150000);
    missing.usage = unknownRequestUsage('recovered-completion');
    const result = compute([part(1000), missing]);
    expect(result).toMatchObject({ costUsd: 0, tier: { state: 'unknown' } });
    expect(result.tier).not.toHaveProperty('lowUsd');
    expect(result.tier).not.toHaveProperty('highUsd');
  });
  it("keeps each part's reconciled request data and output allocation", () => {
    const detailed = part(300000);
    const request = (requestId: string, inputTokens: number, outputTokens: number) => ({
      requestId,
      turnId: null,
      model: 'model',
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
    });
    detailed.usage = {
      requests: [request('a', 10000, 3), request('b', 290000, 7)],
      coverage: 'complete',
      inputConvention: 'inclusive',
      requestCount: 2,
      modelCoverage: 'single',
      reasons: [],
    };
    const result = compute([part(150000), detailed]);
    expect(result.tier!.state).toBe('exact');
    expect(result.costUsd).toBeCloseTo(0.740047, 12);
    expect(result.tier!.split).toEqual(
      expect.arrayContaining([expect.objectContaining({ aboveTokens: 272000, outputTokens: 7 })]),
    );
  });
  it('rejects part totals that do not reconcile with the invocation', () => {
    const requestUsage = aggregateRequestUsage([part(150000), part(150000)]);
    const result = computeInvocationCost(tokens(1), rates, {
      inputIncludesCache: true,
      modelKey: 'model',
      requestUsage,
    });
    expect(result).toMatchObject({ costUsd: 0, tier: { state: 'unknown' } });
    expect(result.tier).not.toHaveProperty('lowUsd');
  });
  it('sums nested aggregates without losing process boundaries', () => {
    const inner = [part(150000), part(150000)];
    const nested = {
      id: 'nested',
      tokenUsage: tokens(300000, 20),
      usage: aggregateRequestUsage(inner),
    };
    const result = compute([nested, part(150000)]);
    expect(result.tier!.state).toBe('exact');
    expect(result.costUsd).toBeCloseTo(0.45006, 12);
  });
  it('sums two independent unknown-part envelopes', () => {
    const result = compute([part(300000), part(400000)]);
    expect(result.tier!.state).toBe('unknown');
    expect(result.tier!.lowUsd).toBeCloseTo(0.70004, 12);
    expect(result.tier!.highUsd).toBeCloseTo(1.40006, 12);
  });
  it('omits the aggregate bounds when a part needs an unknown rate', () => {
    const price = { ...rates, tiers: [{ ...rates.tiers![0]!, outputRate: null }] };
    const result = compute([part(150000), part(300000)], price);
    expect(result).toMatchObject({
      costUsd: 0,
      unpricedBuckets: ['output'],
      tier: { state: 'unknown' },
    });
    expect(result.tier).not.toHaveProperty('lowUsd');
    expect(result.tier).not.toHaveProperty('highUsd');
  });
  it('refuses a foreign model part rather than applying the invocation model rates', () => {
    const foreign = part(1000);
    foreign.usage.wholeRun!.usage.model = 'another-model';
    const result = compute([part(1000), foreign]);
    expect(result.tier!.state).toBe('unknown');
    expect(result.tier).not.toHaveProperty('lowUsd');
  });
  it('refuses missing part totals even when the remaining proof fits the invocation', () => {
    const known = part(1000);
    const requestUsage = aggregateRequestUsage([
      known,
      { id: 'missing', usage: unknownRequestUsage() },
    ]);
    const result = computeInvocationCost(known.tokenUsage, rates, {
      inputIncludesCache: true,
      modelKey: 'model',
      requestUsage,
    });
    expect(result.tier!.state).toBe('unknown');
    expect(result.tier).not.toHaveProperty('lowUsd');
  });
  it('leaves the untiered path unchanged and reads legacy leaf captures', () => {
    const single = part(150000);
    expect(
      computeInvocationCost(single.tokenUsage, rates, {
        inputIncludesCache: true,
        modelKey: 'model',
        requestUsage: single.usage,
      }).tier!.state,
    ).toBe('exact');
    expect(compute([part(150000), part(150000)], base)).toEqual(
      computeInvocationCost(tokens(300000, 20), base, { inputIncludesCache: true }),
    );
  });
});
