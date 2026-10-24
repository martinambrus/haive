import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  getJob: vi.fn(async (_id: string): Promise<unknown> => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ getJob: h.getJob }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CLI_EXEC_JOB_NAMES, VERSION_REFRESH_JOB_ID } from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const SCHEDULER_ID = `repeat:${VERSION_REFRESH_JOB_ID}:1792800000000`;
const routes = [
  { path: '/catalog/claude-code/refresh-versions', name: CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS },
  { path: `/${PROVIDER}/test`, name: CLI_EXEC_JOB_NAMES.PROBE },
  { path: `/${PROVIDER}/sign-out`, name: CLI_EXEC_JOB_NAMES.SIGN_OUT },
];
const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

beforeEach(() => {
  const fake = createFakeDb({ cliProviders: schema.cliProviders });
  fake.insert(schema.cliProviders, { id: PROVIDER, userId: USER });
  h.db = fake.db;
  h.getJob.mockReset();
});

function job(name: string, data = { providerId: PROVIDER, userId: USER }) {
  return { name, data, getState: vi.fn(async () => 'active') };
}

describe.each(routes)('poll $path', ({ path, name }) => {
  it.each([
    'abc',
    '0',
    '-1',
    '1.2',
    '1e3',
    '01',
    '1:logs',
    'repeat:other:1792800000000',
    `repeat:${VERSION_REFRESH_JOB_ID}:abc`,
    `repeat:${VERSION_REFRESH_JOB_ID}:1:logs`,
    '1\n',
  ])('rejects malformed id %j before looking it up', async (id) => {
    h.getJob.mockResolvedValue(job(name));
    const res = await app.request(`${path}/${encodeURIComponent(id)}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'job not found — it may have expired',
      code: 'job_expired',
    });
    expect(h.getJob).not.toHaveBeenCalled();
  });

  it('accepts an ordinary queue id', async () => {
    h.getJob.mockResolvedValue(job(name));
    const res = await app.request(`${path}/123`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending', state: 'active' });
    expect(h.getJob).toHaveBeenCalledWith('123');
  });

  it('hides a different job kind', async () => {
    h.getJob.mockResolvedValue(job('another-kind'));
    const res = await app.request(`${path}/123`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'job_expired' });
  });

  it('answers a missing job with the same 404', async () => {
    const res = await app.request(`${path}/123`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'job_expired' });
  });
});

it('accepts a scheduler-shaped refresh id', async () => {
  h.getJob.mockResolvedValue(job(CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS));
  const res = await app.request(`${routes[0]!.path}/${SCHEDULER_ID}`);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'pending', state: 'active' });
  expect(h.getJob).toHaveBeenCalledWith(SCHEDULER_ID);
});

describe.each(routes.slice(1))('ownership on $path', ({ path, name }) => {
  it.each([
    { providerId: 'other-provider', userId: USER },
    { providerId: PROVIDER, userId: 'other-user' },
  ])('hides a job owned by $providerId / $userId', async (data) => {
    h.getJob.mockResolvedValue(job(name, data));
    const res = await app.request(`${path}/123`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'job_expired' });
  });
});
