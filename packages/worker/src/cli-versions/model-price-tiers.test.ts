import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CLI_PROVIDER_LIST, configService, trimOpenRouterModels } from '@haive/shared';
import { refreshOpenRouterModels } from './openrouter-models.js';
import { refreshModelPrices } from './model-prices.js';
import { resolveInvocationCost } from '../queues/cli-exec/invocation-cost.js';

import modalities from '../../../shared/test/fixtures/pricing/litellm-modalities.json' with { type: 'json' };

const base = {
  inputRate: 1,
  outputRate: 2,
  cacheReadRate: null,
  cacheWriteRate: null,
  cacheWrite1hRate: null,
};
const raw = {
  mode: 'chat',
  litellm_provider: 'openai',
  input_cost_per_token: 1,
  output_cost_per_token: 2,
};
let feed: unknown;
let fake: ReturnType<typeof createFakeDb>;
let db: Database;
beforeEach(() => {
  vi.spyOn(configService, 'getBoolean').mockImplementation(
    async (_key, fallback) => fallback ?? true,
  );
  feed = { x: raw };
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => ({ ok: true, json: async () => feed }) as Response,
  );
  fake = createFakeDb({
    cliPricingSync: schema.cliPricingSync,
    cliModelPrices: schema.cliModelPrices,
    openrouterModelCache: schema.openrouterModelCache,
    cliProviders: schema.cliProviders,
  });
  db = fake.db as unknown as Database;
  for (const p of CLI_PROVIDER_LIST)
    fake.insert(schema.cliPricingSync, {
      name: p.name,
      autoUpdateEnabled: p.name === 'codex',
      preferredFeed: null,
    });
});
afterEach(() => vi.restoreAllMocks());
async function live() {
  return (await fake.db.select().from(schema.cliModelPrices)).filter((r) => r.effectiveTo === null);
}
async function cost(providerName = 'codex') {
  return resolveInvocationCost(db, {
    cliProviderId: null,
    providerName,
    modelIdentity: { requested: 'x', served: 'x', billed: [], source: 'configured' } as never,
    tokenUsage: { inputTokens: 1, outputTokens: 1 } as never,
  });
}

describe('tier refresh lifecycle', () => {
  it('leaves untiered rows alone, replaces tiered rows once, then stops writing', async () => {
    for (const [modelKey, tiers] of [
      ['x', undefined],
      ['empty', []],
      ['null', null],
    ] as const)
      fake.insert(schema.cliModelPrices, {
        provider: 'codex',
        modelKey,
        source: 'litellm',
        rates: { ...base, ...(tiers === undefined ? {} : { tiers }) },
        effectiveTo: null,
      });
    feed = { x: raw, empty: raw, null: raw };
    await refreshModelPrices(db);
    expect(await fake.db.select().from(schema.cliModelPrices)).toHaveLength(3);
    feed = { x: { ...raw, input_cost_per_token_above_1k_tokens: 5 }, empty: raw, null: raw };
    await refreshModelPrices(db);
    const rows = await fake.db.select().from(schema.cliModelPrices);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.effectiveTo !== null)).toHaveLength(1);
    await refreshModelPrices(db);
    expect(await fake.db.select().from(schema.cliModelPrices)).toHaveLength(4);
  });
  it.each([{ tiered_pricing: [] }, { input_cost_per_token_above_unknown: 5 }])(
    'replaces stale prices with unsupported markers and recovers (%j)',
    async (extra) => {
      expect((await refreshModelPrices(db)).ok).toBe(true);
      expect(await cost()).toMatchObject({ source: 'computed' });
      const snapshot = await cost();
      feed = { x: { ...raw, ...extra } };
      const result = await refreshModelPrices(db);
      expect(result.errors).toEqual([{ name: 'price:codex', error: expect.stringContaining('x') }]);
      expect((await live())[0]!.rates).toMatchObject({ pricingState: 'unsupported' });
      expect(await cost()).toMatchObject({ source: 'none', billable: false });
      expect(snapshot).toMatchObject({ source: 'computed' });
      const historyLength = (await fake.db.select().from(schema.cliModelPrices)).length;
      await refreshModelPrices(db);
      expect(await fake.db.select().from(schema.cliModelPrices)).toHaveLength(historyLength);
      expect(
        await fake.db.query.cliPricingSync!.findFirst({
          where: eq(schema.cliPricingSync.name, 'codex'),
        }),
      ).toMatchObject({ fetchError: expect.stringContaining('x') });
      feed = { x: raw };
      expect((await refreshModelPrices(db)).ok).toBe(true);
      expect((await live())[0]!.rates).not.toHaveProperty('pricingState');
      expect(await cost()).toMatchObject({ source: 'computed' });
    },
  );
  it('keeps last-good on a whole-feed failure', async () => {
    await refreshModelPrices(db);
    vi.mocked(fetch).mockRejectedValue(new Error('network unavailable'));
    expect((await refreshModelPrices(db)).ok).toBe(false);
    expect(await cost()).toMatchObject({ source: 'computed' });
    expect(await fake.db.select().from(schema.cliModelPrices)).toHaveLength(1);
  });
  it('rolls back the close when replacing the price fails', async () => {
    await refreshModelPrices(db);
    feed = { x: { ...raw, tiered_pricing: [] } };
    fake.hooks.beforeInsert = (table) => {
      if (table === schema.cliModelPrices) throw new Error('insert failed');
    };
    await expect(refreshModelPrices(db)).rejects.toThrow('insert failed');
    expect(await cost()).toMatchObject({ source: 'computed' });
    expect(await fake.db.select().from(schema.cliModelPrices)).toHaveLength(1);
  });
  it('counts known OpenRouter time windows without errors and restores supported tiers', async () => {
    await fake.db
      .update(schema.cliPricingSync)
      .set({ autoUpdateEnabled: true })
      .where(eq(schema.cliPricingSync.name, 'openrouter'));
    const cache = async (overrides: unknown[]) => {
      const models = trimOpenRouterModels({
        data: [{ id: 'x', pricing: { prompt: '1', completion: '2', overrides } }],
      });
      await fake.db
        .insert(schema.openrouterModelCache)
        .values({ name: 'openrouter', models })
        .onConflictDoUpdate({ target: schema.openrouterModelCache.name, set: { models } });
    };
    await cache([]);
    await refreshModelPrices(db);
    expect(await cost('openrouter')).toMatchObject({ source: 'computed' });
    await cache([{ utc_start: 1, utc_end: 2, prompt: '3' }]);
    const result = await refreshModelPrices(db);
    expect(result).toMatchObject({
      ok: true,
      errors: [],
      unsupported: [{ model: 'x', reason: 'time-window' }],
    });
    expect((await live()).find((r) => r.provider === 'openrouter')!.rates).toMatchObject({
      pricingState: 'unsupported',
    });
    expect(await cost('openrouter')).toMatchObject({ source: 'none', billable: false });
    await cache([{ min_prompt_tokens: 100, prompt: '3' }]);
    await refreshModelPrices(db);
    expect((await live()).find((r) => r.provider === 'openrouter')!.rates).toMatchObject({
      tiers: [{ aboveTokens: 100, inputRate: 3 }],
    });
  });
});

it('counts unsupported catalog overrides in the refresh result and retains cache on network failure', async () => {
  feed = {
    data: [
      {
        id: 'timed',
        pricing: {
          prompt: '1',
          overrides: [
            { utc_start: 1, utc_end: 2, prompt: '2' },
            { region: 'new', completion: '3' },
          ],
        },
      },
    ],
  };
  const result = await refreshOpenRouterModels(db);
  expect(result).toMatchObject({
    ok: false,
    errors: [
      {
        name: 'price:openrouter',
        error: expect.stringContaining('timed: unsupported-condition (2 overrides)'),
      },
    ],
  });
  const stored = await fake.db.query.openrouterModelCache!.findFirst();
  expect(stored!.models).toMatchObject([
    { pricingState: 'unsupported', unsupportedOverrideCount: 2 },
  ]);
  vi.mocked(fetch).mockRejectedValue(new Error('gateway unavailable'));
  expect((await refreshOpenRouterModels(db)).ok).toBe(false);
  expect((await fake.db.query.openrouterModelCache!.findFirst())!.models).toEqual(stored!.models);
});

it('syncs live Gemini modality shapes without a price error', async () => {
  await fake.db
    .update(schema.cliPricingSync)
    .set({ autoUpdateEnabled: true })
    .where(eq(schema.cliPricingSync.name, 'gemini'));
  feed = modalities;
  const result = await refreshModelPrices(db);
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
  expect((await live()).filter((r) => r.provider === 'gemini')).toHaveLength(2);
  expect((await live()).every((r) => !r.rates.pricingState)).toBe(true);
});

it('counts known time windows as successful catalog refreshes', async () => {
  feed = {
    data: [
      {
        id: 'timed',
        pricing: { prompt: '1', overrides: [{ utc_start: 1, utc_end: 2, prompt: '2' }] },
      },
    ],
  };
  const result = await refreshOpenRouterModels(db);
  expect(result).toMatchObject({ ok: true, errors: [] });
  expect((await fake.db.query.openrouterModelCache!.findFirst())!.models).toMatchObject([
    { id: 'timed', pricingState: 'unsupported', pricingReason: 'time-window' },
  ]);
});

it('closes an existing negative OpenRouter price with a variable-price marker', async () => {
  await fake.db
    .update(schema.cliPricingSync)
    .set({ autoUpdateEnabled: true })
    .where(eq(schema.cliPricingSync.name, 'openrouter'));
  fake.insert(schema.cliModelPrices, {
    provider: 'openrouter',
    modelKey: 'x',
    source: 'openrouter',
    rates: { ...base, inputRate: -1, outputRate: -1 },
    effectiveTo: null,
  });
  // An old catalog cache can still carry negative prices until its next refresh.
  const [model] = trimOpenRouterModels({ data: [{ id: 'x', pricing: { prompt: '1' } }] });
  fake.insert(schema.openrouterModelCache, {
    name: 'openrouter',
    models: [{ ...model!, promptPrice: -1, completionPrice: -1 }],
  });
  const result = await refreshModelPrices(db);
  expect(result).toMatchObject({
    ok: true,
    errors: [],
    unsupported: [{ model: 'x', reason: 'variable-price' }],
  });
  const rows = (await fake.db.select().from(schema.cliModelPrices)).filter(
    (r) => r.provider === 'openrouter',
  );
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.effectiveTo !== null)).toHaveLength(1);
  expect((await live()).find((r) => r.provider === 'openrouter')!.rates).toMatchObject({
    inputRate: null,
    outputRate: null,
    pricingState: 'unsupported',
    pricingReason: 'variable-price',
  });
  expect(await cost('openrouter')).toMatchObject({ source: 'none' });
});
