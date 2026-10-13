import { describe, expect, it } from 'vitest';
import { isStepSkippable } from '../src/routes/tasks/_helpers.js';
import { staticStepFlags } from './step-flags-fixture.js';

const flags = staticStepFlags();
const WORKTREE = '01-worktree-setup';

describe('isStepSkippable', () => {
  it('allows a step whose catalog row opts in, for any task', () => {
    expect(isStepSkippable(flags, '11g-save-database', { type: 'workflow' })).toBe(true);
    expect(isStepSkippable(flags, '07-phase-2-implement', { type: 'workflow' })).toBe(false);
  });

  it('refuses a step the catalog does not know', () => {
    expect(isStepSkippable(new Map(), '11g-save-database', { type: 'workflow' })).toBe(false);
    expect(isStepSkippable(flags, 'zz-unknown', { type: 'run_app' })).toBe(false);
  });

  it('lets a run_app task skip the worktree', () => {
    expect(isStepSkippable(flags, WORKTREE, { type: 'run_app', runListSnapshot: null })).toBe(true);
  });

  it('keeps the worktree unskippable for a workflow task, which has no snapshot', () => {
    expect(isStepSkippable(flags, WORKTREE, { type: 'workflow', runListSnapshot: null })).toBe(
      false,
    );
    expect(isStepSkippable(flags, WORKTREE, { type: 'workflow' })).toBe(false);
  });

  it('lets a snapshot skip the worktree when nothing after it needs it', () => {
    expect(
      isStepSkippable(flags, WORKTREE, {
        type: 'live-worktree-check',
        runListSnapshot: [WORKTREE],
      }),
    ).toBe(true);
  });

  it('refuses the skip when a later step needs the worktree', () => {
    expect(
      isStepSkippable(flags, WORKTREE, {
        type: 'custom',
        runListSnapshot: [WORKTREE, '07-phase-2-implement'],
      }),
    ).toBe(false);
  });

  it('refuses the skip when the snapshot does not hold the worktree step', () => {
    expect(
      isStepSkippable(flags, WORKTREE, {
        type: 'custom',
        runListSnapshot: ['07-phase-2-implement'],
      }),
    ).toBe(false);
  });

  it('refuses the skip when the catalog is empty, so no composition can be checked', () => {
    expect(
      isStepSkippable(new Map(), WORKTREE, { type: 'custom', runListSnapshot: [WORKTREE] }),
    ).toBe(false);
  });
});
