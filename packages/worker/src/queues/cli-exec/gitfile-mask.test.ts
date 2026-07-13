import { describe, expect, it } from 'vitest';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { worktreeGitfileMask } from './gitfile-mask.js';

describe('worktreeGitfileMask', () => {
  it('masks the gitfile at the workdir root when a worktree is mounted', () => {
    // The worktree is mounted ALONE at SANDBOX_WORKDIR, so its `.git` gitfile is there.
    expect(worktreeGitfileMask(true)).toEqual([
      { containerPath: `${SANDBOX_WORKDIR}/.git`, content: '' },
    ]);
  });

  // The repo root's `.git` is a directory, and the parent checkout's git must work.
  it('does not mask when no worktree is mounted (repo root)', () => {
    expect(worktreeGitfileMask(false)).toEqual([]);
  });
});
