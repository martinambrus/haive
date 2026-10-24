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
  const fake = createFakeDb({ users: schema.users });
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
  it('queues a catalog refresh with an empty payload', async () => {
    const res = await refresh();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: '1' });
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add).toHaveBeenCalledWith(
      CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
      {},
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
