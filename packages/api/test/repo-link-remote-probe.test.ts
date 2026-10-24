import { beforeEach, describe, expect, it, vi } from 'vitest';
const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown, git: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(key: string, value: string): void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.git }) };
});
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);
let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    storagePath: '/repo',
    remoteUrl: null,
  });
  h.db = fake.db;
  h.git.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
});
const link = () =>
  app.request(`/${REPO}/remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remoteUrl: 'https://example.test/r' }),
  });
const fail = (code: number | string, stderr: string) =>
  Object.assign(new Error(stderr), { code, stderr });
describe('link origin work-tree probe', () => {
  it.each([128, 124, 'ENOENT'])('reports an unanswered probe (%s) as unknown', async (code) => {
    h.git.mockRejectedValueOnce(fail(code, 'probe failed'));
    const res = await link();
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain('could not be examined');
    expect(text).toContain('probe failed');
    expect(text).not.toContain('not a Git checkout');
    expect(h.git).toHaveBeenCalledTimes(1);
  });
  it('only calls a successful false probe not a checkout', async () => {
    h.git.mockResolvedValueOnce({ stdout: 'false\n', stderr: '' });
    const res = await link();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('not a Git checkout');
  });
  it('reports an unparsable successful probe as unknown', async () => {
    h.git.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const res = await link();
    expect(await res.text()).toContain('could not be examined');
  });
});
