import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  makePointerFixture,
  pointerDb,
  POINTER_BRANCH,
  type PointerFixture,
} from '../../test/support/worktree-pointer-db.js';
import { DDEV_GENERATED_BOUNDARY_PROMPT } from './ddev-generated-boundary.js';
import {
  invocationUsesWorktreeGitBoundary,
  resolveInvocationUsesWorktreeGitBoundary,
  resolveInvocationWorkerTree,
  resolveInvocationWorktreeBranch,
  withWorktreeGitBoundary,
  WORKTREE_GIT_BOUNDARY_MARKER,
  WORKTREE_GIT_BOUNDARY_PROMPT,
} from './worktree-git-boundary.js';

vi.hoisted(() => {
  process.env.REPO_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/wt-pointer-boundary-${process.pid}-${Math.random().toString(36).slice(2)}`;
});

describe('withWorktreeGitBoundary', () => {
  it('explains the zero-byte sentinel and the host-side git contract', () => {
    const prompt = withWorktreeGitBoundary('Implement the issue.', true);
    expect(prompt).toContain('zero-byte, read-only file');
    expect(prompt).toContain('containment boundary');
    expect(prompt).toContain('not repository corruption or a workspace permission problem');
    expect(prompt).toContain('chmod, chown, repair, or work around `.git`');
    expect(prompt).toContain('stage, commit, and merge your changes host-side');
    expect(prompt).toMatch(/<haive_worktree_git_boundary>[\s\S]*Implement the issue\.$/);
  });

  it('is idempotent and leaves repo-root prompts unchanged', () => {
    const once = withWorktreeGitBoundary('Review this.', true);
    const twice = withWorktreeGitBoundary(once, true);
    expect(twice).toBe(once);
    expect(twice.split(WORKTREE_GIT_BOUNDARY_MARKER)).toHaveLength(2);
    expect(withWorktreeGitBoundary('Review this.', false)).toBe('Review this.');
  });

  it('adds no second copy to a prompt whose block sits behind one applied after it', () => {
    const stored = `${DDEV_GENERATED_BOUNDARY_PROMPT}\n\n${withWorktreeGitBoundary('Review this.', true)}`;
    expect(withWorktreeGitBoundary(stored, true)).toBe(stored);
  });

  it('still adds the block when its marker is quoted in the body', () => {
    const body = [
      'Review this change:',
      '```diff',
      `+export const WORKTREE_GIT_BOUNDARY_MARKER = '${WORKTREE_GIT_BOUNDARY_MARKER}';`,
      '```',
    ].join('\n');
    expect(withWorktreeGitBoundary(body, true)).toBe(`${WORKTREE_GIT_BOUNDARY_PROMPT}\n\n${body}`);
  });

  it('still adds the block when a whole earlier block is quoted in the body', () => {
    const body = `The last run was sent:\n\n${WORKTREE_GIT_BOUNDARY_PROMPT}\n\nand failed.`;
    expect(withWorktreeGitBoundary(body, true)).toBe(`${WORKTREE_GIT_BOUNDARY_PROMPT}\n\n${body}`);
  });
});

describe('invocationUsesWorktreeGitBoundary', () => {
  it('matches volume feature and DAG worktrees', () => {
    expect(invocationUsesWorktreeGitBoundary({ worktreeBranch: 'feature/x' })).toBe(true);
    expect(
      invocationUsesWorktreeGitBoundary({
        worktreeBranch: 'feature/x',
        worktreeRel: '.haive/worktrees/feature-x--ISSUE-001',
      }),
    ).toBe(true);
  });

  it('does not claim a mask for repo-root or host-path invocations', () => {
    expect(
      invocationUsesWorktreeGitBoundary({ worktreeBranch: 'feature/x', worktreeRel: '' }),
    ).toBe(false);
    expect(invocationUsesWorktreeGitBoundary({ worktreeBranch: null })).toBe(false);
    expect(
      invocationUsesWorktreeGitBoundary({
        storagePath: '/host-fs/project',
        worktreeBranch: 'feature/x',
      }),
    ).toBe(false);
  });
});

describe('resolveInvocationUsesWorktreeGitBoundary', () => {
  let liveFx: PointerFixture | undefined;
  afterEach(async () => {
    await liveFx?.cleanup();
  });

  function dbFor(
    task: {
      userId?: string;
      repositoryId: string | null;
      worktreeBranch: string | null;
    } | null,
    repo: { storagePath: string | null; localPath: string | null } | null,
  ): Database {
    return {
      query: {
        tasks: { findFirst: async () => task ?? undefined },
        repositories: { findFirst: async () => repo ?? undefined },
        taskSteps: { findFirst: async () => undefined },
      },
    } as unknown as Database;
  }

  it('resolves the same target override that will be queued', async () => {
    liveFx = await makePointerFixture();
    await liveFx.mkWorktree();
    const db = dbFor(
      { userId: 'u1', repositoryId: 'r1', worktreeBranch: 'feature/x' },
      { storagePath: null, localPath: null },
    );
    await expect(resolveInvocationUsesWorktreeGitBoundary(db, 'task-1')).resolves.toBe(true);
    await expect(resolveInvocationUsesWorktreeGitBoundary(db, 'task-1', '')).resolves.toBe(false);
    await expect(
      resolveInvocationUsesWorktreeGitBoundary(
        db,
        'task-1',
        '.haive/worktrees/feature-x--ISSUE-002',
      ),
    ).resolves.toBe(true);
  });
});

// The two async wrappers feed the prompt boundary and the dispatch-side readers (persona, project
// instructions); both must describe the tree the mount will bind, so a worktree the task no longer
// works in must not be claimed.
describe('worktree boundary wrappers against a recorded worktree pointer', () => {
  let fx: PointerFixture;
  beforeEach(async () => {
    fx = await makePointerFixture();
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  const repo = () => ({ storagePath: fx.repoRoot, localPath: null, source: 'clone' });
  const recorded = () => ({
    repositoryId: 'r1',
    worktreeBranch: POINTER_BRANCH,
    worktreePath: fx.worktreePath,
  });

  // C3 (#214)
  it('C3 claims no worktree boundary when the latest 01 round is skipped', async () => {
    await fx.mkWorktree();
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'skipped', output: null }],
    });
    await expect(resolveInvocationUsesWorktreeGitBoundary(db, 't1')).resolves.toBe(false);
  });

  it('C3 reads the repository root for the dispatch-side tree when the latest 01 round is skipped', async () => {
    await fx.mkWorktree();
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'skipped', output: null }],
    });
    await expect(resolveInvocationWorkerTree(db, 't1')).resolves.toBe(fx.repoRoot);
  });

  // G2
  it('G2 keeps the worktree boundary for a Retry state (output null, 01 not skipped, directory present)', async () => {
    await fx.mkWorktree();
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'waiting_form', output: null }],
    });
    await expect(resolveInvocationUsesWorktreeGitBoundary(db, 't1')).resolves.toBe(true);
    await expect(resolveInvocationWorkerTree(db, 't1')).resolves.toBe(fx.worktreePath);
  });

  // G4
  it('G4 claims no worktree boundary when no worktree was ever recorded', async () => {
    const db = pointerDb({
      task: { repositoryId: 'r1', worktreeBranch: null, worktreePath: null },
      repo: repo(),
      steps: [],
    });
    await expect(resolveInvocationUsesWorktreeGitBoundary(db, 't1')).resolves.toBe(false);
    await expect(resolveInvocationWorkerTree(db, 't1')).resolves.toBe(fx.repoRoot);
  });
});

// p2: a local-path repository (storagePath null) keeps its worktrees under its own localPath.
describe('worktree boundary against a local-path repository', () => {
  let localPath: string;
  beforeEach(async () => {
    localPath = await mkdtemp(path.join(tmpdir(), 'wt-localpath-boundary-'));
  });
  afterEach(async () => {
    await rm(localPath, { recursive: true, force: true });
  });

  const wtDir = () => path.join(localPath, '.haive', 'worktrees', 'feature-x');
  const taskRow = () => ({ worktreeBranch: POINTER_BRANCH, worktreePath: wtDir() });
  const db = () =>
    pointerDb({
      task: taskRow(),
      repo: { source: 'local', storagePath: null, localPath },
      steps: [{ status: 'done', output: null }],
    });
  const pointer = () => ({
    userId: 'u1',
    repositoryId: 'r1',
    worktreeBranch: POINTER_BRANCH,
    worktreePath: wtDir(),
  });

  it('P2 answers the branch when the worktree directory exists under localPath', async () => {
    await mkdir(wtDir(), { recursive: true });
    await expect(resolveInvocationWorktreeBranch(db(), 't1', pointer())).resolves.toBe(
      POINTER_BRANCH,
    );
    await expect(resolveInvocationUsesWorktreeGitBoundary(db(), 't1')).resolves.toBe(true);
  });

  it('P2 still throws WorktreeRemovedError when the directory is absent under localPath', async () => {
    await expect(resolveInvocationWorktreeBranch(db(), 't1', pointer())).rejects.toMatchObject({
      name: 'WorktreeRemovedError',
    });
    await expect(resolveInvocationUsesWorktreeGitBoundary(db(), 't1')).rejects.toMatchObject({
      name: 'WorktreeRemovedError',
    });
  });

  it('P2 refuses a worktree directory that is a link as not a directory, not as removed', async () => {
    await mkdir(path.dirname(wtDir()), { recursive: true });
    await symlink(tmpdir(), wtDir());
    const err = await resolveInvocationWorktreeBranch(db(), 't1', pointer()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe('WorktreeRemovedError');
    expect((err as Error).message).toMatch(/not a directory/i);
  });
});
