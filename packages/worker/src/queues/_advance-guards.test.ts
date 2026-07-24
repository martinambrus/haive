import { describe, expect, it } from 'vitest';
import { TASK_JOB_NAMES } from '@haive/shared';
import {
  blockedByActiveStepMessage,
  findLiveSibling,
  type AdvanceJobRef,
  type AdvanceStepKey,
} from './_advance-guards.js';

const KEY: AdvanceStepKey = {
  jobId: '200',
  taskId: 'task-a',
  stepId: '07b-phase-4-validate',
  round: 1,
  epoch: 15,
};

const job = (id: string, over: Partial<AdvanceJobRef['data']> = {}): AdvanceJobRef => ({
  id,
  name: TASK_JOB_NAMES.ADVANCE_STEP,
  data: { taskId: 'task-a', stepId: '07b-phase-4-validate', round: 1, epoch: 15, ...over },
});

describe('findLiveSibling', () => {
  it('yields to a lower-id sibling this process is running', () => {
    const sibling = job('100');
    expect(findLiveSibling([sibling], new Set(['100']), KEY)).toBe(sibling);
  });

  it('ignores a matching job the process is NOT running (dead worker corpse)', () => {
    // The regression: a killed worker leaves its job in BullMQ `active` holding a 30-minute
    // lock. Treating it as a live sibling froze the step for that whole window.
    expect(findLiveSibling([job('100')], new Set(), KEY)).toBeUndefined();
  });

  it('never matches itself, even when in flight', () => {
    expect(findLiveSibling([job('200')], new Set(['200']), KEY)).toBeUndefined();
  });

  it('does not yield to a HIGHER-id sibling, so only one of two racers stands down', () => {
    expect(findLiveSibling([job('300')], new Set(['300']), KEY)).toBeUndefined();
  });

  it('ignores a different task, step, round or epoch', () => {
    const inFlight = new Set(['100']);
    expect(findLiveSibling([job('100', { taskId: 'task-b' })], inFlight, KEY)).toBeUndefined();
    expect(
      findLiveSibling([job('100', { stepId: '08c-code-review' })], inFlight, KEY),
    ).toBeUndefined();
    expect(findLiveSibling([job('100', { round: 2 })], inFlight, KEY)).toBeUndefined();
    expect(findLiveSibling([job('100', { epoch: 14 })], inFlight, KEY)).toBeUndefined();
  });

  it('ignores jobs of another type on the same queue', () => {
    const other: AdvanceJobRef = { ...job('100'), name: TASK_JOB_NAMES.START };
    expect(findLiveSibling([other], new Set(['100']), KEY)).toBeUndefined();
  });

  it('matches a payload that omits round/epoch against round 0 / no epoch', () => {
    // The api enqueues advance jobs without an epoch (and the worker defaults a missing
    // round to 0), so the guard has to see those as equivalent, not as a different job.
    const bare: AdvanceStepKey = { jobId: '200', taskId: 'task-a', stepId: 's', round: 0 };
    const sibling: AdvanceJobRef = {
      id: '100',
      name: TASK_JOB_NAMES.ADVANCE_STEP,
      data: { taskId: 'task-a', stepId: 's' },
    };
    expect(findLiveSibling([sibling], new Set(['100']), bare)).toBe(sibling);
  });

  it('skips jobs with no id', () => {
    const idless: AdvanceJobRef = { ...job('100'), id: null };
    expect(findLiveSibling([idless], new Set(['100']), KEY)).toBeUndefined();
  });
});

describe('blockedByActiveStepMessage', () => {
  it('names the step that could not advance and says what unblocks the task', () => {
    const msg = blockedByActiveStepMessage('00a-sync-base');
    expect(msg).toContain('00a-sync-base');
    expect(msg).toContain('finishes or is stopped');
  });
});
