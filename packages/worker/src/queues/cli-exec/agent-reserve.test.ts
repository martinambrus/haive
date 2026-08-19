import { describe, it, expect } from 'vitest';
import type { JobType } from 'bullmq';
import { CLI_EXEC_JOB_NAMES } from '@haive/shared';
import {
  agentReserveDecision,
  countWaitingHolderJobs,
  QUEUED_STATES,
  type AgentReserveInput,
  type QueuedJobSource,
} from './agent-reserve.js';

const TEN_MIN = 10 * 60_000;

/** Baseline: the reserve is on, two tasks hold runners, this job's task holds none, and one of
 *  the holders has a job queued — i.e. the case the gate exists for. */
function decide(over: Partial<AgentReserveInput> = {}): 'allow' | 'defer' {
  return agentReserveDecision({
    enabled: true,
    holderCount: 2,
    holdsRunner: false,
    waitingHolderJobs: 1,
    heldForMs: 0,
    maxHoldMs: TEN_MIN,
    voteScore: 0,
    maxHolderVoteScore: 0,
    ...over,
  });
}

describe('agentReserveDecision', () => {
  it('defers a runner-less job while a holder has work queued', () => {
    expect(decide()).toBe('defer');
  });

  it('allows everything when the reserve is off', () => {
    // The kill switch also carries "the governor is disabled", which must mean pre-feature
    // behavior everywhere.
    expect(decide({ enabled: false, waitingHolderJobs: 99 })).toBe('allow');
  });

  it('allows when no task holds a runtime runner', () => {
    // Nothing is sitting on committed RAM, so no slot is worth more than another.
    expect(decide({ holderCount: 0, waitingHolderJobs: 0 })).toBe('allow');
  });

  it('never gates a task that holds a runner itself', () => {
    // The whole point is to let holders finish and release their runners.
    expect(decide({ holdsRunner: true, waitingHolderJobs: 99 })).toBe('allow');
  });

  it('allows when no holder job is actually waiting', () => {
    // Holders parked at a form or a gate are not demand. Yielding to them would idle the slot.
    expect(decide({ waitingHolderJobs: 0 })).toBe('allow');
  });

  it('releases a job once it has been held for the max', () => {
    expect(decide({ heldForMs: TEN_MIN - 1 })).toBe('defer');
    expect(decide({ heldForMs: TEN_MIN })).toBe('allow');
    expect(decide({ heldForMs: TEN_MIN * 5 })).toBe('allow');
  });

  it('holds indefinitely at maxHoldMs 0 (strict priority)', () => {
    // 0 is "no escape", not "escape immediately" — the difference between a runner-less task
    // crawling and one that never yields at all.
    expect(decide({ maxHoldMs: 0, heldForMs: 0 })).toBe('defer');
    expect(decide({ maxHoldMs: 0, heldForMs: TEN_MIN * 100 })).toBe('defer');
  });

  it('yields while nobody has voted, so the vote term is inert by default', () => {
    // score 0 everywhere must reproduce the pre-vote behaviour exactly, the same property
    // fairPriority holds. Anything else makes rollout a silent behaviour change.
    expect(decide({ voteScore: 0, maxHolderVoteScore: 0 })).toBe('defer');
  });

  it('lets an explicit vote outrank the runner holders', () => {
    // The gap this closes: a vote re-prices the QUEUE, and this gate then handed the slot away
    // regardless — so an upvoted runner-less task sat behind neutral holders until the escape
    // hatch fired. Measured on a live host: 12.6, 14.1 and 21.9 minutes of queue wait for
    // +1 onboarding tasks while unvoted DDEV holders took every slot.
    expect(decide({ voteScore: 1, maxHolderVoteScore: 0 })).toBe('allow');
  });

  it('treats a downvoted holder as outranked by a neutral task', () => {
    // Downvoting the background work is the other half of the same lever.
    expect(decide({ voteScore: 0, maxHolderVoteScore: -1 })).toBe('allow');
  });

  it('needs a STRICT win — an equal or higher holder still gets the slot', () => {
    // A tie states no preference between the two, so the committed-RAM argument decides.
    expect(decide({ voteScore: 1, maxHolderVoteScore: 1 })).toBe('defer');
    expect(decide({ voteScore: 1, maxHolderVoteScore: 2 })).toBe('defer');
    expect(decide({ voteScore: -1, maxHolderVoteScore: 0 })).toBe('defer');
  });

  it('never lets the vote term gate a holder or an idle pool', () => {
    // Both earlier allows must survive a losing vote — a holder is never gated by its own rule.
    expect(decide({ holdsRunner: true, voteScore: -5, maxHolderVoteScore: 5 })).toBe('allow');
    expect(decide({ holderCount: 0, waitingHolderJobs: 0, voteScore: -5 })).toBe('allow');
  });

  it('checks the switch before anything else', () => {
    // A disabled reserve must not depend on a docker read having succeeded.
    expect(decide({ enabled: false, holderCount: 0, holdsRunner: false })).toBe('allow');
  });
});

/** A queue whose jobs are bucketed by BullMQ state, so a scan only sees what it asks for. */
function fakeQueue(byState: Record<string, Array<{ name: string; data: unknown }>>): {
  source: QueuedJobSource;
  scanned: JobType[][];
} {
  const scanned: JobType[][] = [];
  return {
    scanned,
    source: {
      getJobs(types) {
        scanned.push(types);
        return Promise.resolve(types.flatMap((t) => byState[t] ?? []));
      },
    },
  };
}

const invoke = (taskId: string): { name: string; data: unknown } => ({
  name: CLI_EXEC_JOB_NAMES.INVOKE,
  data: { taskId },
});

describe('countWaitingHolderJobs', () => {
  it('counts jobs queued in the PRIORITIZED list, not just waiting', async () => {
    // The regression that made this worth testing: BullMQ v5 puts a job enqueued with
    // opts.priority in `prioritized`, and cli-exec sets a priority whenever fair scheduling is on
    // (default). Scanning `waiting` alone counted zero on a real queue — verified live, where
    // `waiting` did not exist and `prioritized` held 21 jobs — so the gate would never have fired.
    const { source } = fakeQueue({ prioritized: [invoke('holder')] });
    expect(await countWaitingHolderJobs(source, new Set(['holder']))).toBe(1);
  });

  it('scans both queued states, so a fair-scheduling flip cannot blind it', async () => {
    const { source, scanned } = fakeQueue({});
    await countWaitingHolderJobs(source, new Set(['holder']));
    expect(scanned[0]).toEqual([...QUEUED_STATES]);
    expect(QUEUED_STATES).toContain('waiting');
    expect(QUEUED_STATES).toContain('prioritized');
  });

  it('counts only holders, and only cli invocations', async () => {
    const { source } = fakeQueue({
      waiting: [invoke('holder'), invoke('runner-less')],
      prioritized: [
        invoke('holder'),
        // A probe/build/login job on the same queue belongs to no task and never occupies an
        // agent slot the way an invocation does.
        { name: CLI_EXEC_JOB_NAMES.PROBE, data: { providerId: 'p1' } },
      ],
    });
    expect(await countWaitingHolderJobs(source, new Set(['holder']))).toBe(2);
  });

  it('returns 0 when no holder has anything queued', async () => {
    const { source } = fakeQueue({ prioritized: [invoke('runner-less')] });
    expect(await countWaitingHolderJobs(source, new Set(['holder']))).toBe(0);
  });
});
