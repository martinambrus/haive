import { beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => ({
  cli: vi.fn(),
  tools: vi.fn(),
  catalog: vi.fn(),
  browsers: vi.fn(),
  ruby: vi.fn(),
  prices: vi.fn(),
  fx: vi.fn(),
}));
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
