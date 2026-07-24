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

  it('bills a PRE-RUN park (pending, no started_at, marker set) as idle', () => {
    // The runtime-slot admission park resets the row to `pending` and stamps
    // waiting_started_at; started_at is null because the run never began. Without this the
    // queue wait counted as neither work nor idle and wall silently stopped reconciling.
    const parked = {
      ...base,
      startedAt: null,
      endedAt: null,
      waitingStartedAt: minAgo(45),
      status: 'pending',
    };
    expect(computeStepContribution(parked, NOW)).toEqual({
      workMs: 0,
      idleMs: 45 * 60_000,
      userActiveMs: 0,
    });
    // Carried across a reset/revise too, rather than being dropped.
    expect(computeFoldContribution(parked, NOW).idleMs).toBe(45 * 60_000);
    // Already-folded park (idle_ms credited, marker cleared) does not double count.
    const folded = { ...parked, idleMs: 45 * 60_000, waitingStartedAt: null };
    expect(computeStepContribution(folded, NOW).idleMs).toBe(45 * 60_000);
  });

  it('counts only the NEWEST open pre-run park in the task total', () => {
    // Two rows parked at once is normal, not a crash artifact: each park enqueues its own
    // delayed re-drive, so a step parked before the task moved on keeps its marker and its own
    // poll loop. Summing both billed 2x idle per second of wall.
    const older = {
      ...base,
      startedAt: null,
      endedAt: null,
      waitingStartedAt: minAgo(30),
      status: 'pending',
    };
    const newer = { ...older, waitingStartedAt: minAgo(10) };
    expect(computeTaskTiming([older, newer], NOW).idleMs).toBe(10 * 60_000);
    // Order must not matter.
    expect(computeTaskTiming([newer, older], NOW).idleMs).toBe(10 * 60_000);
    // Per-step display is unchanged — each card still shows its own wait.
    expect(computeStepContribution(older, NOW).idleMs).toBe(30 * 60_000);
  });

  it('ignores pre-run parks entirely while another step is live', () => {
    // A park's poll chain ends the moment another step becomes active (the advance is skipped
    // and never re-enqueued), so its marker stays open with nothing left to fold it. Counting it
    // would tick idle alongside the working step and bill the same wall clock twice.
    const parked = {
      ...base,
      startedAt: null,
      endedAt: null,
      waitingStartedAt: minAgo(30),
      status: 'pending',
    };
    const working = { ...base, startedAt: minAgo(10), endedAt: null, status: 'running' };
    const t = computeTaskTiming([parked, working], NOW);
    expect(t.idleMs).toBe(0);
    expect(t.workMs).toBe(10 * 60_000);

    // Same for a gate: the user wait is the task's real state, the stale park is not.
    const gate = {
      ...base,
      startedAt: minAgo(50),
      endedAt: null,
      waitingStartedAt: minAgo(20),
      status: 'waiting_form',
    };
    expect(computeTaskTiming([parked, gate], NOW).idleMs).toBe(20 * 60_000);
  });

  it('stops billing a pre-run park once the row is closed', () => {
    // A stale marker on a terminal row (cancel/stop close the row and fold, but a legacy
    // row may not have) must not tick forever.
    const closed = {
      ...base,
      startedAt: null,
      endedAt: minAgo(10),
      waitingStartedAt: minAgo(45),
      status: 'skipped',
    };
    expect(computeStepContribution(closed, NOW).idleMs).toBe(0);
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
