import { describe, it, expect } from 'vitest';
import { parkQueueScore } from './runtime-admission.js';

/** A plausible join time — the magnitude matters, since the whole design rests on a join time
 *  never bleeding into the next vote band. */
const T0 = 1_786_000_000_000;

describe('parkQueueScore', () => {
  it('at score 0 the order is exactly FIFO', () => {
    const a = parkQueueScore(0, T0);
    const b = parkQueueScore(0, T0 + 1);
    expect(a).toBeLessThan(b);
    // …and every entry is offset by the SAME constant, which is what makes the rollout a no-op.
    expect(parkQueueScore(0, T0 + 5) - parkQueueScore(0, T0)).toBe(5);
  });

  it('a higher vote sorts ahead of an earlier join', () => {
    // The whole point: someone who arrived an hour later but is voted up goes first.
    expect(parkQueueScore(3, T0 + 3_600_000)).toBeLessThan(parkQueueScore(0, T0));
  });

  it('within a band the earlier join still wins', () => {
    expect(parkQueueScore(3, T0)).toBeLessThan(parkQueueScore(3, T0 + 1));
  });

  it('a join time can never bleed into the next band', () => {
    // One band apart, worst case: the latest conceivable join in the better band must still beat
    // the earliest in the worse one. Guards the PARK_SCORE_BAND width against clock growth.
    const farFuture = T0 * 4; // year ~2196
    expect(parkQueueScore(1, farFuture)).toBeLessThan(parkQueueScore(0, 0));
  });

  it('clamps an out-of-range stored score instead of trusting the row', () => {
    expect(parkQueueScore(99, T0)).toBe(parkQueueScore(5, T0));
    expect(parkQueueScore(-99, T0)).toBe(parkQueueScore(-5, T0));
  });

  it('stays exact in a Redis ZSET score (an IEEE-754 double)', () => {
    for (const v of [-5, 0, 5]) {
      const score = parkQueueScore(v, T0);
      expect(Number.isSafeInteger(score)).toBe(true);
      expect(score).toBeLessThan(2 ** 53);
      // Round-trips through the string form ioredis sends and Redis parses back.
      expect(Number(String(score))).toBe(score);
    }
  });
});
