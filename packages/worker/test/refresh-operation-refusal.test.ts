import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { RepoJobPayload } from '@haive/shared';
import { failGit, type FakeGit } from './support/fake-git.js';

const h = vi.hoisted(() => ({ persist: vi.fn(), seed: vi.fn() }));
vi.mock('../src/repo/clone.js', async (original) => ({
  ...(await original<typeof import('../src/repo/clone.js')>()),
  withRootClaim: async (_db: unknown, _id: string, fn: () => Promise<void>) => fn(),
  persistDetection: h.persist,
}));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  seedPlanBaseFromCheckout: h.seed,
}));
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
  query: { tasks: { findMany: async () => [] } },
  transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  update: () => ({ set: (values: object) => ({ where: async () => Object.assign(row, values) }) }),
} as unknown as Database;
beforeEach(async () => {
  vi.clearAllMocks();
  row.status = 'ready';
  delete row.statusMessage;
  h.persist.mockImplementation(async (_db, _id, _dest, note) => {
    row.status = 'ready';
    row.statusMessage = note;
  });
  root = await mkdtemp(path.join(tmpdir(), 'refresh-operation-'));
});
afterEach(async () => {
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
