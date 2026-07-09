import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { gitWorkspaceStatus, requireUsableGit } from './git-workspace.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: GIT_ENV });
}

const dirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function seedRepo(): Promise<string> {
  const repo = await tmp('gw-repo-');
  await git(repo, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(repo, 'a.txt'), '1\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'c1']);
  return repo;
}

/** A linked worktree whose gitfile points where the host cannot follow — the state a
 *  sandbox agent leaves behind by repointing `.git` at the container path. */
async function seedPoisonedWorktree(): Promise<string> {
  const repo = await seedRepo();
  const wt = path.join(repo, '.haive', 'worktrees', 'feature-x');
  await git(repo, ['worktree', 'add', '-q', wt, '-b', 'feature/x']);
  await writeFile(path.join(wt, '.git'), 'gitdir: /haive/workdir/.git/worktrees/feature-x\n');
  return wt;
}

describe('gitWorkspaceStatus', () => {
  it('ok for a healthy repo', async () => {
    expect(await gitWorkspaceStatus(await seedRepo())).toBe('ok');
  });

  it('absent when there is no .git entry', async () => {
    expect(await gitWorkspaceStatus(await tmp('gw-plain-'))).toBe('absent');
  });

  it('broken when .git exists but git refuses it', async () => {
    expect(await gitWorkspaceStatus(await seedPoisonedWorktree())).toBe('broken');
  });

  // Probe order matters: git's upward discovery would report the PARENT repo here.
  it('absent for a nested dir with no .git, not the parent repo', async () => {
    const repo = await seedRepo();
    const nested = path.join(repo, 'sub', 'dir');
    await mkdir(nested, { recursive: true });
    expect(await gitWorkspaceStatus(nested)).toBe('absent');
  });
});

describe('requireUsableGit', () => {
  it('true for a healthy repo', async () => {
    expect(await requireUsableGit(await seedRepo())).toBe(true);
  });

  it('false when there is no repo at all', async () => {
    expect(await requireUsableGit(await tmp('gw-plain-'))).toBe(false);
  });

  // The whole point: corruption must never be collapsed into "no git", which reads
  // as an empty tree and silently skips the commit.
  it('throws on a poisoned gitfile instead of reporting no-git', async () => {
    await expect(requireUsableGit(await seedPoisonedWorktree())).rejects.toThrow(
      /git cannot use it/,
    );
  });
});
