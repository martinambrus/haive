import { describe, it, expect } from 'vitest';
import {
  decayedPriorities,
  DECAY_STATES,
  type QueuedJobView,
  type TaskLoad,
} from './priority-decay.js';

/** fairPriority: band = 5 + rank - score, priority = band * 1000 + tiebreak. */
const load = (over: Partial<TaskLoad> = {}): TaskLoad => ({
  runningCount: 0,
  userTiebreak: 0,
  voteScore: 0,
  ...over,
});

const job = (jobId: string, priority: number, taskId = 't1'): QueuedJobView => ({
  jobId,
  taskId,
  priority,
});

describe('decayedPriorities', () => {
  it('decays a drained fan-out back to rank 1', () => {
    // The bug, in miniature: three jobs priced during a 5-wide mining fan-out (bands 9/10/11)
    // whose agents have all since finished. Their bands must fall to 5/6/7, not stay put.
    const queued = [job('1', 9000), job('2', 10_000), job('3', 11_000)];
    const out = decayedPriorities(queued, new Map([['t1', load({ voteScore: 1 })]]));
    expect(out.map((r) => r.to)).toEqual([5000, 6000, 7000]);
  });

  it('counts STARTED agents as the base the queue positions build on', () => {
    // Two agents already running means the next queued job is this task's third, not its first
    // — dropping rank entirely would let one task's fan-out eat the whole pool.
    const out = decayedPriorities([job('1', 9000)], new Map([['t1', load({ runningCount: 2 })]]));
    expect(out[0]?.to).toBe(8000); // band 5 + 3 - 0
  });

  it('returns nothing when every band already matches, so a settled queue writes nothing', () => {
    const out = decayedPriorities([job('1', 6007)], new Map([['t1', load({ userTiebreak: 7 })]]));
    expect(out).toEqual([]);
  });

  it('never touches a FIFO job', () => {
    // priority 0 means fair scheduling was off at enqueue: the job sits in `waiting`, which is
    // deliberately unordered. Assigning it a priority would move it into `prioritized` and
    // reorder it against jobs nobody ordered — the same rule repriceTaskCliJobs follows.
    expect(decayedPriorities([job('1', 0)], new Map([['t1', load()]]))).toEqual([]);
    expect(decayedPriorities([job('1', Number.NaN)], new Map([['t1', load()]]))).toEqual([]);
  });

  it('leaves a job alone when its task cannot be resolved', () => {
    // A task row that is gone (or a queue entry from another install) must not be repriced from
    // a guessed load.
    expect(decayedPriorities([job('1', 9000, 'ghost')], new Map())).toEqual([]);
  });

  it('re-prices a task backlog without reshuffling it', () => {
    // Input deliberately out of order; the output ranks must follow CURRENT priority order,
    // because that is the order BullMQ will actually serve them in.
    const queued = [job('7', 11_000), job('3', 9000), job('5', 10_000)];
    const out = decayedPriorities(queued, new Map([['t1', load()]]));
    expect(out.map((r) => [r.jobId, r.to])).toEqual([
      ['3', 6000],
      ['5', 7000],
      ['7', 8000],
    ]);
  });

  it('breaks an equal-priority tie by numeric job id, so a sweep cannot oscillate', () => {
    // "9" must sort before "10" — a string compare would flip these two every pass, and each
    // flip is a queue write.
    const out = decayedPriorities([job('10', 9000), job('9', 9000)], new Map([['t1', load()]]));
    expect(out.map((r) => r.jobId)).toEqual(['9', '10']);
  });

  it('keeps the vote term — the decay rebuilds the band, it does not erase the boost', () => {
    const out = decayedPriorities([job('1', 9000)], new Map([['t1', load({ voteScore: 5 })]]));
    expect(out[0]?.to).toBe(1000); // band = rank at +5, which is what outranks every neutral job
  });

  it('reproduces the measured regression: an idle +1 task retakes the head', () => {
    // Live numbers from the dev host. onboard_glm_53_max sat at 9012 with ZERO agents in
    // flight, behind a neutral Add DDEV job at 6007 that had two agents running. After the
    // decay the upvoted idle task must sort ahead of that 6007.
    const out = decayedPriorities(
      [job('20687', 9012)],
      new Map([['t1', load({ runningCount: 0, userTiebreak: 12, voteScore: 1 })]]),
    );
    expect(out[0]?.to).toBe(5012);
    expect(out[0]?.to).toBeLessThan(6007);
  });

  it('reaches delayed jobs too, or a gated job keeps a stale band until it promotes', () => {
    expect(DECAY_STATES).toContain('delayed');
    expect(DECAY_STATES).toContain('prioritized');
    expect(DECAY_STATES).toContain('waiting');
  });
});
