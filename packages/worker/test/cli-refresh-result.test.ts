import { beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { CLI_PROVIDER_LIST, configService } from '@haive/shared';
import { refreshModelPrices } from '../src/cli-versions/model-prices.js';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => ({
  cli: vi.fn(),
  tools: vi.fn(),
  catalog: vi.fn(),
  browsers: vi.fn(),
  ruby: vi.fn(),
  prices: vi.fn(),
  fx: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@haive/shared', async (original) => {
  const actual = await original<typeof import('@haive/shared')>();
  const child = actual.logger.child({ test: 'refresh-result' });
  vi.spyOn(child, 'warn').mockImplementation(h.warn);
  return { ...actual, logger: { child: () => child } };
});
vi.mock('../src/cli-versions/index.js', () => ({
  refreshAllCliVersions: h.cli,
  refreshAllToolVersions: h.tools,
  refreshOpenRouterModels: h.catalog,
  refreshBrowserVersions: h.browsers,
  refreshRubyVersions: h.ruby,
  refreshModelPrices: h.prices,
  refreshFxRates: h.fx,
}));
import { handleRefreshCliVersionsJob } from '../src/queues/cli-exec/handlers.js';

beforeEach(() => {
  for (const fn of Object.values(h))
    fn.mockReset().mockResolvedValue({ ok: true, refreshed: [], errors: [] });
});
const fixture = () => createFakeDb({ refreshRuns: schema.refreshRuns });
it('does not let a delayed older start replace a newer run or its completion', async () => {
  const fake = fixture();
  let release!: () => void;
  fake.hooks.beforeInsert = async () => {
    fake.hooks.beforeInsert = null;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  // Pin the actual Date constructor, not just Date.now, used by the start write.
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    const older = handleRefreshCliVersionsJob(fake.db as unknown as Database, 'boot');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    vi.setSystemTime(new Date('2026-11-11T13:00:00Z'));
    const newer = await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'manual');
    const row = await fake.db.query.refreshRuns.findFirst();
    release();
    await older;
    expect(await fake.db.query.refreshRuns.findFirst()).toEqual(row);
    expect(row).toMatchObject({ runId: newer.runId, trigger: 'manual', result: newer });
    expect(h.warn).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it('persists a scheduled refresh and its failing FX source', async () => {
  const fake = fixture();
  h.fx.mockResolvedValue({
    ok: false,
    refreshed: [],
    errors: [{ name: 'fx', error: 'ECB HTTP 503' }],
  });
  h.cli.mockResolvedValue({
    ok: true,
    refreshed: [{ name: 'codex', count: 2, latest: '1' }],
    errors: [],
  });
  const result = await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'scheduled');
  const row = await fake.db.query.refreshRuns.findFirst();
  expect(row).toMatchObject({ kind: 'versions', trigger: 'scheduled', result });
  expect(result).toMatchObject({
    runId: row?.runId,
    startedAt: (row?.startedAt as Date).toISOString(),
  });
  expect(row?.startedAt).toBeInstanceOf(Date);
  expect(row?.finishedAt).toBeInstanceOf(Date);
  expect(result.errors).toEqual([{ name: 'fx', error: 'ECB HTTP 503' }]);
});
it('leaves an unfinished record when a run throws, replacing earlier success', async () => {
  const fake = fixture();
  await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'boot');
  h.prices.mockRejectedValue(new Error('worker interrupted'));
  await expect(
    handleRefreshCliVersionsJob(fake.db as unknown as Database, 'manual'),
  ).rejects.toThrow('worker interrupted');
  expect(await fake.db.query.refreshRuns.findFirst()).toMatchObject({
    trigger: 'manual',
    finishedAt: null,
    result: null,
  });
});
it('does not let an older concurrent completion overwrite the newer run', async () => {
  const fake = fixture();
  let release!: (result: unknown) => void;
  h.fx.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const older = handleRefreshCliVersionsJob(fake.db as unknown as Database, 'boot');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'manual');
  release({ ok: false, refreshed: [], errors: [{ name: 'fx', error: 'old failure' }] });
  await older;
  expect(await fake.db.query.refreshRuns.findFirst()).toMatchObject({
    trigger: 'manual',
    result: { ok: true },
  });
});
it('bounds each persisted failure reason', async () => {
  const fake = fixture();
  h.fx.mockResolvedValue({
    ok: false,
    refreshed: [],
    errors: [{ name: 'fx', error: 'x'.repeat(20_000) }],
  });
  await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'scheduled');
  const row = await fake.db.query.refreshRuns.findFirst();
  expect((row?.result as { errors: { error: string }[] }).errors[0]?.error).toHaveLength(2000);
});

it.each(['start', 'finish'] as const)(
  'continues refreshing when the %s result write fails and logs it',
  async (phase) => {
    const fake = fixture();
    const err = new Error('result store unavailable');
    if (phase === 'start')
      vi.spyOn(fake.db, 'insert').mockImplementationOnce(() => {
        throw err;
      });
    else
      vi.spyOn(fake.db, 'update').mockImplementationOnce(() => {
        throw err;
      });
    const result = await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'manual');
    expect(result.ok).toBe(true);
    for (const fn of [h.cli, h.tools, h.catalog, h.browsers, h.ruby, h.prices, h.fx])
      expect(fn).toHaveBeenCalledOnce();
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err, runId: result.runId }),
      expect.any(String),
    );
    if (phase === 'finish')
      expect(await fake.db.query.refreshRuns.findFirst()).toMatchObject({
        finishedAt: null,
        result: null,
      });
  },
);

it('persists and returns the structural skipped-source list', async () => {
  const fake = fixture();
  h.prices.mockResolvedValue({ ok: true, refreshed: [], errors: [], skipped: ['prices'] });
  const result = await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'scheduled');
  expect(result).toMatchObject({ ok: true, skipped: ['prices'] });
  expect(await fake.db.query.refreshRuns.findFirst()).toMatchObject({
    result: { skipped: ['prices'] },
  });
});

it('persists known unsupported pricing reasons without failing the refresh', async () => {
  const fake = fixture();
  const unsupported = [
    { model: 'timed', reason: 'time-window' },
    { model: 'openrouter/auto', reason: 'variable-price' },
  ];
  h.prices.mockResolvedValue({ ok: true, refreshed: [], errors: [], unsupported });
  const result = await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'scheduled');
  expect(result).toMatchObject({ ok: true, errors: [], unsupported });
  expect(await fake.db.query.refreshRuns.findFirst()).toMatchObject({
    result: { ok: true, errors: [], unsupported },
  });
});

it.each(['55P03', '23505'])(
  'finishes the run as failed and refreshes FX after price SQLSTATE %s',
  async (code) => {
    const fake = createFakeDb({
      refreshRuns: schema.refreshRuns,
      cliPricingSync: schema.cliPricingSync,
      cliModelPrices: schema.cliModelPrices,
    });
    for (const provider of CLI_PROVIDER_LIST)
      fake.insert(schema.cliPricingSync, {
        name: provider.name,
        autoUpdateEnabled: provider.name === 'codex',
      });
    const config = vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        x: { mode: 'chat', litellm_provider: 'openai', input_cost_per_token: 1 },
      }),
    } as Response);
    const error = Object.assign(new Error('query values must stay private'), {
      params: ['private-value'],
      cause: Object.assign(new Error('driver detail must stay private'), { code }),
    });
    const transaction = vi.spyOn(fake.db, 'transaction').mockRejectedValueOnce(error);
    h.prices.mockImplementation(refreshModelPrices);
    h.fx.mockResolvedValue({
      ok: true,
      refreshed: [{ name: 'fx', count: 1, latest: '2026-11-14' }],
      errors: [],
    });
    try {
      const result = await handleRefreshCliVersionsJob(fake.db as unknown as Database, 'scheduled');
      expect(result).toMatchObject({
        ok: false,
        errors: [
          {
            name: 'price:database',
            error:
              code === '55P03' ? 'Model price refresh lock timed out' : 'Database operation failed',
          },
        ],
        refreshed: [{ name: 'fx', count: 1 }],
      });
      expect(h.fx).toHaveBeenCalledOnce();
      expect(await fake.db.query.refreshRuns.findFirst()).toMatchObject({
        finishedAt: expect.any(Date),
        result,
      });
      expect(JSON.stringify(result)).not.toMatch(/private/);
    } finally {
      transaction.mockRestore();
      network.mockRestore();
      config.mockRestore();
    }
  },
);
