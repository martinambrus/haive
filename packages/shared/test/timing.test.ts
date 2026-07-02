import { describe, expect, it } from 'vitest';
import { computeTaskTiming, type TaskTimingStep } from '../src/step-engine/timing.js';

// Fixed clock so the tests are deterministic (no argless Date usage).
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;
/** A Date `m` minutes after BASE. */
const at = (m: number): Date => new Date(BASE + m * MIN);
/** The `nowMs` epoch `m` minutes after BASE. */
const now = (m: number): number => BASE + m * MIN;

/** Fill a step fixture; override only what a case needs. */
function step(overrides: Partial<TaskTimingStep>): TaskTimingStep {
  return {
    startedAt: at(0),
    endedAt: null,
    idleMs: 0,
    userActiveMs: 0,
    waitingStartedAt: null,
    status: 'running',
    ...overrides,
  };
}

describe('computeTaskTiming', () => {
  it('bills a parked waiting_cli step (waitingStartedAt set) as idle, not work', () => {
    // Step ran, then parked at t=10 (last invocation ended, none running) — the allowance-park
    // shape. At t=100 the 90-min park must be idle; only the first 10 min is work.
    const t = computeTaskTiming(
      [step({ status: 'waiting_cli', waitingStartedAt: at(10) })],
      now(100),
    );
    expect(t.workMs).toBe(10 * MIN);
    expect(t.idleMs).toBe(90 * MIN);
    expect(t.userActiveMs).toBe(0);
  });

  it('bills an actively-running waiting_cli step (waitingStartedAt null) as work', () => {
    // Invariant guard: while an invocation runs the worker keeps waitingStartedAt null, so the
    // span still counts as work — the fix must NOT zero out live agent work.
    const t = computeTaskTiming([step({ status: 'waiting_cli', waitingStartedAt: null })], now(20));
    expect(t.workMs).toBe(20 * MIN);
    expect(t.idleMs).toBe(0);
  });

  it('still excludes a waiting_form open wait (unchanged behaviour)', () => {
    const t = computeTaskTiming(
      [step({ status: 'waiting_form', waitingStartedAt: at(5) })],
      now(30),
    );
    expect(t.workMs).toBe(5 * MIN);
    expect(t.idleMs).toBe(25 * MIN);
  });

  it('does not apply an open wait once the step has ended (lingering marker is harmless)', () => {
    // A finished step may carry a stale waitingStartedAt; openWait requires ended === null, so
    // a done step's stored span is billed verbatim as work.
    const t = computeTaskTiming(
      [step({ status: 'done', endedAt: at(30), waitingStartedAt: at(10) })],
      now(100),
    );
    expect(t.workMs).toBe(30 * MIN);
    expect(t.idleMs).toBe(0);
  });

  it('trusts a done step endedAt (timing does not re-derive it)', () => {
    // Documents that Slice 1 prevents the bad endedAt *write*; the read here faithfully
    // reflects whatever span the row stores.
    const t = computeTaskTiming([step({ status: 'done', endedAt: at(120) })], now(200));
    expect(t.workMs).toBe(120 * MIN);
  });

  it('skips a step with no startedAt but still counts its idle/userActive', () => {
    const t = computeTaskTiming(
      [step({ startedAt: null, status: 'pending', idleMs: 1000, userActiveMs: 500 })],
      now(10),
    );
    expect(t.workMs).toBe(0);
    expect(t.idleMs).toBe(1000);
    expect(t.userActiveMs).toBe(500);
  });

  it('sums work and idle across a parked CLI step and a done step', () => {
    const t = computeTaskTiming(
      [
        step({ status: 'waiting_cli', waitingStartedAt: at(10) }),
        step({ status: 'done', endedAt: at(120) }),
      ],
      now(200),
    );
    expect(t.workMs).toBe(130 * MIN); // 10 (pre-park) + 120 (done)
    expect(t.idleMs).toBe(190 * MIN); // 200 - 10 park
  });
});
