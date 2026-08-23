import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
import { nextFreeBranchName, worktreeSetupStep } from './01-worktree-setup.js';
import type { StepApplyArgs, StepContext } from '../../step-definition.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const logger = { info: () => {}, warn: () => {}, error: () => {} };

async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: GIT_ENV });
}

/** A repo on `main` with one commit. */
async function setupRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'wt-setup-'));
  await git(root, ['init', '-b', 'main']);
  await writeFile(path.join(root, 'f.txt'), 'one\n', 'utf8');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'one']);
  return root;
}

/** detect and apply each read `tasks` first (the task row / its repositoryId); apply's
 *  SECOND read is findBranchClaimant, which is what `claimant` answers. `select` backs
 *  loadPreviousStepOutput('00a-sync-base') with "no such row". */
function mkCtx(
  root: string,
  opts: { title?: string; claimant?: { id: string; title: string; status: string } } = {},
): StepContext {
  let taskCalls = 0;
  return {
    taskId: 'task1',
    userId: 'u1',
    repoPath: root,
    sandboxWorkdir: '/haive/workdir',
    logger,
    db: {
      query: {
        tasks: {
          findFirst: async () => {
            taskCalls += 1;
            return taskCalls === 1
              ? {
                  title: opts.title ?? 'Add DDEV',
                  description: null,
                  metadata: null,
                  repositoryId: 'r1',
                }
              : opts.claimant;
          },
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
        }),
      }),
    } as unknown as Database,
  } as unknown as StepContext;
}

describe('nextFreeBranchName', () => {
  it('returns the base when nothing is taken', () => {
    expect(nextFreeBranchName('feature/x', () => false)).toBe('feature/x');
  });

  it('suffixes past every taken name', () => {
    const taken = new Set(['feature/x', 'feature/x-2']);
    expect(nextFreeBranchName('feature/x', (n) => taken.has(n))).toBe('feature/x-3');
  });
});

describe('01 worktree setup detect', () => {
  it('proposes the plain title-derived name when the branch is free', async () => {
    const root = await setupRepo();
    try {
      const d = await worktreeSetupStep.detect(mkCtx(root));
      expect(d.proposedBranch).toBe('feature/add-ddev');
      expect(d.proposalBumpedFrom).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bumps past an existing branch and explains the rename on the form', async () => {
    const root = await setupRepo();
    try {
      await git(root, ['branch', 'feature/add-ddev']);
      const d = await worktreeSetupStep.detect(mkCtx(root));
      expect(d.proposedBranch).toBe('feature/add-ddev-2');
      expect(d.proposalBumpedFrom).toBe('feature/add-ddev');
      const schema = worktreeSetupStep.form!(mkCtx(root), d);
      const note = schema.fields.find((f) => f.id === 'branchTakenNote') as { body?: string };
      expect(note?.body).toContain('feature/add-ddev-2');
      const field = schema.fields.find((f) => f.id === 'branchName') as { default?: string };
      expect(field.default).toBe('feature/add-ddev-2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // worktreeDirName flattens slashes, so `feature/add-ddev` and `feature-add-ddev` are
  // distinct refs that would both land in .haive/worktrees/feature-add-ddev.
  it('treats a slash-flattened directory collision as taken', async () => {
    const root = await setupRepo();
    try {
      await git(root, ['branch', 'feature-add-ddev']);
      const d = await worktreeSetupStep.detect(mkCtx(root));
      expect(d.proposedBranch).toBe('feature/add-ddev-2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves the proposal alone on a repo with no git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wt-nogit-'));
    try {
      const d = await worktreeSetupStep.detect(mkCtx(root));
      expect(d.hasGit).toBe(false);
      expect(d.proposedBranch).toBe('feature/add-ddev');
      expect(d.proposalBumpedFrom).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('01 worktree setup apply', () => {
  // A second task on the same branch does NOT get its own tree: worktreeDirName maps a
  // branch to one directory, so the `isRegistered` path below would silently hand it the
  // first task's worktree.
  it('refuses a branch another live task already holds', async () => {
    const root = await setupRepo();
    try {
      const ctx = mkCtx(root, {
        claimant: { id: 'task2', title: 'Other task', status: 'waiting_user' },
      });
      const args = {
        detected: {
          hasGit: true,
          currentBranch: 'main',
          isClean: true,
          proposedBranch: 'feature/add-ddev',
          proposalBumpedFrom: null,
          syncedBase: 'main',
        },
        formValues: { branchName: 'feature/add-ddev' },
        iteration: 0,
        previousIterations: [],
      } as unknown as StepApplyArgs<never>;
      await expect(worktreeSetupStep.apply(ctx, args)).rejects.toThrow(
        /already held by task "Other task" \(task2, waiting_user\)/,
      );
      // Refused BEFORE any git mutation: no branch, no worktree directory.
      await expect(
        git(root, ['rev-parse', '--verify', 'refs/heads/feature/add-ddev']),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
