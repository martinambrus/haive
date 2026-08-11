import { describe, expect, it } from 'vitest';
import { waitAheadCount } from '../src/routes/cli-login-banner.js';

/** `getWaiting` returns LRANGE order — head first — and BullMQ adds at the head while the
 *  worker takes from the tail. So the OLDEST job is last in these arrays and is served first,
 *  which is the opposite of the index it is tempting to read. */
describe('waitAheadCount', () => {
  it('reports nobody ahead of the only queued job', () => {
    expect(waitAheadCount(['a'], 'a')).toBe(0);
  });

  it('counts from the tail, because the tail is served next', () => {
    // 'c' was added first and runs first; 'a' was added last and waits for both.
    expect(waitAheadCount(['a', 'b', 'c'], 'c')).toBe(0);
    expect(waitAheadCount(['a', 'b', 'c'], 'b')).toBe(1);
    expect(waitAheadCount(['a', 'b', 'c'], 'a')).toBe(2);
  });

  it('returns null once the job has left the wait list', () => {
    // It is starting (or already gone). Publishing a stale position would count a slot the
    // dialog is no longer waiting for.
    expect(waitAheadCount(['a', 'b'], 'c')).toBeNull();
    expect(waitAheadCount([], 'a')).toBeNull();
  });
});
