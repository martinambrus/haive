import { describe, it, expect } from 'vitest';
import { boostersOver, preemptionDecision, type RunningAgent } from './agent-preemption.js';

const NOW = 1_800_000_000_000;
const MIN_AGE = 5 * 60_000;

function agent(over: Partial<RunningAgent> = {}): RunningAgent {
  return {
    invocationId: 'inv-1',
    taskId: 'task-1',
    voteScore: 0,
    startedAtMs: NOW - 30 * 60_000, // half an hour in, well past the guard
    ...over,
  };
}

function decide(over: {
  enabled?: boolean;
  queuedScores?: number[];
  running?: RunningAgent[];
  minRunAgeMs?: number;
}) {
  return preemptionDecision({
    enabled: over.enabled ?? true,
    queuedScores: over.queuedScores ?? [2],
    running: over.running ?? [agent()],
    minRunAgeMs: over.minRunAgeMs ?? MIN_AGE,
    nowMs: NOW,
  });
}

describe('preemptionDecision', () => {
  it('evicts a lower-scored running agent for queued higher-scored work', () => {
    expect(decide({})?.invocationId).toBe('inv-1');
  });

  it('does nothing when the switch is off', () => {
    expect(decide({ enabled: false })).toBeNull();
  });

  it('does nothing with no queued demand', () => {
    expect(decide({ queuedScores: [] })).toBeNull();
  });

  it('does nothing with nothing running', () => {
    expect(decide({ running: [] })).toBeNull();
  });

  it('never evicts on an EQUAL score — ties stay first-come', () => {
    expect(decide({ queuedScores: [2], running: [agent({ voteScore: 2 })] })).toBeNull();
  });

  it('never evicts for a LOWER-scored queued task', () => {
    expect(decide({ queuedScores: [0], running: [agent({ voteScore: 2 })] })).toBeNull();
  });

  it('spares a run younger than the guard', () => {
    const young = agent({ startedAtMs: NOW - 60_000 });
    expect(decide({ running: [young] })).toBeNull();
  });

  it('a zero guard preempts immediately', () => {
    const young = agent({ startedAtMs: NOW - 1_000 });
    expect(decide({ running: [young], minRunAgeMs: 0 })?.invocationId).toBe('inv-1');
  });

  it('picks the LOWEST-scored eligible victim', () => {
    const pick = decide({
      queuedScores: [3],
      running: [
        agent({ invocationId: 'a', voteScore: 2 }),
        agent({ invocationId: 'b', voteScore: -1 }),
        agent({ invocationId: 'c', voteScore: 1 }),
      ],
    });
    expect(pick?.invocationId).toBe('b');
  });

  it('breaks a score tie toward the YOUNGEST run — the least work destroyed', () => {
    const pick = decide({
      running: [
        agent({ invocationId: 'old', startedAtMs: NOW - 60 * 60_000 }),
        agent({ invocationId: 'young', startedAtMs: NOW - 6 * 60_000 }),
      ],
    });
    expect(pick?.invocationId).toBe('young');
  });

  it('ignores an ineligible victim even when it is the lowest-scored', () => {
    // The -5 agent is the obvious target but only just started; the eligible +1 is taken instead.
    const pick = decide({
      queuedScores: [3],
      running: [
        agent({ invocationId: 'just-started', voteScore: -5, startedAtMs: NOW - 1_000 }),
        agent({ invocationId: 'eligible', voteScore: 1 }),
      ],
    });
    expect(pick?.invocationId).toBe('eligible');
  });

  it('uses the BEST queued score, not the first', () => {
    expect(decide({ queuedScores: [-1, 0, 4], running: [agent({ voteScore: 2 })] })).not.toBeNull();
    expect(decide({ queuedScores: [-1, 0, 1], running: [agent({ voteScore: 2 })] })).toBeNull();
  });
});

describe('boostersOver', () => {
  const scores = new Map([
    ['a', 2],
    ['b', 0],
    ['c', -1],
  ]);
  const queued = new Set(['a', 'b', 'c', 'd']);

  it('keeps only the queued tasks that STRICTLY outscore the victim', () => {
    expect(boostersOver(queued, scores, 0).map((c) => c.taskId)).toEqual(['a']);
  });

  it('treats a queued task with no score row as 0, not as excluded', () => {
    // 'd' is queued but absent from the map. An unvoted task is neutral, and at victim -1 a
    // neutral task IS a booster — dropping it would make the reserve pre-check miss real demand.
    const ids = boostersOver(queued, scores, -1)
      .map((c) => c.taskId)
      .sort();
    expect(ids).toEqual(['a', 'b', 'd']);
  });

  it('is empty when nothing outranks the victim, so no eviction is considered at all', () => {
    expect(boostersOver(queued, scores, 2)).toEqual([]);
  });
});
