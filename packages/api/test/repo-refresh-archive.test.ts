vi.mock('../../worker/src/repo/interactive-checkout.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  suspendCheckoutSessions: async () => () => {},
}));
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const USER = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-000000000002';
const h = vi.hoisted(() => ({
  db: undefined as any,
  source: '',
  beforeRename: vi.fn(async () => {}),
  building: vi.fn(async () => {}),
  beforeDetection: vi.fn(async () => {}),
  archive: vi.fn(async () => ({ stream: Readable.from(['zip']), filename: 'repo.zip' })),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: any, next: () => Promise<void>) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/lib/repo-archive.js', () => ({ createRepoArchiveStream: h.archive }));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    renameNoFollow: async (...args: Parameters<typeof real.renameNoFollow>) => {
      await h.beforeRename();
      return real.renameNoFollow(...args);
    },
  };
});
vi.mock('../../worker/src/repo/clone.js', () => ({
  withRootClaim: async (_db: unknown, _id: string, run: () => Promise<void>) => run(),
  assertCloneUrl: () => {},
  persistDetection: async () => {
    await h.beforeDetection();
    await h.db
      .update(schema.repositories)
      .set({ status: 'ready' })
      .where(eq(schema.repositories.id, REPO));
  },
  restoreProjectData: async () => {},
  copyTree: async (source: string, dest: string) => {
    await h.building();
    await cp(source, dest, { recursive: true });
  },
  gitClone: async (_url: string, dest: string) => {
    await h.building();
    await cp(h.source, dest, { recursive: true });
  },
}));
vi.mock('../../worker/src/plan/mirror.js', async (original) => ({
  ...(await original<any>()),
  seedPlanBaseFromCheckout: async () => {},
}));
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// Runtime cross-package seam: keep worker sources outside the API's tsc root.
const refreshSource = new URL('../../worker/src/repo/refresh.ts', import.meta.url).pathname;
const refresh = await import(refreshSource);
const ownerSource = new URL('../../worker/src/repo/job-owner.ts', import.meta.url).pathname;
const { withRepoJobOwner } = await import(ownerSource);
const handleRefresh = (...args: any[]) =>
  withRepoJobOwner(REPO, 'archive-fixture-job', () => refresh.handleRefresh(...args));
const app = new Hono<AppEnv>().onError(errorHandler).route('/repos', repoRoutes);
const archive = () => app.request(`/repos/${REPO}/archive`);
let root: string;
let storage: string;
let dest: string;
let fake: ReturnType<typeof createFakeDb>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'refresh-archive-'));
  h.source = join(root, 'source');
  await mkdir(h.source);
  const git = promisify(execFile);
  await git('git', ['init', '-b', 'main', h.source]);
  await git(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@local', 'commit', '--allow-empty', '-m', 'one'],
    {
      cwd: h.source,
    },
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.clearAllMocks();
  h.beforeRename.mockReset();
  h.building.mockReset();
  h.beforeDetection.mockReset();
  storage = await mkdtemp(join(root, 'storage-'));
  dest = join(storage, USER, REPO);
  await mkdir(dest, { recursive: true });
  fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    refreshPending: true,
    refreshJobId: 'archive-fixture-job',
    storagePath: dest,
  });
  h.db = fake.db;
});

it.each(['folder', 'remote'] as const)(
  'refuses archive before an escalated %s rebuild moves the checkout and during its build',
  async (source) => {
    await writeFile(join(dest, 'keep.txt'), 'old checkout');
    const refused = async () => {
      expect((await archive()).status).toBe(409);
      expect(h.archive).not.toHaveBeenCalled();
      expect(fake.rows(schema.repositories)[0]!.status).toBe('cloning');
    };
    h.beforeRename.mockImplementation(refused);
    h.building.mockImplementation(refused);
    await handleRefresh(
      {
        repositoryId: REPO,
        userId: USER,
        ...(source === 'folder'
          ? { source: 'local_path', localPath: h.source }
          : { source: 'git_https', remoteUrl: 'https://example.test/repo.git' }),
      },
      h.db,
      storage,
    );
    expect(h.beforeRename).toHaveBeenCalled();
    expect(h.building).toHaveBeenCalledOnce();
    expect((await archive()).status).toBe(200);
  },
);

it('keeps an ordinary usable refresh ready for archive access', async () => {
  await cp(h.source, dest, { recursive: true });
  h.beforeDetection.mockImplementation(async () => {
    expect(fake.rows(schema.repositories)[0]!.status).toBe('ready');
    expect((await archive()).status).toBe(200);
  });
  await handleRefresh(
    { repositoryId: REPO, userId: USER, source: 'local_path', localPath: h.source },
    h.db,
    storage,
  );
  expect(h.beforeRename).not.toHaveBeenCalled();
  expect(h.building).not.toHaveBeenCalled();
  expect(h.beforeDetection).toHaveBeenCalledOnce();
  expect((await archive()).status).toBe(200);
});
