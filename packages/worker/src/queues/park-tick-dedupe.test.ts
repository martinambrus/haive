import { describe, it, expect } from 'vitest';

/** F2's open half: the duplicate advance-step job was still being ENQUEUED — the earlier
 *  guard only made the second one harmless once it arrived.
 *
 *  Source: a park re-drives itself on a delayed advance for the same (step, round, epoch).
 *  Nothing deduplicated those, so a step that parked twice had two live jobs and BOTH fired
 *  when the hold lifted. MEASURED on task 153a3437: 08-phase-5-verify's apply() ran twice
 *  0.63s apart, running its verify commands twice.
 *
 *  Mirrors the id builder and the option shape rather than reaching into the queue, which
 *  needs Redis. The dedupe behaviour itself was verified empirically against BullMQ: adding
 *  twice with one jobId leaves exactly 1 waiting job. */
const parkTickJobId = (taskId: string, stepId: string, round: number, epoch?: number): string =>
  `park__${taskId}__${stepId}__${round}__${epoch ?? 'noepoch'}`;

const optsFor = (parkTick: boolean) =>
  parkTick
    ? { jobId: parkTickJobId('t', 's', 0, 1), removeOnComplete: true, removeOnFail: true }
    : { removeOnComplete: 100, removeOnFail: 100 };

describe('park tick dedupe key', () => {
  it('collapses repeat ticks for the same step, round and epoch', () => {
    expect(parkTickJobId('t1', '08', 0, 5)).toBe(parkTickJobId('t1', '08', 0, 5));
  });

  it('separates rounds — a fix round is a different step row', () => {
    expect(parkTickJobId('t1', '07', 0, 5)).not.toBe(parkTickJobId('t1', '07', 1, 5));
  });

  it('separates epochs so a retry/reset gets a fresh id', () => {
    // A retry bumps the orchestration epoch. Reusing the id would collide with a stale
    // tick the epoch guard is about to drop anyway, and the new tick would be swallowed.
    expect(parkTickJobId('t1', '07', 0, 5)).not.toBe(parkTickJobId('t1', '07', 0, 6));
  });

  it('separates tasks', () => {
    expect(parkTickJobId('t1', '07', 0, 5)).not.toBe(parkTickJobId('t2', '07', 0, 5));
  });

  it('is stable when no epoch is carried', () => {
    expect(parkTickJobId('t1', '07', 0)).toBe(parkTickJobId('t1', '07', 0, undefined));
  });
});

describe('park tick id is a legal BullMQ custom id', () => {
  it('contains no colon — BullMQ rejects those outright', () => {
    // `Custom Id cannot contain :` — BullMQ uses ':' as its Redis key separator. A
    // colon-separated key threw on the first park tick and failed a live task.
    expect(parkTickJobId('t1', '05-phase-0b5-spec-quality', 0, 5)).not.toContain(':');
  });

  it('still separates every field despite the safe separator', () => {
    expect(parkTickJobId('t1', 'a', 0, 1)).not.toBe(parkTickJobId('t1', 'b', 0, 1));
    expect(parkTickJobId('t1', 'a', 0, 1)).not.toBe(parkTickJobId('t1', 'a', 1, 1));
  });
});

describe('park tick job options', () => {
  it('removes on complete AND fail — a lingering id would stop the loop re-arming', () => {
    // THE hazard of keying a poll on a fixed id: with the default numeric retention the
    // completed job keeps the id, the next `add` is silently dropped as a duplicate, the
    // park never re-checks its condition, and the task hangs on a hold forever.
    const o = optsFor(true);
    expect(o.removeOnComplete).toBe(true);
    expect(o.removeOnFail).toBe(true);
  });

  it('leaves ordinary hand-offs undeduplicated', () => {
    // A hand-off is not a poll: dropping one strands the chain, so it keeps the numeric
    // retention and gets a fresh id every time.
    const o = optsFor(false);
    expect('jobId' in o).toBe(false);
    expect(o.removeOnComplete).toBe(100);
  });
});
