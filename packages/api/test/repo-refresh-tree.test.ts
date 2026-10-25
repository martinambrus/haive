import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  getJobs: vi.fn(async () => [] as { data: { repositoryId: string } }[]),
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
  getRepoQueue: () => ({ add: h.add, getJobs: h.getJobs }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, REPO_JOB_NAMES } from '@haive/shared';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

function setup(repo: Record<string, unknown>, taskStatus?: string, task = {}) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    repoUploads: schema.repoUploads,
  });
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
      ...task,
    });
  }
  h.db = fake.db;
  return fake;
}

const refresh = () => app.request(`/${REPO}/refresh-tree`, { method: 'POST' });
const status = (fake: ReturnType<typeof setup>) => fake.rows(schema.repositories)[0]!.status;

beforeEach(() => {
  h.getJobs.mockReset().mockResolvedValue([]);
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
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

  it('does not count a dead task as holding the checkout', async () => {
    setup({ source: 'git_https', remoteUrl: 'https://example.com/r.git' }, 'running', {
      deadAt: new Date(),
    });
    expect((await refresh()).status).toBe(200);
    expect(h.add.mock.calls[0]![0]).toBe(REPO_JOB_NAMES.REFRESH);
  });
});

it('does not copy legacy URL userinfo into a refresh job and preserves transport identity', async () => {
  setup({
    source: 'git_https',
    remoteUrl: 'https://fixture-user:fixture-password@example.test:443/repo',
  });
  expect((await refresh()).status).toBe(200);
  const payload = h.add.mock.calls[0]![1] as { remoteUrl: string };
  expect(payload.remoteUrl === 'https://example.test:443/repo').toBe(true);
  expect(JSON.stringify(payload).includes('fixture-password')).toBe(false);
});

const ARCHIVE = `/var/lib/haive/repos/_uploads/${USER}/${REPO}.tar.gz`;
function upload(overrides: Record<string, unknown> = {}, taskStatus?: string) {
  const fake = setup({ source: 'upload', status: 'error' }, taskStatus);
  fake.insert(schema.repoUploads, {
    id: REPO,
    userId: USER,
    status: 'complete',
    archivePath: ARCHIVE,
    archiveFormat: 'tar.gz',
    filename: 'project.tar.gz',
    totalSize: 10,
    bytesReceived: 10,
    chunkSize: 10,
    ...overrides,
  });
  return fake;
}

describe('retrying an upload', () => {
  it.each([
    [
      'https://fixture-user:fixture-password@example.test:443/repo',
      'https://example.test:443/repo',
    ],
    ['ssh://git:fixture-password@example.test:22/repo', 'ssh://git@example.test:22/repo'],
    ['git@gitserver:repo', 'git@gitserver:repo'],
  ])('keeps a linked upload refresh scoped and sanitized: %s', async (remoteUrl, expected) => {
    const credentialsId = '00000000-0000-4000-8000-0000000000c1';
    const fake = setup({
      source: 'upload',
      status: 'error',
      remoteUrl,
      branch: 'topic/retry',
      credentialsSecretId: credentialsId,
    });
    expect((await refresh()).status).toBe(200);
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add).toHaveBeenCalledWith(
      REPO_JOB_NAMES.REFRESH,
      {
        repositoryId: REPO,
        userId: USER,
        source: 'upload',
        remoteUrl: expected,
        branch: 'topic/retry',
        credentialsId,
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
    expect(h.getJobs).not.toHaveBeenCalled();
    expect(JSON.stringify(h.add.mock.calls)).not.toContain('fixture-password');
    expect(status(fake)).toBe('cloning');
  });

  it('queues EXTRACT using only its own completed upload record, once', async () => {
    const fake = upload();
    expect((await refresh()).status).toBe(200);
    expect(h.add).toHaveBeenCalledWith(
      REPO_JOB_NAMES.EXTRACT,
      expect.objectContaining({
        repositoryId: REPO,
        userId: USER,
        source: 'upload',
        archivePath: ARCHIVE,
        archiveFormat: 'tar.gz',
      }),
      expect.objectContaining({ attempts: 1 }),
    );
    expect(status(fake)).toBe('cloning');
    expect((await refresh()).status).toBe(409);
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it.each(['absent', 'cancelled', 'other owner'])(
    'refuses an unavailable archive record: %s',
    async (kind) => {
      const fake =
        kind === 'absent'
          ? setup({ source: 'upload', status: 'error' })
          : upload(
              kind === 'other owner'
                ? { userId: '00000000-0000-4000-8000-0000000000a2' }
                : { status: kind },
            );
      const res = await refresh();
      expect(res.status).toBe(409);
      expect(await res.text()).toMatch(/delete.*repository.*upload.*again/i);
      expect(h.add).not.toHaveBeenCalled();
      expect(status(fake)).toBe('error');
    },
  );

  it('refuses a live queued job even if its repository was marked error', async () => {
    upload();
    h.getJobs.mockResolvedValue([{ data: { repositoryId: REPO } }]);
    const res = await refresh();
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already.*(queued|running)/i);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('admits only one of concurrent retry requests', async () => {
    upload();
    const results = await Promise.all([refresh(), refresh()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('refuses holding tasks, a claimed root and maintenance', async () => {
    upload({}, 'running');
    expect((await refresh()).status).toBe(409);
    const fake = upload();
    fake.patch(schema.repositories, REPO, { rootClaimedAt: new Date(), rootClaimKind: 'reset' });
    expect((await refresh()).status).toBe(409);
    upload();
    vi.spyOn(configService, 'getFresh').mockResolvedValue('draining');
    expect((await refresh()).status).toBe(503);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('marks an enqueue failure error so it can be retried', async () => {
    const fake = upload();
    h.add.mockRejectedValue(new Error('Redis unavailable'));
    expect((await refresh()).status).toBe(500);
    expect(status(fake)).toBe('error');
  });

  it('keeps refreshing an upload linked to a remote, without re-extracting it', async () => {
    setup({ source: 'upload', status: 'error', remoteUrl: 'https://example.com/r.git' });
    expect((await refresh()).status).toBe(200);
    expect(h.add.mock.calls[0]![0]).toBe(REPO_JOB_NAMES.REFRESH);
  });
});
