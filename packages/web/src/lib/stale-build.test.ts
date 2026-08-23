import { describe, expect, it } from 'vitest';
import { shouldWarnStaleBuild } from './stale-build';

const state = (over: Partial<Parameters<typeof shouldWarnStaleBuild>[0]> = {}) =>
  shouldWarnStaleBuild({ baseline: null, current: null, dismissed: null, ...over });

describe('shouldWarnStaleBuild', () => {
  it('is silent before the first poll answers', () => {
    expect(state()).toBe(false);
  });

  it('is silent while the code has not moved', () => {
    expect(state({ baseline: '1787480000000', current: '1787480000000' })).toBe(false);
  });

  it('speaks once the stamp moves past the one this tab loaded with', () => {
    expect(state({ baseline: '1787480000000', current: '1787484000000' })).toBe(true);
  });

  it('stays silent after a dismiss of that same change', () => {
    expect(
      state({ baseline: '1787480000000', current: '1787484000000', dismissed: '1787484000000' }),
    ).toBe(false);
  });

  it('speaks again on the NEXT change after a dismiss', () => {
    // A dismiss answers one change, not every future one — otherwise the first dismiss of a long
    // session silences the reload prompt for the rest of it.
    expect(
      state({ baseline: '1787480000000', current: '1787488000000', dismissed: '1787484000000' }),
    ).toBe(true);
  });

  it('never fires on an unreadable stamp, because it compares against itself', () => {
    expect(state({ baseline: 'unknown', current: 'unknown' })).toBe(false);
  });
});
