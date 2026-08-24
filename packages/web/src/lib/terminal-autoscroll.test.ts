import { describe, expect, it } from 'vitest';
import { shouldFollowActiveTerminals } from './terminal-autoscroll';

const at = (running: string[], queued: string[] = []) => ({ running, queued });

describe('shouldFollowActiveTerminals', () => {
  it('does not move on the first observation', () => {
    expect(shouldFollowActiveTerminals(null, at(['a', 'b']))).toBe(false);
  });

  it('follows a run that starts', () => {
    expect(shouldFollowActiveTerminals(at(['a']), at(['a', 'b']))).toBe(true);
  });

  it('follows a run that ENDS while a sibling keeps going', () => {
    // Run `a` exits, `b` is still streaming, and nothing new starts in the same
    // poll — the view has to move off the dead terminal.
    expect(shouldFollowActiveTerminals(at(['a', 'b']), at(['b']))).toBe(true);
  });

  it('follows a queue drain (one ends, one starts in the same poll)', () => {
    expect(shouldFollowActiveTerminals(at(['a', 'b']), at(['b', 'c']))).toBe(true);
  });

  it('follows a run that ends leaving only a QUEUED replacement', () => {
    // The reported bug: run 1 finishes, run 2 is enqueued but the machine is at
    // capacity so it never starts. The running set empties in the same poll the
    // queued one appears, and a running-only trigger read that as "step over".
    expect(shouldFollowActiveTerminals(at(['a']), at([], ['b']))).toBe(true);
  });

  it('follows a run being ENQUEUED while another keeps running', () => {
    // Target choice (running over queued) is scrollToNewestActiveTerminal's job;
    // this only has to fire.
    expect(shouldFollowActiveTerminals(at(['a']), at(['a'], ['b']))).toBe(true);
  });

  it('follows a queued run finally getting a slot', () => {
    expect(shouldFollowActiveTerminals(at([], ['b']), at(['b']))).toBe(true);
  });

  it('stays put when neither set changed', () => {
    expect(shouldFollowActiveTerminals(at(['a', 'b']), at(['a', 'b']))).toBe(false);
    // Set membership, not list order: the API returns newest-first and a re-sort
    // must not read as a change.
    expect(shouldFollowActiveTerminals(at(['a', 'b']), at(['b', 'a']))).toBe(false);
    expect(shouldFollowActiveTerminals(at(['a'], ['b', 'c']), at(['a'], ['c', 'b']))).toBe(false);
  });

  it('stays put when the last run ends and nothing is queued — the page-level effect owns what comes next', () => {
    expect(shouldFollowActiveTerminals(at(['a']), at([]))).toBe(false);
    expect(shouldFollowActiveTerminals(at([], ['b']), at([]))).toBe(false);
  });

  it('stays put when nothing is active at all', () => {
    expect(shouldFollowActiveTerminals(at([]), at([]))).toBe(false);
  });
});
