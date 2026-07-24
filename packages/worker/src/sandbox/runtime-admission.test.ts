import { describe, it, expect } from 'vitest';
import { runtimeAdmissionDecision, parseRunnerTaskIds } from './runtime-admission.js';

describe('runtimeAdmissionDecision', () => {
  it('proceeds when the governor is disabled (max=Infinity), whatever the load', () => {
    expect(runtimeAdmissionDecision(Number.POSITIVE_INFINITY, false, 999)).toBe('proceed');
  });

  it('proceeds when the task already holds a runner, even past the limit', () => {
    // reuse/warm-start needs no new slot, so a task that already owns its runner is never parked.
    expect(runtimeAdmissionDecision(2, true, 5)).toBe('proceed');
  });

  it('proceeds when a slot is free and the task holds no runner', () => {
    expect(runtimeAdmissionDecision(2, false, 0)).toBe('proceed');
    expect(runtimeAdmissionDecision(2, false, 1)).toBe('proceed'); // last free slot
  });

  it('parks when the pool is full and the task holds no runner', () => {
    expect(runtimeAdmissionDecision(2, false, 2)).toBe('park'); // exactly full
    expect(runtimeAdmissionDecision(2, false, 3)).toBe('park'); // already overcommitted
  });

  it('limit 1 admits one and parks the rest', () => {
    expect(runtimeAdmissionDecision(1, false, 0)).toBe('proceed');
    expect(runtimeAdmissionDecision(1, false, 1)).toBe('park');
  });

  it('gives a free slot to the head of the park queue, not to whoever polls first', () => {
    // One slot free (2 - 1). Only position 1 may take it; the tasks behind keep waiting.
    expect(runtimeAdmissionDecision(2, false, 1, 1)).toBe('proceed');
    expect(runtimeAdmissionDecision(2, false, 1, 2)).toBe('park');
    expect(runtimeAdmissionDecision(2, false, 1, 7)).toBe('park');
  });

  it('admits as many queue heads as there are free slots', () => {
    // Empty pool, limit 3: the three oldest parked tasks go, the fourth waits.
    expect(runtimeAdmissionDecision(3, false, 0, 3)).toBe('proceed');
    expect(runtimeAdmissionDecision(3, false, 0, 4)).toBe('park');
  });

  it('parks every position when the pool is full', () => {
    expect(runtimeAdmissionDecision(2, false, 2, 1)).toBe('park');
    expect(runtimeAdmissionDecision(2, false, 3, 1)).toBe('park'); // overcommitted
  });

  it('ignores queue position when the task already holds a runner', () => {
    expect(runtimeAdmissionDecision(2, true, 2, 9)).toBe('proceed');
  });
});

describe('parseRunnerTaskIds', () => {
  it('reads the task id off each runner line', () => {
    expect(parseRunnerTaskIds('task-a|c001\ntask-b|c002\n')).toEqual(['task-a', 'task-b']);
  });

  it('falls back to the container id when a runner carries no task label', () => {
    // Occupancy is a set keyed by task; an unlabeled runner still consumes a machine slot, so
    // it must contribute its own distinct key rather than collapsing with every other unlabeled
    // runner under the empty string.
    expect(parseRunnerTaskIds('|c001\n|c002\n')).toEqual(['container:c001', 'container:c002']);
  });

  it('ignores blank lines and empty output', () => {
    expect(parseRunnerTaskIds('')).toEqual([]);
    expect(parseRunnerTaskIds('\n  \ntask-a|c001\n')).toEqual(['task-a']);
  });
});
