import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => ({ id: 'job-1' })),
  getJob: vi.fn(async (_id: string): Promise<undefined> => undefined),
  getJobs: vi.fn(async (_states: string[]): Promise<{ id: string; name: string }[]> => []),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ add: h.add, getJob: h.getJob, getJobs: h.getJobs }),
  getUsagePollQueue: () => ({ add: vi.fn() }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { secretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';

const app = new Hono<AppEnv>();
app.route('/cli-providers', cliProviderRoutes);
app.onError(errorHandler);

async function call(method: string, path: string, signedIn: boolean) {
  const token = signedIn ? await signAccessToken({ sub: USER, role: 'user', tv: 0 }) : null;
  const res = await app.request(`/cli-providers${path}`, {
    method,
    headers: token ? { cookie: `${ACCESS_COOKIE}=${token}` } : {},
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('the CLI catalog routes require a session', () => {
  beforeEach(() => {
    const fake = createFakeDb({
      users: schema.users,
      cliPackageVersions: schema.cliPackageVersions,
    });
    fake.insert(schema.users, { id: USER, role: 'user', status: 'active', tokenVersion: 0 });
    h.db = fake.db;
    h.add.mockReset();
    h.add.mockResolvedValue({ id: '1' });
    h.getJobs.mockReset();
    h.getJobs.mockResolvedValue([]);
    h.getJob.mockClear();
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a signed-out refresh and queues nothing', async () => {
    const reply = await call('POST', '/catalog/claude-code/refresh-versions', false);

    expect(reply.status).toBe(401);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('answers a signed-out refresh of an unknown CLI with 401, not the name error', async () => {
    const reply = await call('POST', '/catalog/not-a-cli/refresh-versions', false);

    expect(reply.status).toBe(401);
  });

  it('refuses a signed-out poll without looking the job up', async () => {
    const reply = await call('GET', '/catalog/claude-code/refresh-versions/1', false);

    expect(reply.status).toBe(401);
    expect(h.getJob).not.toHaveBeenCalled();
  });

  it('refuses a signed-out catalog read', async () => {
    expect((await call('GET', '/catalog', false)).status).toBe(401);
  });

  it('queues a refresh for a signed-in user', async () => {
    const reply = await call('POST', '/catalog/claude-code/refresh-versions', true);

    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ jobId: '1' });
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add.mock.calls[0]?.[0]).toBe('cli-refresh-versions');
    expect(h.add.mock.calls[0]?.[1]).toEqual({});
  });

  it('reuses the refresh on a second POST while it is in flight', async () => {
    const jobs: { id: string; name: string }[] = [];
    h.getJobs.mockImplementation(async () => jobs);
    h.add.mockImplementation(async (name) => {
      const job = { id: String(jobs.length + 1), name: String(name) };
      jobs.push(job);
      return job;
    });

    const first = await call('POST', '/catalog/claude-code/refresh-versions', true);
    const second = await call('POST', '/catalog/codex/refresh-versions', true);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.getJobs).toHaveBeenCalledWith(['active', 'wait', 'prioritized'], 0, 99);
  });

  it.each(['active', 'wait', 'prioritized'])('reuses a refresh from %s', async (state) => {
    h.getJobs.mockImplementation(async (states) =>
      states.includes(state) ? [{ id: '42', name: 'cli-refresh-versions' }] : [],
    );

    const reply = await call('POST', '/catalog/claude-code/refresh-versions', true);

    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ jobId: '42' });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('reuses a scheduler refresh id', async () => {
    const id = 'repeat:cli-refresh-versions-repeatable:1792800000000';
    h.getJobs.mockResolvedValue([{ id, name: 'cli-refresh-versions' }]);

    const reply = await call('POST', '/catalog/claude-code/refresh-versions', true);

    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ jobId: id });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('adds a refresh when only other job kinds are in flight', async () => {
    h.getJobs.mockResolvedValue([{ id: '42', name: 'cli-probe' }]);

    const reply = await call('POST', '/catalog/claude-code/refresh-versions', true);

    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ jobId: '1' });
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add.mock.calls[0]?.[2]).not.toHaveProperty('jobId');
  });

  it.each([new Error('Redis unavailable'), new SyntaxError('invalid job JSON')])(
    'still enqueues when the in-flight scan fails: %s',
    async (err) => {
      h.getJobs.mockRejectedValue(err);

      const reply = await call('POST', '/catalog/claude-code/refresh-versions', true);

      expect(reply.status).toBe(202);
      expect(reply.body).toEqual({ jobId: '1' });
      expect(h.add).toHaveBeenCalledTimes(1);
    },
  );

  it('can enqueue twice when simultaneous POSTs both scan an empty queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let scans = 0;
    h.getJobs.mockImplementation(async () => {
      if (++scans === 2) release();
      await gate;
      return [];
    });
    let nextId = 0;
    h.add.mockImplementation(async () => ({ id: String(++nextId) }));

    const replies = await Promise.all([
      call('POST', '/catalog/claude-code/refresh-versions', true),
      call('POST', '/catalog/codex/refresh-versions', true),
    ]);

    expect(replies.map((r) => r.status)).toEqual([202, 202]);
    expect(new Set(replies.map((r) => r.body.jobId)).size).toBe(2);
    expect(h.add).toHaveBeenCalledTimes(2);
  });

  it('lets a signed-in user reach the poll handler', async () => {
    const reply = await call('GET', '/catalog/claude-code/refresh-versions/1', true);

    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe('job_expired');
  });

  it('lists the providers for a signed-in user', async () => {
    const reply = await call('GET', '/catalog', true);

    expect(reply.status).toBe(200);
    const names = reply.body.providers.map((p: { name: string }) => p.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('claude-code');
  });
});
