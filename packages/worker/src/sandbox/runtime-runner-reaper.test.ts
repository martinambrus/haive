import { describe, it, expect } from 'vitest';
import { reapDecision } from './runtime-runner-reaper.js';

const GRACE = 180 * 60_000; // RUNTIME_IDLE_REAP_MINUTES default: 180 min
const NOW = Date.parse('2026-07-22T18:30:00Z');
const ago = (ms: number) => new Date(NOW - ms);

/** A running runner container whose own start time is recent. */
const freshRunner = { running: true, taskId: 't1', startedAtMs: NOW - 20 * 60_000 };

describe('reapDecision', () => {
  it('reaps a long-failed task even when its runner was just rebooted (the slot-squat bug)', () => {
    // The real incident: task failed 14:56, a stray runtime-ensure cold-booted a fresh
    // runner at 18:07. Anchoring the grace to the CONTAINER start re-armed a full 3h hold
    // on one of only two runtime slots. It must anchor to the task's failure time.
    const task = { status: 'failed', completedAt: ago(3.5 * 60 * 60_000) };
    expect(reapDecision(freshRunner, task, GRACE, NOW)).toBe('failed-grace');
  });

  it('keeps a recently-failed task’s runner even when the container is old', () => {
    const task = { status: 'failed', completedAt: ago(10 * 60_000) };
    const oldRunner = { running: true, taskId: 't1', startedAtMs: NOW - 5 * 60 * 60_000 };
    expect(reapDecision(oldRunner, task, GRACE, NOW)).toBe(null);
  });

  it('falls back to the container start when the failure time is unknown', () => {
    const task = { status: 'failed', completedAt: null };
    const old = { running: true, taskId: 't1', startedAtMs: NOW - 4 * 60 * 60_000 };
    expect(reapDecision(old, task, GRACE, NOW)).toBe('failed-grace');
    expect(reapDecision(freshRunner, task, GRACE, NOW)).toBe(null);
  });

  it('keeps a failed task’s runner when the grace is disabled (0)', () => {
    const task = { status: 'failed', completedAt: ago(99 * 60 * 60_000) };
    expect(reapDecision(freshRunner, task, 0, NOW)).toBe(null);
  });

  it.each(['completed', 'cancelled'])('reaps a %s task immediately', (status) => {
    expect(reapDecision(freshRunner, { status, completedAt: ago(1000) }, GRACE, NOW)).toBe(
      'terminal',
    );
  });

  it.each(['running', 'paused', 'waiting_user', 'queued'])('never touches a %s task', (status) => {
    expect(reapDecision(freshRunner, { status, completedAt: null }, GRACE, NOW)).toBe(null);
  });

  it('reaps a non-running container regardless of task status', () => {
    const stopped = { running: false, taskId: 't1', startedAtMs: NOW };
    expect(reapDecision(stopped, { status: 'running', completedAt: null }, GRACE, NOW)).toBe(
      'exited',
    );
  });

  it('reaps an unlabelled runner and one whose task row is gone', () => {
    expect(
      reapDecision({ running: true, taskId: null, startedAtMs: NOW }, undefined, GRACE, NOW),
    ).toBe('orphan');
    expect(reapDecision(freshRunner, undefined, GRACE, NOW)).toBe('orphan');
  });
});
