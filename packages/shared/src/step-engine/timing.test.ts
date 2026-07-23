import { describe, it, expect } from 'vitest';
import { computeStepContribution, computeFoldContribution } from './timing.js';

const NOW = Date.parse('2026-07-23T12:00:00Z');
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const base = {
  idleMs: 0,
  userActiveMs: 0,
  waitingStartedAt: null,
  carriedWorkMs: 0,
  carriedIdleMs: 0,
  carriedUserActiveMs: 0,
};

describe('computeFoldContribution', () => {
  it('reclassifies an OPEN running step’s span as idle, not work (orphan-fold guard)', () => {
    // A step left `running` with no ended_at after a worker restart orphaned it:
    // computeStepContribution bills the whole start->now gap as work; the fold must not
    // carry that dead span as work (this is the 157h-of-"work" bug).
    const step = { ...base, startedAt: minAgo(100 * 60), endedAt: null, status: 'running' };
    const read = computeStepContribution(step, NOW);
    expect(read.workMs).toBeGreaterThan(99 * 3_600_000); // read path DOES bill it as work
    const fold = computeFoldContribution(step, NOW);
    expect(fold.workMs).toBe(0);
    expect(fold.idleMs).toBe(read.workMs + read.idleMs); // the span moved to idle
  });

  it('is identical to the read path for a CLOSED (done) step', () => {
    const step = {
      ...base,
      startedAt: minAgo(60),
      endedAt: minAgo(30),
      idleMs: 5 * 60_000,
      status: 'done',
    };
    expect(computeFoldContribution(step, NOW)).toEqual(computeStepContribution(step, NOW, false));
  });

  it('folds no work for a pending step with no started_at', () => {
    const step = { ...base, startedAt: null, endedAt: null, status: 'pending' };
    expect(computeFoldContribution(step, NOW)).toEqual({ workMs: 0, idleMs: 0, userActiveMs: 0 });
  });

  it('keeps foldSit semantics for a failed step (ended set) — its span still bills as work', () => {
    const step = { ...base, startedAt: minAgo(60), endedAt: minAgo(40), status: 'failed' };
    const fold = computeFoldContribution(step, NOW);
    // ended is set => not "open" => the ~20 min run still counts as work; the 40 min
    // fail->now dead-wait is folded to idle by foldSit.
    expect(fold.workMs).toBeGreaterThan(19 * 60_000);
    expect(fold.idleMs).toBeGreaterThan(39 * 60_000);
  });
});
