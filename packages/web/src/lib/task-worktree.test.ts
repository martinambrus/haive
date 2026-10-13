import { describe, expect, it } from 'vitest';
import { taskUsesWorktree } from './task-worktree';

const CUSTOM = ['01-worktree-setup', '07-phase-2-implement', '08c-code-review'];

describe('taskUsesWorktree', () => {
  it('is true for a custom type whose run list sets up a worktree', () => {
    expect(taskUsesWorktree({ type: 'review_only', runListSnapshot: CUSTOM })).toBe(true);
  });

  it('is false for a custom type without that step, or without a list', () => {
    expect(
      taskUsesWorktree({ type: 'review_only', runListSnapshot: ['07-phase-2-implement'] }),
    ).toBe(false);
    expect(taskUsesWorktree({ type: 'review_only', runListSnapshot: null })).toBe(false);
    expect(taskUsesWorktree({ type: 'review_only' })).toBe(false);
  });

  it('stays true for workflow and run_app, with or without a list', () => {
    for (const type of ['workflow', 'run_app']) {
      expect(taskUsesWorktree({ type })).toBe(true);
      expect(taskUsesWorktree({ type, runListSnapshot: null })).toBe(true);
      expect(taskUsesWorktree({ type, runListSnapshot: ['07-phase-2-implement'] })).toBe(true);
    }
  });

  it('stays false for other built-in types and before the task loads', () => {
    expect(taskUsesWorktree({ type: 'onboarding', runListSnapshot: null })).toBe(false);
    expect(taskUsesWorktree(null)).toBe(false);
  });
});
