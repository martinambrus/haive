import { beforeEach, describe, expect, it, vi } from 'vitest';
const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown, git: vi.fn(), entry: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  lstatNoFollow: h.entry,
}));
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
  h.entry.mockReset().mockResolvedValue({ kind: 'directory' });
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
describe('link origin uses git exit codes', () => {
  it('updates after exit 3 regardless of human wording', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(3, 'different language'));
    expect((await link()).status).toBe(200);
    expect(h.git.mock.calls[2]![1]).toContain('--unset-all');
    expect(h.git.mock.calls[3]![1]).toContain('--replace-all');
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe('https://example.test/r');
  });
  it('does not mistake an unrelated failure with already-exists words for exit 3', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(128, 'remote origin already exists'));
    expect((await link()).status).toBe(409);
    expect(h.git).toHaveBeenCalledTimes(2);
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  });
  it('fails a non-zero URL replacement without persisting the row', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(3, 'remote origin already exists'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(fail(128, 'broken config'));
    const res = await link();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Could not update');
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  });
});
it.each([0, 5])('accepts push URL cleanup exit %s', async (code) => {
  h.git
    .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
    .mockRejectedValueOnce(fail(3, 'different language'));
  if (code === 5) h.git.mockRejectedValueOnce(fail(5, 'missing key'));
  expect((await link()).status).toBe(200);
  expect(h.git.mock.calls[2]![1]).toContain('--unset-all');
});
it('does not persist a relink whose push URL cleanup failed', async () => {
  h.git
    .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
    .mockRejectedValueOnce(fail(3, 'different language'))
    .mockRejectedValueOnce(fail(128, 'different language'));
  expect((await link()).status).toBe(409);
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
});
