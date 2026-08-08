import { describe, expect, it } from 'vitest';
import { shouldFollowRunningTerminals } from './terminal-autoscroll';

describe('shouldFollowRunningTerminals', () => {
  it('does not move on the first observation', () => {
    expect(shouldFollowRunningTerminals(null, ['a', 'b'])).toBe(false);
  });

  it('follows a run that starts', () => {
    expect(shouldFollowRunningTerminals(['a'], ['a', 'b'])).toBe(true);
  });

  it('follows a run that ENDS while a sibling keeps going', () => {
    // The reported bug: run `a` exits, `b` is still streaming, and nothing new
    // starts in the same poll — the view has to move off the dead terminal.
    expect(shouldFollowRunningTerminals(['a', 'b'], ['b'])).toBe(true);
  });

  it('follows a queue drain (one ends, one starts in the same poll)', () => {
    expect(shouldFollowRunningTerminals(['a', 'b'], ['b', 'c'])).toBe(true);
  });

  it('stays put when the running set is unchanged', () => {
    expect(shouldFollowRunningTerminals(['a', 'b'], ['a', 'b'])).toBe(false);
    // Set membership, not list order: the API returns newest-first and a re-sort
    // must not read as a change.
    expect(shouldFollowRunningTerminals(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('stays put when the last run ends — the page-level effect owns what comes next', () => {
    expect(shouldFollowRunningTerminals(['a'], [])).toBe(false);
  });

  it('stays put while every run is still queued (none started yet)', () => {
    expect(shouldFollowRunningTerminals([], [])).toBe(false);
  });
});
