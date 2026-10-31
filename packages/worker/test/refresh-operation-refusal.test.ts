import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REPO_JOB_NAMES } from '@haive/shared';
import type { Job, Processor } from 'bullmq';
import { schema } from '@haive/database';
import { restoreFaults } from '../src/project-state/set-aside.js';
import * as projections from '../src/project-state/set-aside.js';
import type { Database } from '@haive/database';
import type { RepoJobPayload } from '@haive/shared';
import { failGit, type FakeGit } from './support/fake-git.js';

const h = vi.hoisted(() => ({
  persist: vi.fn(),
  seed: vi.fn(),
  holding: 0,
  processor: null as Processor | null,
}));
vi.mock('../src/repo/clone.js', async (original) => ({
  ...(await original<typeof import('../src/repo/clone.js')>()),
  withRootClaim: async (_db: unknown, _id: string, fn: () => Promise<void>) => fn(),
  persistDetection: h.persist,
}));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  seedPlanBaseFromCheckout: h.seed,
}));
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_name: string, processor: Processor) {
      h.processor = processor;
    }
    on() {}
  },
}));
vi.mock('../src/db.js', () => ({ getDb: () => db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
import { startRepoWorker } from '../src/queues/repo-queue.js';
import { handleRefresh } from '../src/repo/refresh.js';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (
    await exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@local',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@local',
      },
    })
  ).stdout.trim();
let root: string;
let shim: FakeGit | null = null;
const row: { status: string; statusMessage?: string } = { status: 'ready' };
const db = {
  execute: async () => {},
  query: {
    tasks: { findMany: async () => Array.from({ length: h.holding }, () => ({ id: 'holder' })) },
  },
  transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({ limit: async () => (table === schema.planNodes ? [{ id: 'node' }] : []) }),
    }),
  }),
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
  update: () => ({ set: (values: object) => ({ where: async () => Object.assign(row, values) }) }),
} as unknown as Database;
beforeEach(async () => {
  vi.clearAllMocks();
  row.status = 'cloning';
  h.holding = 0;
  h.seed.mockResolvedValue(undefined);
  delete row.statusMessage;
  h.persist.mockImplementation(async (_db, _id, _dest, note) => {
    row.status = 'ready';
    row.statusMessage = note;
  });
  root = await mkdtemp(path.join(tmpdir(), 'refresh-operation-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete restoreFaults.afterRestore;
  delete restoreFaults.beforePutBack;
  await shim?.restore();
  shim = null;
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const source = path.join(root, 'source');
  const dest = path.join(root, 'u1', 'r1');
  await mkdir(source);
  await mkdir(path.dirname(dest));
  await git(source, ['init', '-b', 'main']);
  await git(source, ['commit', '--allow-empty', '-m', 'one']);
  await git(root, ['clone', source, dest]);
  await git(source, ['commit', '--allow-empty', '-m', 'two']);
  await mkdir(path.join(dest, '.haive-data'));
  await writeFile(path.join(dest, '.haive-data/plan.md'), 'pending\n');
  return {
    dest,
    payload: {
      source: 'local_path',
      localPath: source,
      userId: 'u1',
      repositoryId: 'r1',
    } as RepoJobPayload,
  };
}
it.each(['failed git-path', 'external git-dir'])(
  'T397 fix1 refresh refuses an unreadable operation: %s',
  async (kind) => {
    const { dest, payload } = await fixture();
    const before = await git(dest, ['rev-parse', 'HEAD']);
    if (kind === 'failed git-path') shim = await failGit(['rev-parse', '--git-path']);
    else {
      const gitDir = path.join(root, 'outside.git');
      await rename(path.join(dest, '.git'), gitDir);
      await writeFile(path.join(dest, '.git'), `gitdir: ${gitDir}\n`);
    }
    await handleRefresh(payload, db, root);
    expect(row.status).toBe('ready');
    expect(row.statusMessage).toMatch(
      /^Not refreshed: .*could not be checked for an open merge or rebase .*The checkout was not moved\.$/,
    );
    await shim?.restore();
    shim = null;
    expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await readFile(path.join(dest, '.haive-data/plan.md'), 'utf8')).toBe('pending\n');
  },
);

it('T397 D1 an unknown checkout fails through the queue without detection, import or rebuild', async () => {
  const { dest, payload } = await fixture();
  const before = await git(dest, ['rev-parse', 'HEAD']);
  shim = await failGit(['rev-parse', '--show-cdup']);
  await expect(runRefresh(payload)).rejects.toThrow(
    /^Not refreshed: the checkout could not be examined \(.*\)\. Nothing was moved\.$/,
  );
  expect(h.persist).not.toHaveBeenCalled();
  expect(h.seed).not.toHaveBeenCalled();
  expect(row.status).toBe('error');
  expect(row.statusMessage).toMatch(/^Not refreshed: the checkout could not be examined \(/);
  await shim.restore();
  shim = null;
  expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(before);
  expect(await readFile(path.join(dest, '.haive-data/plan.md'), 'utf8')).toBe('pending\n');
});

async function runRefresh(payload: RepoJobPayload) {
  startRepoWorker(root);
  return h.processor!({ name: REPO_JOB_NAMES.REFRESH, data: payload } as Job);
}

it.each(['usable', 'unusable', 'unknown', 'holding', 'refused'] as const)(
  'T397 D1 refresh %s reaches a terminal repository status',
  async (kind) => {
    const { dest, payload } = await fixture();
    if (kind === 'usable') await git(payload.localPath!, ['reset', '--hard', 'HEAD^']);
    if (kind === 'unusable') await rm(path.join(dest, '.git'), { recursive: true });
    if (kind === 'unknown') shim = await failGit(['rev-parse', '--show-cdup']);
    if (kind === 'holding') h.holding = 1;
    if (kind === 'refused') await git(dest, ['checkout', '--detach']);
    await runRefresh(payload).catch(() => undefined);
    expect(row.status).toBe(kind === 'unknown' ? 'error' : 'ready');
    expect(['ready', 'error']).toContain(row.status);
  },
);
it.each([false, true])(
  'T397 D2 later unreadable gate puts pending bytes and index back (put-back fails: %s)',
  async (failedPutBack) => {
    const { dest, payload } = await fixture();
    const file = '.haive-data/plan.md';
    await git(dest, ['add', '--', file]);
    const staged = await git(dest, ['ls-files', '-s', '--', file]);
    const before = await git(dest, ['rev-parse', 'HEAD']);
    let restored = 0;
    restoreFaults.afterRestore = async () => {
      restored++;
      expect(await readFile(path.join(dest, file), 'utf8').catch(() => null)).toBeNull();
      expect(await git(dest, ['ls-files', '-s', '--', file])).toBe('');
      // A sweep leaves another pending file after capture. The next pre-move gate must put back the captured one.
      await writeFile(path.join(dest, '.haive-data/plan.json'), '{}\n');
      shim = await failGit(['rev-parse', '--git-path']);
    };
    const putError = new Error('put-back fault');
    if (failedPutBack)
      restoreFaults.beforePutBack = () => {
        throw putError;
      };
    if (failedPutBack) {
      const err = await handleRefresh(payload, db, root).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toContain(putError);
      expect((err as AggregateError).errors[0]).toHaveProperty(
        'name',
        'GitOperationUnreadableError',
      );
    } else {
      await handleRefresh(payload, db, root);
      expect(row.statusMessage).toMatch(/could not be checked.*The checkout was not moved/);
      expect(await readFile(path.join(dest, file), 'utf8')).toBe('pending\n');
      expect(await git(dest, ['ls-files', '-s', '--', file])).toBe(staged);
    }
    expect(restored).toBe(1);
    expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(before);
  },
);

it('refresh keeps a checkout with no HEAD aside and clones a usable replacement', async () => {
  const { dest, payload } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  await runRefresh(payload);
  const aside = (await readdir(path.dirname(dest))).find((entry) => entry.startsWith('r1.aside-'));
  expect(aside).toBeTruthy();
  expect(await readFile(path.join(path.dirname(dest), aside!, '.haive-data/plan.md'), 'utf8')).toBe(
    'pending\n',
  );
  await expect(readFile(path.join(path.dirname(dest), aside!, '.git/HEAD'))).rejects.toHaveProperty(
    'code',
    'ENOENT',
  );
  expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(
    await git(payload.localPath!, ['rev-parse', 'HEAD']),
  );
  expect(row.status).toBe('ready');
  expect(row.statusMessage).toContain(aside);
});

it('an unreadable first gate after a retry puts pending bytes and index back', async () => {
  const { dest, payload } = await fixture();
  const file = '.haive-data/plan.md';
  await git(dest, ['add', '--', file]);
  const staged = await git(dest, ['ls-files', '-s', '--', file]);
  const before = await git(dest, ['rev-parse', 'HEAD']);
  const aside = vi.spyOn(projections, 'setAsideHaiveProjections');
  const restore = vi
    .spyOn(projections, 'restoreProjectionsInTx')
    .mockImplementationOnce(async () => {
      await expect(readFile(path.join(dest, file))).rejects.toHaveProperty('code', 'ENOENT');
      expect(await git(dest, ['ls-files', '-s', '--', file])).toBe('');
      await writeFile(path.join(dest, '.haive-data/plan.json'), '{}\n');
      shim = await failGit(['rev-parse', '--git-path']);
      return { outcome: 'retry' };
    });
  await handleRefresh(payload, db, root);
  expect(restore).toHaveBeenCalledOnce();
  expect(aside).toHaveBeenCalledTimes(2);
  await expect(aside.mock.results[1]!.value).rejects.toHaveProperty(
    'name',
    'GitOperationUnreadableError',
  );
  expect(row.statusMessage).toMatch(/could not be checked.*The checkout was not moved/);
  expect(await readFile(path.join(dest, file), 'utf8')).toBe('pending\n');
  expect(await git(dest, ['ls-files', '-s', '--', file])).toBe(staged);
  expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(before);
});
