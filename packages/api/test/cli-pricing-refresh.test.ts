import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => ({ id: '1' })),
  getJob: vi.fn(async (_id: string): Promise<unknown> => undefined),
  getJobs: vi.fn(async (_states: string[]): Promise<{ id: string; name: string }[]> => []),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ add: h.add, getJobs: h.getJobs, getJob: h.getJob }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CLI_EXEC_JOB_NAMES, CLI_POLLABLE_JOB_OPTS, secretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { cliPricingRoutes } from '../src/routes/cli-pricing.js';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import type { AppEnv } from '../src/context.js';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000a2';
const app = new Hono<AppEnv>();
app.route('/pricing', cliPricingRoutes);
app.route('/providers', cliProviderRoutes);
app.onError(errorHandler);

async function refresh(path = '/pricing/refresh', role: 'admin' | 'user' | null = 'admin') {
  const token = role
    ? await signAccessToken({ sub: role === 'user' ? USER : ADMIN, role, tv: 0 })
    : null;
  return app.request(path, {
    method: 'POST',
    headers: token ? { cookie: `${ACCESS_COOKIE}=${token}` } : {},
  });
}

beforeEach(() => {
  const fake = createFakeDb({
    users: schema.users,
    refreshRuns: schema.refreshRuns,
    cliModelPrices: schema.cliModelPrices,
    cliPricingSync: schema.cliPricingSync,
  });
  fake.insert(schema.users, { id: ADMIN, role: 'admin', status: 'active', tokenVersion: 0 });
  fake.insert(schema.users, { id: USER, role: 'user', status: 'active', tokenVersion: 0 });
  h.db = fake.db;
  h.add.mockReset().mockResolvedValue({ id: '1' });
  h.getJob.mockReset();
  h.getJobs.mockReset().mockResolvedValue([]);
  vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
});
afterEach(() => vi.restoreAllMocks());

describe('pricing refresh', () => {
  it('refuses a refresh without a job id', async () => {
    h.add.mockResolvedValue({ id: '' });
    const res = await refresh();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'refresh_enqueue_failed' });
  });

  it('queues a catalog refresh with its manual trigger', async () => {
    const res = await refresh();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: '1' });
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add).toHaveBeenCalledWith(
      CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
      { trigger: 'manual' },
      CLI_POLLABLE_JOB_OPTS,
    );
    expect(h.add.mock.calls[0]?.[2]).not.toHaveProperty('jobId');
  });

  it.each(['active', 'wait', 'prioritized'])('reuses a refresh from %s', async (state) => {
    h.getJobs.mockImplementation(async (states) =>
      states.includes(state) ? [{ id: '42', name: CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS }] : [],
    );

    const res = await refresh();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: '42' });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('shares the pricing refresh with the provider route', async () => {
    const jobs: { id: string; name: string }[] = [];
    h.getJobs.mockImplementation(async () => jobs);
    h.add.mockImplementation(async (name) => {
      const job = { id: '1', name: String(name) };
      jobs.push(job);
      return job;
    });

    const pricing = await refresh();
    const provider = await refresh('/providers/catalog/codex/refresh-versions');

    expect(pricing.status).toBe(200);
    expect(provider.status).toBe(202);
    expect(await provider.json()).toEqual(await pricing.json());
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('still enqueues when the bounded scan fails', async () => {
    h.getJobs.mockRejectedValue(new Error('Redis unavailable'));

    const res = await refresh();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: '1' });
    expect(h.getJobs).toHaveBeenCalledWith(['active', 'wait', 'prioritized'], 0, 99);
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('requires a session before scanning or enqueueing', async () => {
    expect((await refresh('/pricing/refresh', null)).status).toBe(401);
    expect(h.getJobs).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });
});

async function poll(id = '123', role: 'admin' | 'user' | null = 'admin') {
  const token = role
    ? await signAccessToken({ sub: role === 'user' ? USER : ADMIN, role, tv: 0 })
    : null;
  return app.request(`/pricing/refresh/${encodeURIComponent(id)}`, {
    headers: token ? { cookie: `${ACCESS_COOKIE}=${token}` } : {},
  });
}

describe('durable refresh result', () => {
  it('returns a stored scheduled failure to an admin after the job is gone', async () => {
    const result = { ok: false, refreshed: [], errors: [{ name: 'fx', error: 'ECB unavailable' }] };
    await (h.db as ReturnType<typeof createFakeDb>['db']).insert(schema.refreshRuns).values({
      kind: 'versions',
      runId: ADMIN,
      trigger: 'scheduled',
      startedAt: new Date('2026-11-01T00:00:00Z'),
      finishedAt: new Date('2026-11-01T00:01:00Z'),
      result,
    });
    const res = await poll('latest');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ run: { trigger: 'scheduled', result } });
    expect(h.getJob).not.toHaveBeenCalled();
  });
  it('returns null before the first run', async () => {
    expect(await (await poll('latest')).json()).toEqual({ run: null });
  });
  it('refuses non-admins and anonymous callers', async () => {
    expect((await poll('latest', 'user')).status).toBe(403);
    expect((await poll('latest', null)).status).toBe(401);
  });
  it.each(['admin', 'user', null] as const)(
    'keeps the provider form result admin-only (%s)',
    async (role) => {
      await (h.db as ReturnType<typeof createFakeDb>['db']).insert(schema.refreshRuns).values({
        kind: 'versions',
        runId: ADMIN,
        trigger: 'boot',
        startedAt: new Date(),
        finishedAt: null,
        result: null,
      });
      const token = role
        ? await signAccessToken({ sub: role === 'user' ? USER : ADMIN, role, tv: 0 })
        : null;
      const res = await app.request('/providers/catalog/codex/refresh-result', {
        headers: token ? { cookie: `${ACCESS_COOKIE}=${token}` } : {},
      });
      expect(res.status).toBe(role ? 200 : 401);
      if (role === 'admin')
        expect(await res.json()).toMatchObject({
          run: { trigger: 'boot', finishedAt: null, result: null },
        });
      if (role === 'user') expect(await res.json()).toEqual({ run: null });
    },
  );
});

describe('pricing refresh polling', () => {
  it.each(['waiting', 'prioritized', 'delayed', 'active'])(
    'reports pending %s from job state',
    async (state) => {
      h.getJob.mockResolvedValue({
        name: CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
        getState: async () => state,
      });
      const res = await poll();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'pending', state });
    },
  );

  it('returns the completed result for a scheduler job id', async () => {
    const result = { ok: true, refreshed: [], errors: [] };
    h.getJob.mockResolvedValue({
      name: CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
      getState: async () => 'completed',
      returnvalue: result,
    });
    const res = await poll('repeat:cli-refresh-versions-repeatable:1792800000000');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'done', result });
  });

  it('passes a result with a failed source through unchanged', async () => {
    const result = {
      ok: false,
      refreshed: [{ name: 'claude-code', count: 3, latest: '1.2.3' }],
      errors: [{ name: 'fx', error: 'fx feed HTTP 503' }],
    };
    h.getJob.mockResolvedValue({
      name: CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
      getState: async () => 'completed',
      returnvalue: result,
    });
    const res = await poll();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'done', result });
  });

  it('returns the job failure', async () => {
    h.getJob.mockResolvedValue({
      name: CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
      getState: async () => 'failed',
      failedReason: 'refresh worker crashed',
    });
    expect(await (await poll()).json()).toEqual({
      status: 'failed',
      error: 'refresh worker crashed',
    });
  });

  it.each(['123', 'abc', '1:logs', 'repeat:other:1792800000000'])(
    'reports missing or malformed job %s by code',
    async (id) => {
      const res = await poll(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'job_expired' });
    },
  );

  it('hides another job kind', async () => {
    h.getJob.mockResolvedValue({ name: CLI_EXEC_JOB_NAMES.PROBE });
    expect(await (await poll()).json()).toMatchObject({ code: 'job_expired' });
  });

  it.each([null, 'user'] as const)('requires an admin session (%s)', async (role) => {
    expect((await poll('123', role)).status).toBe(role === null ? 401 : 403);
    expect(h.getJob).not.toHaveBeenCalled();
  });
});

describe('manual context tiers', () => {
  const rates = {
    inputRate: 1,
    outputRate: 2,
    cacheReadRate: null,
    cacheWriteRate: null,
    cacheWrite1hRate: null,
  };
  const tier = { ...rates, aboveTokens: 100, inclusive: false, inputRate: null };
  async function request(method: string, body?: unknown, path = '/pricing/prices') {
    const token = await signAccessToken({ sub: ADMIN, role: 'admin', tv: 0 });
    return app.request(path, {
      method,
      headers: { cookie: `${ACCESS_COOKIE}=${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  it('round trips complete tiers through manual writes, reads and replacement history', async () => {
    const body = { provider: 'codex', modelKey: 'Tiered', rates: { ...rates, tiers: [tier] } };
    const saved = await request('POST', body);
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ rates: { tiers: [tier] } });
    expect(await (await request('GET', undefined, '/pricing')).json()).toMatchObject({
      prices: [{ rates: { tiers: [tier] } }],
    });
    expect(
      (await request('POST', { ...body, rates: { ...body.rates, outputRate: 3 } })).status,
    ).toBe(201);
    const history = (await (
      await request('GET', undefined, '/pricing/history?modelKey=tiered&provider=codex')
    ).json()) as { history: { rates: { tiers: unknown[] } }[] };
    expect(history.history).toHaveLength(2);
    expect(
      history.history.every((r: { rates: { tiers: unknown[] } }) => r.rates.tiers.length === 1),
    ).toBe(true);
  });
  it.each(
    [
      [{ ...tier, aboveTokens: 0 }],
      [{ ...tier, aboveTokens: 1.5 }],
      [{ ...tier, aboveTokens: Number.MAX_SAFE_INTEGER + 1 }],
      [tier, tier],
      [1, 2, 3, 4, 5].map((aboveTokens) => ({ ...tier, aboveTokens })),
      [{ ...tier, inputRate: -1 }],
      [{ ...tier, inputRate: '0' }],
    ].map((tiers) => ({ tiers })),
  )('refuses malformed manual tiers (%j)', async ({ tiers }) => {
    const res = await request('POST', {
      provider: 'codex',
      modelKey: 'x',
      rates: { ...rates, tiers },
    });
    expect(res.status).toBe(400);
    expect(
      await (h.db as ReturnType<typeof createFakeDb>['db']).select().from(schema.cliModelPrices),
    ).toHaveLength(0);
  });
});
