import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { failGit, type FakeGit } from './support/fake-git.js';
import type { Database } from '@haive/database';
import type { RepoJobPayload } from '@haive/shared';

const h = vi.hoisted(() => ({ putBack: vi.fn(), resync: vi.fn(), handBack: vi.fn() }));
vi.mock('../src/project-state/set-aside.js', async (original) => ({
  ...(await original<typeof import('../src/project-state/set-aside.js')>()),
  setAsideHaiveProjections: async () => ({ outcome: 'set-aside', kept: new Map() }),
  restoreProjectionsInTx: async () => ({ outcome: 'clean' }),
  putBackProjections: h.putBack,
  resyncHaiveProjections: h.resync,
  restoreKeptMetadata: async () => {},
}));
vi.mock('../src/step-engine/git-merge.js', async (original) => ({
  ...(await original<typeof import('../src/step-engine/git-merge.js')>()),
  handBackAfterMove: h.handBack,
}));
import { fastForward } from '../src/repo/refresh.js';

const exec = promisify(execFile);
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@local',
};
const git = async (cwd: string, args: string[]) =>
  (await exec('git', ['-c', 'gc.auto=0', ...args], { cwd, env: identity })).stdout.trim();
let root: string;
let shim: FakeGit | null = null;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), 'refresh-reads-'));
});
afterEach(async () => {
  await shim?.restore();
  shim = null;
  await rm(root, { recursive: true, force: true });
});
const db = {
  execute: async () => {},
  query: { tasks: { findMany: async () => [] } },
  transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
} as unknown as Database;
async function fixture() {
  await git(root, ['init', '-b', 'main']);
  await git(root, ['commit', '--allow-empty', '-m', 'one']);
  const dest = path.join(root, 'checkout');
  await git(root, ['clone', '.', dest]);
  await git(root, ['commit', '--allow-empty', '-m', 'two']);
  return {
    dest,
    payload: {
      repositoryId: 'r1',
      userId: 'u1',
      source: 'local_path',
      localPath: root,
    } as RepoJobPayload,
  };
}
it('T397 symbolic-ref exit 128 reports an unreadable branch, not detached HEAD', async () => {
  const { dest, payload } = await fixture();
  shim = await failGit(['symbolic-ref']);
  expect(await fastForward(db, payload, dest)).toMatch(/could not read.*branch/);
});
it('T397 a failed FETCH_HEAD read reports a read failure, not an empty fetch', async () => {
  const { dest, payload } = await fixture();
  shim = await failGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  expect(await fastForward(db, payload, dest)).toMatch(/could not read.*fetch/i);
});
it('T397 merge-base exit 128 reports a comparison failure, not unrelated history', async () => {
  const { dest, payload } = await fixture();
  shim = await failGit(['merge-base']);
  expect(await fastForward(db, payload, dest)).toMatch(/could not.*merge base/);
});
it('T397 a failed shallow read reports a read failure', async () => {
  const { dest, payload } = await fixture();
  await git(dest, ['checkout', '--orphan', 'other']);
  await git(dest, ['commit', '--allow-empty', '-m', 'unrelated']);
  // Fetch the source main as other, giving this branch a source with unrelated history.
  await git(root, ['branch', 'other', 'main']);
  shim = await failGit(['rev-parse', '--is-shallow-repository']);
  expect(await fastForward(db, payload, dest)).toMatch(/could not.*shallow/);
});
it('T397 a non-zero merge that moved HEAD re-syncs projections and reports failure', async () => {
  const { dest, payload } = await fixture();
  const before = await git(dest, ['rev-parse', 'HEAD']);
  shim = await failGit(['merge', '--ff-only'], { afterRun: true });
  const result = await fastForward(db, payload, dest);
  await shim.restore();
  shim = null;
  expect(await git(dest, ['rev-parse', 'HEAD'])).not.toBe(before);
  expect(h.resync).toHaveBeenCalledOnce();
  expect(h.handBack).toHaveBeenCalledWith(dest, before);
  expect(h.putBack).not.toHaveBeenCalled();
  expect(result).toMatch(/fast-forward.*failed/i);
});
it('T397 a failed post-merge HEAD read fails and never restores old projection bytes', async () => {
  const { dest, payload } = await fixture();
  shim = await failGit(['rev-parse', 'HEAD'], { from: 2 });
  await expect(fastForward(db, payload, dest)).rejects.toThrow(/HEAD/);
  expect(h.putBack).not.toHaveBeenCalled();
});
it('T397 a refused fast-forward at the same HEAD restores projections', async () => {
  const { dest, payload } = await fixture();
  shim = await failGit(['merge', '--ff-only']);
  expect(await fastForward(db, payload, dest)).toMatch(
    /^Not refreshed: git refused the fast-forward \(/,
  );
  expect(h.putBack).toHaveBeenCalledOnce();
  expect(h.resync).not.toHaveBeenCalled();
});
