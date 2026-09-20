import { describe, expect, it } from 'vitest';
import {
  NO_ONBOARDING_TASKS,
  resolveOnboardingVerdict,
  type OnboardingTaskFacts,
} from '../src/lib/onboarding-state.js';

const ALL_PRESENT: string[] = [];
const SOME_MISSING = ['.claude/skills'];

function facts(over: Partial<OnboardingTaskFacts> = {}): OnboardingTaskFacts {
  return { ...NO_ONBOARDING_TASKS, ...over };
}

describe('resolveOnboardingVerdict', () => {
  it('is not onboarded while a run is in flight, markers or no markers', () => {
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      facts: facts({ liveTaskId: 'task-1', hasAny: true }),
    });
    expect(v).toEqual({ onboarded: false, inProgressTaskId: 'task-1', canMarkOnboarded: false });
  });

  it('does not let a completed earlier run cover for a live one', () => {
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: new Date(),
      facts: facts({ liveTaskId: 'task-2', hasAny: true, hasCompleted: true }),
    });
    expect(v.onboarded).toBe(false);
    expect(v.inProgressTaskId).toBe('task-2');
  });

  it('is not onboarded when every run so far was cancelled or failed', () => {
    // The bug this exists for: the markers are written at step 07 of 27, so a run
    // abandoned at KB QA leaves a repo that looks finished.
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      facts: facts({ hasAny: true }),
    });
    expect(v.onboarded).toBe(false);
    expect(v.canMarkOnboarded).toBe(true);
  });

  it('is onboarded once a run completed', () => {
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      facts: facts({ hasAny: true, hasCompleted: true }),
    });
    expect(v).toEqual({ onboarded: true, inProgressTaskId: null, canMarkOnboarded: false });
  });

  it('is onboarded from the stamp alone', () => {
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: new Date(),
      facts: facts({ hasAny: true }),
    });
    expect(v.onboarded).toBe(true);
  });

  it('is onboarded for a repo that arrived with the artifacts and no run history', () => {
    // Cloned in already onboarded, or onboarded before any of this was tracked. This clause
    // is why no backfill is needed.
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      facts: facts(),
    });
    expect(v.onboarded).toBe(true);
  });

  it('is not onboarded when a marker is missing, whatever the stamp says', () => {
    const v = resolveOnboardingVerdict({
      missing: SOME_MISSING,
      onboardedAt: new Date(),
      facts: facts({ hasAny: true, hasCompleted: true }),
    });
    expect(v.onboarded).toBe(false);
    // Nothing to vouch for, so the manual override is not offered either.
    expect(v.canMarkOnboarded).toBe(false);
  });
});

describe('resolveOnboardingVerdict across a reset', () => {
  const RESET_AT = new Date('2026-06-01T00:00:00Z');
  const BEFORE = new Date('2026-05-01T00:00:00Z');
  const AFTER = new Date('2026-07-01T00:00:00Z');

  it('stops reading onboarded when the newest completed run predates the reset', () => {
    // The whole point of the change: the completed task row lives forever, so `hasCompleted`
    // alone kept answering yes across a reset and guarding the stamp changed nothing visible.
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      onboardingResetAt: RESET_AT,
      facts: facts({ hasAny: true, hasCompleted: true, newestCompletedAt: BEFORE }),
    });
    expect(v.onboarded).toBe(false);
  });

  it('reads onboarded again once a run completes after the reset', () => {
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      onboardingResetAt: RESET_AT,
      facts: facts({ hasAny: true, hasCompleted: true, newestCompletedAt: AFTER }),
    });
    expect(v.onboarded).toBe(true);
  });

  it('fails closed on a completed run that carries no completion instant', () => {
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      onboardingResetAt: RESET_AT,
      facts: facts({ hasAny: true, hasCompleted: true, newestCompletedAt: null }),
    });
    expect(v.onboarded).toBe(false);
  });

  it('does not let "no run was ever started here" survive a reset', () => {
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      onboardingResetAt: RESET_AT,
      facts: facts(),
    });
    expect(v.onboarded).toBe(false);
  });

  it('refuses the manual override while the reset is unanswered', () => {
    // Otherwise the escape hatch hands back by hand exactly the state the reset removed —
    // and the markers cannot catch it, since a reset that could not read the tree leaves them.
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      onboardingResetAt: RESET_AT,
      facts: facts({ hasAny: true, hasCompleted: true, newestCompletedAt: BEFORE }),
    });
    expect(v.canMarkOnboarded).toBe(false);
  });

  it('still offers the manual override for a run that failed late, after a reset was answered', () => {
    const v = resolveOnboardingVerdict({
      missing: ALL_PRESENT,
      onboardedAt: null,
      onboardingResetAt: RESET_AT,
      // A later run completed, and a later one still was abandoned — the case the button is for.
      facts: facts({ hasAny: true, hasCompleted: true, newestCompletedAt: AFTER }),
    });
    expect(v.onboarded).toBe(true);
    expect(v.canMarkOnboarded).toBe(false);
  });

  it('is byte-identical to the old verdict on every repo nobody has reset', () => {
    for (const over of [
      { hasAny: true, hasCompleted: true },
      { hasAny: true },
      {},
      { hasAny: true, hasCompleted: true, newestCompletedAt: BEFORE },
    ]) {
      const withColumn = resolveOnboardingVerdict({
        missing: ALL_PRESENT,
        onboardedAt: null,
        onboardingResetAt: null,
        facts: facts(over),
      });
      const withoutColumn = resolveOnboardingVerdict({
        missing: ALL_PRESENT,
        onboardedAt: null,
        facts: facts(over),
      });
      expect(withColumn).toEqual(withoutColumn);
    }
  });
});
