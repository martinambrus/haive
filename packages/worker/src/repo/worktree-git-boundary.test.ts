import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import {
  invocationUsesWorktreeGitBoundary,
  resolveInvocationUsesWorktreeGitBoundary,
  withWorktreeGitBoundary,
  WORKTREE_GIT_BOUNDARY_MARKER,
} from './worktree-git-boundary.js';

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
  function dbFor(
    task: { repositoryId: string | null; worktreeBranch: string | null } | null,
    repo: { storagePath: string | null; localPath: string | null } | null,
  ): Database {
    return {
      query: {
        tasks: { findFirst: async () => task ?? undefined },
        repositories: { findFirst: async () => repo ?? undefined },
      },
    } as unknown as Database;
  }

  it('resolves the same target override that will be queued', async () => {
    const db = dbFor(
      { repositoryId: 'repo-1', worktreeBranch: 'feature/x' },
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
