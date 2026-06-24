import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';
import type { StepContext, StepApplyArgs } from '../../step-definition.js';

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
async function gitCode(dir: string, args: string[]): Promise<number> {
  try {
    await exec('git', args, { cwd: dir, env: GIT_ENV });
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  }
}

/** A parent repo on `main` with a `feature/x` worktree that has one commit ahead. */
async function setupWorktree(): Promise<{ parent: string; wt: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'wt-parent-'));
  await git(parent, ['init', '-b', 'main']);
  await writeFile(path.join(parent, 'base.txt'), 'base\n', 'utf8');
  await git(parent, ['add', '-A']);
  await git(parent, ['commit', '-m', 'initial']);
  const wt = path.join(parent, '.haive', 'worktrees', 'feature-x');
  await mkdir(path.dirname(wt), { recursive: true });
  await git(parent, ['worktree', 'add', '-b', 'feature/x', wt, 'main']);
  await writeFile(path.join(wt, 'feature.txt'), 'feature\n', 'utf8');
  await git(wt, ['add', '-A']);
  await git(wt, ['commit', '-m', 'feature work']);
  return { parent, wt };
}

const stubCtx = (parent: string) =>
  ({
    repoPath: parent,
    userId: 'u1',
    // resolveUserGitEnv -> findFirst undefined -> the step uses its fallback identity.
    db: { query: { users: { findFirst: async () => undefined } } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }) as unknown as StepContext;

type Det = {
  mode: 'worktree' | 'inplace' | 'no-git' | 'unknown';
  worktreePath: string | null;
  branchName: string | null;
  baseBranch: string | null;
  parentBranch: string | null;
  repositoryId: string | null;
};
function det(wt: string, over: Partial<Det> = {}): Det {
  return {
    mode: 'worktree',
    worktreePath: wt,
    branchName: 'feature/x',
    baseBranch: 'main',
    parentBranch: 'main',
    repositoryId: 'r1',
    ...over,
  };
}
function applyArgs(detected: Det, formValues: Record<string, unknown>): StepApplyArgs<Det> {
  return { detected, formValues, iteration: 0, previousIterations: [] };
}

describe('12 worktree cleanup apply (real git)', () => {
  it('merge_remove merges into base, removes the worktree, and safe-deletes the branch', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await worktreeCleanupStep.apply(
        stubCtx(parent),
        applyArgs(det(wt), { action: 'merge_remove', deleteBranch: true }),
      );
      expect(out.merged).toBe(true);
      expect(out.removed).toBe(true);
      expect(out.branchDeleted).toBe(true);
      // The feature commit is now on main, and the branch is gone.
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).not.toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('remove_only removes the worktree but keeps the branch', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await worktreeCleanupStep.apply(
        stubCtx(parent),
        applyArgs(det(wt), { action: 'remove_only' }),
      );
      expect(out.removed).toBe(true);
      expect(out.merged).toBe(false);
      // Branch survives — committed work stays recoverable.
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keep leaves the worktree in place', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await worktreeCleanupStep.apply(
        stubCtx(parent),
        applyArgs(det(wt), { action: 'keep' }),
      );
      expect(out.removed).toBe(false);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('blocks the merge when the parent repo is not on the base branch', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await worktreeCleanupStep.apply(
        stubCtx(parent),
        applyArgs(det(wt, { parentBranch: 'develop' }), { action: 'merge_remove' }),
      );
      expect(out.removed).toBe(false);
      expect(out.merged).toBe(false);
      expect(out.message).toContain('merge skipped');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('falls back to the parent current branch when no base was recorded (older task)', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await worktreeCleanupStep.apply(
        stubCtx(parent),
        applyArgs(det(wt, { baseBranch: null }), { action: 'merge_remove' }),
      );
      expect(out.merged).toBe(true);
      expect(out.removed).toBe(true);
      // Merged into the parent's current branch (main); feature commit now on main.
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('aborts on a merge conflict and keeps the worktree', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      // Diverge the same file on both branches so the merge conflicts.
      await writeFile(path.join(wt, 'base.txt'), 'feature-edit\n', 'utf8');
      await git(wt, ['commit', '-am', 'edit base on feature']);
      await writeFile(path.join(parent, 'base.txt'), 'main-edit\n', 'utf8');
      await git(parent, ['commit', '-am', 'edit base on main']);

      const out = await worktreeCleanupStep.apply(
        stubCtx(parent),
        applyArgs(det(wt), { action: 'merge_remove' }),
      );
      expect(out.merged).toBe(false);
      expect(out.removed).toBe(false);
      expect(out.message).toContain('conflict');
      // The branch and worktree survive so the user can resolve manually.
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('12 worktree cleanup form', () => {
  it('defaults to merge_remove and offers branch-delete + the remove-only terminal note', () => {
    const schema = worktreeCleanupStep.form!(stubCtx(''), det('/ws/.haive/worktrees/feature-x'));
    const action = schema.fields.find((f) => f.id === 'action') as { default?: string };
    expect(action.default).toBe('merge_remove');
    const note = schema.fields.find((f) => f.id === 'removeOnlyNote') as { body?: string };
    expect(note.body).toContain('/repos/r1/terminal');
    expect(note.body).toContain('git branch -D feature/x');
    expect(schema.fields.some((f) => f.id === 'deleteBranch')).toBe(true);
  });

  it('warns up front when the parent repo is off the base branch', () => {
    const schema = worktreeCleanupStep.form!(
      stubCtx(''),
      det('/ws/wt', { parentBranch: 'develop' }),
    );
    expect(schema.fields.some((f) => f.id === 'branchMismatchNote')).toBe(true);
  });

  it('passes straight through (auto-submit, no fields) when there is no worktree', () => {
    const schema = worktreeCleanupStep.form!(
      stubCtx(''),
      det('', { mode: 'inplace', worktreePath: null }),
    );
    expect(schema.autoSubmit).toBe(true);
    expect(schema.fields).toHaveLength(0);
  });
});
