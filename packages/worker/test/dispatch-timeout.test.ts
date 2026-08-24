import { describe, it, expect } from 'vitest';
import {
  overrideOr,
  overrideOrLearned,
  escalatedTimeoutMs,
  LEARNED_TIMEOUT_MAX_MS,
} from '../src/step-engine/dispatch-timeout.js';

const step = (over: Record<string, unknown> = {}) =>
  ({ cliTimeoutOverrideMs: null, cliTimeoutLearnedMs: null, ...over }) as never;

describe('overrideOrLearned', () => {
  it('lets an explicit human override beat a learned value', () => {
    // Someone who chose 90 minutes on the retry route must not have it silently replaced by an
    // inferred number, in either direction.
    expect(
      overrideOrLearned(
        step({ cliTimeoutOverrideMs: 90 * 60_000, cliTimeoutLearnedMs: 20 * 60_000 }),
        1000,
      ),
    ).toBe(90 * 60_000);
  });

  it('uses the learned value when there is no override', () => {
    expect(overrideOrLearned(step({ cliTimeoutLearnedMs: 60 * 60_000 }), 1000)).toBe(60 * 60_000);
  });

  it('falls through to the declared budget when neither is set', () => {
    expect(overrideOrLearned(step(), 1000)).toBe(1000);
    expect(overrideOrLearned(step(), undefined)).toBeUndefined();
  });

  it('treats a non-positive stored value as absent', () => {
    expect(overrideOrLearned(step({ cliTimeoutOverrideMs: 0, cliTimeoutLearnedMs: 0 }), 1000)).toBe(
      1000,
    );
  });

  it('leaves plain overrideOr untouched — no ladder on the flat path', () => {
    expect(overrideOr(step({ cliTimeoutLearnedMs: 60 * 60_000 }), 1000)).toBe(1000);
  });
});

describe('escalatedTimeoutMs', () => {
  it('doubles the budget that actually failed', () => {
    // MEASURED: a coder died at 1892s against a 30m budget and was re-dispatched at 30m twice
    // more until its retries were spent and the work abandoned.
    expect(escalatedTimeoutMs(30 * 60_000)).toBe(60 * 60_000);
    expect(escalatedTimeoutMs(60 * 60_000)).toBe(120 * 60_000);
  });

  it('clamps at the learned ceiling', () => {
    expect(escalatedTimeoutMs(LEARNED_TIMEOUT_MAX_MS)).toBe(LEARNED_TIMEOUT_MAX_MS);
  });

  it('returns null rather than inventing a budget it cannot derive', () => {
    expect(escalatedTimeoutMs(undefined)).toBeNull();
    expect(escalatedTimeoutMs(0)).toBeNull();
  });
});
