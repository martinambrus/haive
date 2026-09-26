import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues.js')>()),
  getRepoQueue: () => ({ add: h.add }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { REPO_JOB_NAMES } from '@haive/shared';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

function setup(repo: Record<string, unknown>, taskStatus?: string) {
  const fake = createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    ...repo,
  });
  if (taskStatus) {
    fake.insert(schema.tasks, {
      userId: USER,
      repositoryId: REPO,
      type: 'workflow',
      title: 't',
      status: taskStatus,
    });
  }
  h.db = fake.db;
  return fake;
}

const refresh = () => app.request(`/${REPO}/refresh-tree`, { method: 'POST' });
const status = (fake: ReturnType<typeof setup>) => fake.rows(schema.repositories)[0]!.status;

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
});

describe('refreshing a repository', () => {
  it('fast-forwards a clone rather than cloning it again', async () => {
    const fake = setup({ source: 'git_https', remoteUrl: 'https://example.com/r.git' });
    expect((await refresh()).status).toBe(200);
    expect(h.add.mock.calls[0]![0]).toBe(REPO_JOB_NAMES.REFRESH);
    expect(status(fake)).toBe('cloning');
  });

  it('fast-forwards a writable folder import from the folder, and rescans a read-only one', async () => {
    setup({ source: 'local_path', localPath: '/host-fs/r', writable: true });
    await refresh();
    setup({ source: 'local_path', localPath: '/host-fs/r', writable: false });
    await refresh();
    expect(h.add.mock.calls.map((c) => c[0])).toEqual([
      REPO_JOB_NAMES.REFRESH,
      REPO_JOB_NAMES.SCAN,
    ]);
  });

  it('refuses a repository with nothing to refresh from, touching nothing', async () => {
    const fake = setup({ source: 'blank' });
    const res = await refresh();
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/no remote/);
    expect(h.add).not.toHaveBeenCalled();
    expect(status(fake)).toBe('ready');
  });

  it('refuses while a task holds the checkout, and not for a task never started', async () => {
    const fake = setup({ source: 'git_https', remoteUrl: 'https://example.com/r.git' }, 'running');
    const res = await refresh();
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/1 task is using this repository/);
    expect(h.add).not.toHaveBeenCalled();
    expect(status(fake)).toBe('ready');

    setup({ source: 'git_https', remoteUrl: 'https://example.com/r.git' }, 'created');
    expect((await refresh()).status).toBe(200);
  });
});
