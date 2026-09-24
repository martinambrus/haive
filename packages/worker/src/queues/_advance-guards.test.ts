import { describe, expect, it } from 'vitest';
import {
  blockedByActiveStepMessage,
  failedTaskRefusesAdvance,
  isStaleSubmit,
  staleSubmitAction,
} from './_advance-guards.js';

describe('blockedByActiveStepMessage', () => {
  it('names the step that could not advance and says what unblocks the task', () => {
    const msg = blockedByActiveStepMessage('00a-sync-base');
    expect(msg).toContain('00a-sync-base');
    expect(msg).toContain('finishes or is stopped');
  });
});

describe('isStaleSubmit', () => {
  const parkedAt = new Date('2026-09-24T10:00:00.000Z');
  const reopened = { status: 'waiting_form', formValues: null, waitingStartedAt: parkedAt };
  const before = parkedAt.getTime() - 1;
  const after = parkedAt.getTime() + 1;

  it('drops a submit sent before the form it lands on was parked', () => {
    expect(isStaleSubmit(reopened, true, before)).toBe(true);
  });

  it('keeps a submit sent after the park', () => {
    expect(isStaleSubmit(reopened, true, after)).toBe(false);
  });

  it('keeps a submit whose form the api already released for it', () => {
    // The submit route clears waiting_started_at before it queues the job.
    expect(isStaleSubmit({ ...reopened, waitingStartedAt: null }, true, before)).toBe(false);
  });

  it('only judges a job carrying answers, onto a form holding none', () => {
    expect(isStaleSubmit(reopened, false, before)).toBe(false);
    expect(isStaleSubmit({ ...reopened, formValues: { a: 1 } }, true, before)).toBe(false);
    expect(isStaleSubmit({ ...reopened, status: 'waiting_cli' }, true, before)).toBe(false);
    expect(isStaleSubmit(undefined, true, before)).toBe(false);
    expect(isStaleSubmit(reopened, true, undefined)).toBe(false);
  });
});

describe('staleSubmitAction', () => {
  const parkedAt = new Date('2026-09-24T10:00:00.000Z');
  const parked = { status: 'waiting_form', formValues: null, waitingStartedAt: parkedAt };
  const before = parkedAt.getTime() - 1;

  it('parks the form again when the pass that parked it died before marking the task waiting', () => {
    expect(staleSubmitAction(parked, true, before, 'running')).toBe('repark');
  });

  it('only drops a stale submit on a task already parked, paused or otherwise not running', () => {
    expect(staleSubmitAction(parked, true, before, 'waiting_user')).toBe('drop');
    expect(staleSubmitAction(parked, true, before, 'paused')).toBe('drop');
  });

  it('lets anything that is not a stale submit proceed', () => {
    expect(staleSubmitAction(parked, true, parkedAt.getTime() + 1, 'running')).toBe('proceed');
    expect(staleSubmitAction(parked, false, before, 'running')).toBe('proceed');
  });
});

describe('failedTaskRefusesAdvance', () => {
  it('keeps out an advance on a failed task, whatever the step row says', () => {
    for (const row of ['failed', 'running', 'waiting_cli', 'pending', 'done', undefined]) {
      expect(failedTaskRefusesAdvance('failed', row)).toBe(true);
    }
  });

  it('lets an answer to a form still parked on a failed task through', () => {
    expect(failedTaskRefusesAdvance('failed', 'waiting_form')).toBe(false);
  });

  it('lets any advance through on a task something has reopened', () => {
    for (const task of ['running', 'waiting_user', 'paused', 'queued']) {
      expect(failedTaskRefusesAdvance(task, 'failed')).toBe(false);
    }
  });
});
