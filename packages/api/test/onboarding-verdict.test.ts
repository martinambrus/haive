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
