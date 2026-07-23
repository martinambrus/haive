import { describe, it, expect } from 'vitest';
import { computeStepContribution, computeFoldContribution, computeTaskTiming } from './timing.js';

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

  it('nowMs is the task’s EFFECTIVE now: capping at completedAt bounds an open step', () => {
    // A step left open by a cancel/crash (ended_at never stamped) bills start->nowMs as work.
    // Evaluating a TERMINAL task at the live wall clock therefore grows its "work" on every
    // poll — one row read 670h against a 1.78h wall. Callers hold the task row and must pass
    // `completedAt ?? Date.now()`; this pins that the cap is what bounds it.
    const step = { ...base, startedAt: minAgo(600), endedAt: null, status: 'waiting_cli' };
    const completedAt = NOW - 570 * 60_000; // task ended 30 min after the step started

    const capped = computeTaskTiming([step], completedAt);
    expect(capped.workMs).toBe(30 * 60_000);

    const uncapped = computeTaskTiming([step], NOW);
    expect(uncapped.workMs).toBe(600 * 60_000);
    expect(uncapped.workMs).toBeGreaterThan(capped.workMs);
  });

  it('a closed step with an unfolded park marker bills the park as WORK (why cancel/stop fold)', () => {
    // openWait is counted ONLY while ended_at is null. So stamping ended_at over a live
    // waiting_started_at silently reclassifies the whole recorded park from idle back into
    // work. That is why cancelTaskRow / the stop path fold the marker into idle_ms in the SAME
    // statement that closes the row, rather than leaving it for the read path.
    const parked = {
      ...base,
      startedAt: minAgo(200),
      endedAt: null,
      waitingStartedAt: minAgo(180),
      status: 'waiting_cli',
    };
    expect(computeStepContribution(parked, NOW).idleMs).toBe(180 * 60_000);

    // Same row, now closed without folding the marker: the 180 min flips to work.
    const closedUnfolded = { ...parked, endedAt: minAgo(0), status: 'failed' };
    expect(computeStepContribution(closedUnfolded, NOW).workMs).toBe(200 * 60_000);
    expect(computeStepContribution(closedUnfolded, NOW).idleMs).toBe(0);

    // Folded on close (idle_ms credited, marker cleared) — the park stays idle.
    const closedFolded = {
      ...closedUnfolded,
      idleMs: 180 * 60_000,
      waitingStartedAt: null,
    };
    expect(computeStepContribution(closedFolded, NOW).workMs).toBe(20 * 60_000);
    expect(computeStepContribution(closedFolded, NOW).idleMs).toBe(180 * 60_000);
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
