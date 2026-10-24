import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';
import { failGit, type FakeGit } from '../../../../test/support/fake-git.js';
import { killGit } from '../../../../test/support/kill-git.js';

const exec = promisify(execFile);
const tmpDirs: string[] = [];
let shim: FakeGit | null = null;
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ARGV = ['rev-parse', '--abbrev-ref', 'HEAD'];

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', ['-c', 'gc.auto=0', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@haive.local',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@haive.local',
    },
  });
}

async function setupWorktree(): Promise<{ parent: string; wt: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'wt-parent-branch-'));
  tmpDirs.push(parent);
  await git(parent, ['init', '-b', 'main']);
  await git(parent, ['config', 'gc.auto', '0']);
  await writeFile(path.join(parent, 'base.txt'), 'base\n', 'utf8');
  await git(parent, ['add', '-A']);
  await git(parent, ['commit', '-m', 'initial']);
  const wt = path.join(parent, '.haive', 'worktrees', 'feature-x');
  await mkdir(path.dirname(wt), { recursive: true });
  await git(parent, ['worktree', 'add', '-b', 'feature/x', wt, 'main']);
  return { parent, wt };
}

function detectCtx(parent: string, wt: string): StepContext {
  const setup = {
    detectOutput: null,
    output: { mode: 'worktree', worktreePath: wt, branchName: 'feature/x', baseBranch: 'main' },
    iterations: [],
  };
  return {
    repoPath: parent,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db: {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [setup] }) }) }),
      }),
      query: {
        tasks: { findFirst: async () => ({ repositoryId: null, title: 'Task', description: '' }) },
        repoCredentials: { findMany: async () => [] },
      },
    },
    logger,
  } as unknown as StepContext;
}

beforeEach(() => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await shim?.restore();
  shim = null;
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('12-worktree-cleanup detect: the parent checkout branch', () => {
  it('rejects when the branch read ends with no exit status', async () => {
    const { parent, wt } = await setupWorktree();
    shim = await killGit(ARGV);
    await expect(worktreeCleanupStep.detect!(detectCtx(parent, wt))).rejects.toThrow(
      /could not read the parent checkout's branch/,
    );
  });

  it('rejects when the branch read exits 128', async () => {
    const { parent, wt } = await setupWorktree();
    shim = await failGit(ARGV, { exit: 128 });
    await expect(worktreeCleanupStep.detect!(detectCtx(parent, wt))).rejects.toThrow(
      /could not read the parent checkout's branch/,
    );
  });

  it('reports the parent branch of a healthy checkout', async () => {
    const { parent, wt } = await setupWorktree();
    const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
    expect(detected).toMatchObject({ parentBranch: 'main' });
  });

  it('reports HEAD for a parent on a detached HEAD', async () => {
    const { parent, wt } = await setupWorktree();
    await git(parent, ['checkout', '--detach']);
    const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
    expect(detected).toMatchObject({ parentBranch: 'HEAD' });
  });
});
