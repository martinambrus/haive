import { networkGitArgs, httpOrigin } from '../../../../test/support/git-http.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';

const exec = promisify(execFile);
const tmpDirs: string[] = [];
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function git(cwd: string, args: string[]): Promise<void> {
  args = networkGitArgs(args);
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

async function mkTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function setupWorktree(): Promise<{ parent: string; wt: string }> {
  const parent = await mkTmp('wt-origin-parent-');
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

async function addBareOrigin(parent: string): Promise<string> {
  const bare = await mkTmp('wt-origin-bare-');
  await git(bare, ['init', '--bare', '-b', 'main']);
  const url = httpOrigin(bare);
  await git(parent, ['remote', 'add', 'origin', url]);
  await git(parent, ['push', '-u', 'origin', 'main']);
  return url;
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
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('12-worktree-cleanup detect: the parent checkout origin', () => {
  it('rejects when git cannot read the origin, instead of hiding the push options', async () => {
    const { parent, wt } = await setupWorktree();
    await addBareOrigin(parent);
    // A bad fetch refspec makes `git remote get-url origin` exit 128 while rev-parse and status still work.
    await git(parent, ['config', '--add', 'remote.origin.fetch', ':::bad']);
    await expect(worktreeCleanupStep.detect!(detectCtx(parent, wt))).rejects.toThrow(
      /git remote get-url origin failed in /,
    );
  });

  it('reports no origin for a parent without one', async () => {
    const { parent, wt } = await setupWorktree();
    const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
    expect(detected).toMatchObject({ mode: 'worktree', hasOrigin: false, originUrl: null });
  });

  it('reports the origin of a parent that has one', async () => {
    const { parent, wt } = await setupWorktree();
    const url = await addBareOrigin(parent);
    const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
    expect(detected).toMatchObject({ hasOrigin: true, originUrl: url });
  });
});
