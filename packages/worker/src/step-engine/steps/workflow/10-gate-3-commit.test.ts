import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { gate3CommitStep } from './10-gate-3-commit.js';
import type { StepContext } from '../../step-definition.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** ctx whose db returns no 01-worktree-setup row, so detect falls back to workspacePath. */
function mkCtx(workspacePath: string): StepContext {
  const noRows = {
    from: () => ({
      where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  };
  return {
    repoPath: workspacePath,
    workspacePath,
    sandboxWorkdir: workspacePath,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db: { select: () => noRows },
    logger,
  } as unknown as StepContext;
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
  const repo = await tmp('gate3-repo-');
  await git(repo, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(repo, 'a.txt'), '1\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'c1']);
  return repo;
}

describe('10-gate-3-commit detect', () => {
  it('reports no git when the workspace has no .git entry', async () => {
    const plain = await tmp('gate3-plain-');
    const detected = await gate3CommitStep.detect(mkCtx(plain));
    expect(detected.hasGit).toBe(false);
    expect(detected.dirtyFiles).toBe(0);
  });

  it('counts dirty files in a healthy repo', async () => {
    const repo = await seedRepo();
    await writeFile(path.join(repo, 'b.txt'), '2\n', 'utf8');
    const detected = await gate3CommitStep.detect(mkCtx(repo));
    expect(detected.hasGit).toBe(true);
    expect(detected.dirtyFiles).toBe(1);
  });

  // The task-82949225 failure: an agent inside the sandbox rewrote the worktree's
  // gitfile to the container-side path, which does not resolve on the host. Every
  // git call then fails, and the old code read that as a clean tree.
  it('throws when .git exists but git cannot use it (poisoned gitfile)', async () => {
    const repo = await seedRepo();
    const wt = path.join(repo, '.haive', 'worktrees', 'feature-x');
    await git(repo, ['worktree', 'add', '-q', wt, '-b', 'feature/x']);
    await writeFile(
      path.join(wt, '.git'),
      'gitdir: /haive/workdir/.git/worktrees/feature-x\n',
      'utf8',
    );

    await expect(gate3CommitStep.detect(mkCtx(wt))).rejects.toThrow(/git cannot use it/);
  });

  // Guards the probe order: with .git absent, git's upward discovery would find the
  // PARENT repo and happily report its status for this nested directory.
  it('reports no git for a nested dir with no .git, rather than the parent repo', async () => {
    const repo = await seedRepo();
    const nested = path.join(repo, '.haive', 'worktrees', 'gone');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(repo, 'dirty.txt'), 'x\n', 'utf8');

    const detected = await gate3CommitStep.detect(mkCtx(nested));
    expect(detected.hasGit).toBe(false);
    expect(detected.dirtyFiles).toBe(0);
  });
});
