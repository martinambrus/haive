import { describe, expect, it } from 'vitest';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { worktreeGitfileMask } from './gitfile-mask.js';

describe('worktreeGitfileMask', () => {
  it('masks the gitfile of a linked worktree', () => {
    const wt = `${SANDBOX_WORKDIR}/.haive/worktrees/feature-add-ddev-environment`;
    expect(worktreeGitfileMask(wt)).toEqual([{ containerPath: `${wt}/.git`, content: '' }]);
  });

  // The repo root's `.git` is a directory, and the parent checkout's git must work.
  it('does not mask when the workdir is the repo root', () => {
    expect(worktreeGitfileMask(SANDBOX_WORKDIR)).toEqual([]);
  });

  it('does not mask when no workdir was resolved', () => {
    expect(worktreeGitfileMask('')).toEqual([]);
  });
});
