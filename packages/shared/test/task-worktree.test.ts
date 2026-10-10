import { describe, expect, it } from 'vitest';
import { decideTaskWorktree } from '../src/task-worktree.js';

const out = {
  mode: 'worktree',
  branchName: 'feat/out',
  worktreePath: '/r/.haive/worktrees/feat-out',
};

describe('decideTaskWorktree', () => {
  it('roots a task with nothing recorded', () => {
    expect(
      decideTaskWorktree({
        columnBranch: null,
        columnPath: null,
        latestStatus: null,
        output: null,
      }),
    ).toEqual({ kind: 'root' });
  });

  it('roots a task whose latest 01 round is skipped, whatever the columns say', () => {
    expect(
      decideTaskWorktree({
        columnBranch: 'feat/x',
        columnPath: '/r/.haive/worktrees/feat-x',
        latestStatus: 'skipped',
        output: out,
      }),
    ).toEqual({ kind: 'root' });
  });

  it('answers the columns when they are set, ahead of 01 output', () => {
    expect(
      decideTaskWorktree({
        columnBranch: 'feat/x',
        columnPath: '/r/.haive/worktrees/feat-x',
        latestStatus: 'done',
        output: out,
      }),
    ).toEqual({ kind: 'worktree', branch: 'feat/x', path: '/r/.haive/worktrees/feat-x' });
  });

  it('keeps the columns for a Retry state with the output nulled', () => {
    expect(
      decideTaskWorktree({
        columnBranch: 'feat/x',
        columnPath: null,
        latestStatus: 'waiting_form',
        output: null,
      }),
    ).toEqual({ kind: 'worktree', branch: 'feat/x', path: null });
  });

  it('falls back to 01 output when both columns are null', () => {
    expect(
      decideTaskWorktree({
        columnBranch: null,
        columnPath: null,
        latestStatus: 'done',
        output: out,
      }),
    ).toEqual({ kind: 'worktree', branch: 'feat/out', path: '/r/.haive/worktrees/feat-out' });
  });

  it('roots a task whose output names no worktree', () => {
    expect(
      decideTaskWorktree({
        columnBranch: '',
        columnPath: undefined,
        latestStatus: 'done',
        output: { mode: 'none' },
      }),
    ).toEqual({ kind: 'root' });
  });
});
