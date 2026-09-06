import { describe, it, expect } from 'vitest';
import { agentLaneRank } from './handlers.js';

// Pure ordering + finalized-exclusion for the agent-lane gate. The queue read and the db read
// that feed it are left untested by design (no bullmq/db mocking in this package — the rule
// ddev-runner.test.ts and _browser-access.test.ts already follow).

const job = (id: string, priority: number, invocationId: string) => ({
  id,
  priority,
  invocationId,
});
const NONE: ReadonlySet<string> = new Set();

describe('agentLaneRank', () => {
  it('ranks by priority, then by job id', () => {
    // Enqueue order is the tie-break, so equal-priority jobs keep the order they arrived in.
    const active = [job('12', 5, 'c'), job('10', 5, 'a'), job('11', 1, 'b')];
    expect(agentLaneRank(active, '11', NONE)).toBe(0); // best priority wins
    expect(agentLaneRank(active, '10', NONE)).toBe(1);
    expect(agentLaneRank(active, '12', NONE)).toBe(2);
  });

  it('returns -1 for a job that is not in the active set', () => {
    // The caller reads this as "allow", rather than guessing a position it does not have.
    expect(agentLaneRank([job('10', 0, 'a')], '99', NONE)).toBe(-1);
  });

  // The defect this exclusion exists for: a worker killed mid-job leaves its job in `active`
  // holding a 30-minute lock, and ranking against those corpses hands them agent slots they
  // will never use. OBSERVED on a 16 GB host with a measured pool of 2 — two orphans held both
  // slots and every real job logged "agent pool full" every 30s while no agent container ran.
  it('excludes finalized invocations so a live job takes the freed slot', () => {
    const active = [job('10', 0, 'dead-1'), job('11', 0, 'dead-2'), job('12', 0, 'live')];
    expect(agentLaneRank(active, '12', NONE)).toBe(2); // would defer against a cap of 2
    expect(agentLaneRank(active, '12', new Set(['dead-1', 'dead-2']))).toBe(0); // now admitted
  });

  it('excludes the evaluated job itself when its own invocation is finalized', () => {
    // -1 lets it through the gate to handleCliExecJob, whose redelivery guard skips it — better
    // than deferring a job that has no work to do every 30 seconds.
    const active = [job('10', 0, 'live'), job('11', 0, 'dead')];
    expect(agentLaneRank(active, '11', new Set(['dead']))).toBe(-1);
  });

  it('is unchanged from the pre-exclusion ranking when nothing is finalized', () => {
    const active = [job('10', 0, 'a'), job('11', 0, 'b'), job('12', 0, 'c')];
    const ranks = active.map((j) => agentLaneRank(active, j.id, NONE));
    expect(ranks).toEqual([0, 1, 2]);
  });

  it('handles an empty active set', () => {
    expect(agentLaneRank([], '10', NONE)).toBe(-1);
  });
});
