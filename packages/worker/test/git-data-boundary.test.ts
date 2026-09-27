import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// WORKER_REPO_STORAGE_ROOT is read from the environment once, at import time, so the
// fixture root has to exist and be exported before gitfile-mask.js is pulled in.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-git-boundary-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const { repoGitDataBoundary } = await import('../src/queues/cli-exec/gitfile-mask.js');
const { chownCmd } = await import('../src/terminal/terminal-container.js');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const SUBPATH = `${USER_ID}/${REPO_ID}`;
const WORKDIR = '/haive/workdir';

const rootMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
const worktreeMount = {
  source: 'haive_repos',
  target: WORKDIR,
  subpath: `${SUBPATH}/.haive/worktrees/feature`,
};

const repoDir = path.join(storageRoot, SUBPATH);

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

const fresh = async (): Promise<void> => {
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
};

describe('repoGitDataBoundary', () => {
  it('mounts a repository root’s .git directory read-only, under the repo mount', async () => {
    await fresh();
    await mkdir(path.join(repoDir, '.git'));
    const boundary = await repoGitDataBoundary(rootMount, { hasWorktree: false, hasRepo: true });
    expect(boundary.masks).toEqual([]);
    expect(boundary.mounts).toEqual([
      {
        source: 'haive_repos',
        target: `${WORKDIR}/.git`,
        subpath: `${SUBPATH}/.git`,
        readOnly: true,
      },
    ]);
  });

  it('keeps the empty-file mask for a worktree, and adds no directory mount', async () => {
    await fresh();
    await mkdir(path.join(repoDir, '.git'));
    const boundary = await repoGitDataBoundary(worktreeMount, {
      hasWorktree: true,
      hasRepo: true,
    });
    expect(boundary.mounts).toEqual([]);
    expect(boundary.masks).toEqual([{ containerPath: `${WORKDIR}/.git`, content: '' }]);
  });

  it('masks rather than mounts when .git is a file or a link', async () => {
    await fresh();
    await writeFile(path.join(repoDir, '.git'), 'gitdir: /var/lib/haive/repos/x/y/.git\n');
    const asFile = await repoGitDataBoundary(rootMount, { hasWorktree: false, hasRepo: true });
    expect(asFile.mounts).toEqual([]);
    expect(asFile.masks).toEqual([{ containerPath: `${WORKDIR}/.git`, content: '' }]);

    await fresh();
    await mkdir(path.join(repoDir, 'elsewhere'));
    await symlink(path.join(repoDir, 'elsewhere'), path.join(repoDir, '.git'));
    const asLink = await repoGitDataBoundary(rootMount, { hasWorktree: false, hasRepo: true });
    expect(asLink.mounts).toEqual([]);
    expect(asLink.masks).toEqual([{ containerPath: `${WORKDIR}/.git`, content: '' }]);
  });

  it('mounts and masks NOTHING when there is no .git yet', async () => {
    // Docker refuses a subpath that does not exist, and a tmpfs over a missing destination
    // leaves a root-owned stub on the host that would break 12-post-onboarding's `git init`.
    await fresh();
    expect(await repoGitDataBoundary(rootMount, { hasWorktree: false, hasRepo: true })).toEqual({
      mounts: [],
      masks: [],
    });
  });

  it('claims nothing for a repo-less task or a bound local-path repository', async () => {
    await fresh();
    await mkdir(path.join(repoDir, '.git'));
    const scratch = {
      source: 'haive_repos',
      target: WORKDIR,
      subpath: `${USER_ID}/_scratch/33333333-3333-3333-3333-333333333333`,
    };
    expect(await repoGitDataBoundary(scratch, { hasWorktree: false, hasRepo: false })).toEqual({
      mounts: [],
      masks: [],
    });
    // A read-only local-path repository is a bind with no subpath, already `:ro` whole.
    const bind = { source: '/home/someone/project', target: WORKDIR, readOnly: true };
    expect(await repoGitDataBoundary(bind, { hasWorktree: false, hasRepo: true })).toEqual({
      mounts: [],
      masks: [],
    });
    expect(await repoGitDataBoundary(null, { hasWorktree: false, hasRepo: true })).toEqual({
      mounts: [],
      masks: [],
    });
  });
});

describe('the task shell\u2019s workdir chown', () => {
  it('walks around every read-only mount nested under the workdir', () => {
    expect(chownCmd(WORKDIR, [])).toEqual(['chown', '-R', 'node:node', WORKDIR]);
    expect(chownCmd(WORKDIR, [`${WORKDIR}/.git`])).toEqual([
      'find',
      WORKDIR,
      '(',
      '-path',
      `${WORKDIR}/.git`,
      ')',
      '-prune',
      '-o',
      '-exec',
      'chown',
      'node:node',
      '{}',
      '+',
    ]);
    // Parenthesised, so a SECOND skipped path is pruned too rather than chowned anyway.
    const two = chownCmd(WORKDIR, [`${WORKDIR}/.git`, `${WORKDIR}/other`]);
    expect(two.slice(2, 9)).toEqual([
      '(',
      '-path',
      `${WORKDIR}/.git`,
      '-o',
      '-path',
      `${WORKDIR}/other`,
      ')',
    ]);
    expect(two[9]).toBe('-prune');
  });
});
