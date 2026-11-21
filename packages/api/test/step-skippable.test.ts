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

  describe('span entries', () => {
    const SKIPPABLE = '11g-save-database';
    const pin = (firstStepId: string, lastStepId = firstStepId) => ({
      version: 1,
      guardedSpans: [
        { id: 's', firstStepId, lastStepId, predicateId: 'module.fx.planned', args: {} },
      ],
    });

    it('refuses a step that opens a guarded span even when its catalog row opts in', () => {
      expect(
        isStepSkippable(flags, SKIPPABLE, { type: 'workflow', executionContract: pin(SKIPPABLE) }),
      ).toBe(false);
    });

    it('refuses the worktree entry of a span on a run_app task', () => {
      expect(
        isStepSkippable(flags, WORKTREE, {
          type: 'run_app',
          runListSnapshot: null,
          executionContract: pin(WORKTREE),
        }),
      ).toBe(false);
    });

    it('keeps a skippable step that only closes or sits inside a span skippable', () => {
      expect(
        isStepSkippable(flags, SKIPPABLE, {
          type: 'workflow',
          executionContract: pin('07-phase-2-implement', SKIPPABLE),
        }),
      ).toBe(true);
    });

    it('F5 refuses a skippable step when the pin is malformed, and allows it with a null pin', () => {
      expect(
        isStepSkippable(flags, SKIPPABLE, {
          type: 'workflow',
          executionContract: { version: 99 },
        }),
      ).toBe(false);
      expect(isStepSkippable(flags, SKIPPABLE, { type: 'workflow', executionContract: null })).toBe(
        true,
      );
    });

    it.each([
      ['no pin', undefined],
      ['a null pin', null],
      ['an empty pin', { version: 1, guardedSpans: [] }],
      ['a span elsewhere', pin('07-phase-2-implement')],
    ])('keeps a skippable step skippable under %s', (_label, executionContract) => {
      expect(isStepSkippable(flags, SKIPPABLE, { type: 'workflow', executionContract })).toBe(true);
    });
  });

  describe('pinned fix target', () => {
    const TARGET = 'module.fix-demo.repair';
    const withTarget = new Map(flags).set(TARGET, {
      ...flags.get('11g-save-database')!,
      stepId: TARGET,
      allowSkip: true,
    });
    const fixPin = (stepId: string) => ({
      version: 1,
      guardedSpans: [],
      fixTarget: { stepId, capabilityVersion: 1 },
    });

    it('refuses the target the pin names, even when its catalog row opts in', () => {
      expect(
        isStepSkippable(withTarget, TARGET, {
          type: 'workflow',
          executionContract: fixPin(TARGET),
        }),
      ).toBe(false);
    });

    it('keeps the same step skippable without a pin or when the pin names another step', () => {
      expect(isStepSkippable(withTarget, TARGET, { type: 'workflow' })).toBe(true);
      expect(
        isStepSkippable(withTarget, TARGET, {
          type: 'workflow',
          executionContract: fixPin('module.fix-demo.other'),
        }),
      ).toBe(true);
    });

    it('refuses under a malformed pin and leaves 07 and ordinary steps unchanged', () => {
      expect(
        isStepSkippable(withTarget, TARGET, {
          type: 'workflow',
          executionContract: { version: 99 },
        }),
      ).toBe(false);
      const task = { type: 'workflow', executionContract: fixPin(TARGET) };
      expect(isStepSkippable(withTarget, '07-phase-2-implement', task)).toBe(false);
      expect(isStepSkippable(withTarget, '11g-save-database', task)).toBe(true);
    });
  });
});
