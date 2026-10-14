import { describe, expect, it } from 'vitest';
import { taskBadgeKind, taskMenuKeys, taskStatusWord } from './task-state';

const DEAD_AT = '2026-10-14T10:00:00.000Z';
const PAUSED_AT = '2026-10-14T09:00:00.000Z';
const SLOT = { kind: 'runtime' };
const LIVE_STATUSES = ['created', 'queued', 'running', 'waiting_user', 'waiting_pr', 'failed'];
const COPY_ONLY = {
  status: 'running',
  deadAt: null,
  deadReason: 'the run list names a step this install does not register: module.x.y',
};

describe('taskBadgeKind', () => {
  it('shows the status itself for a plain task', () => {
    expect(taskBadgeKind({ status: 'running' })).toBe('status');
    expect(taskBadgeKind({ status: 'waiting_user' })).toBe('status');
  });

  it('shows a slot wait ahead of the status', () => {
    expect(taskBadgeKind({ status: 'running', slotWait: SLOT })).toBe('slotWait');
  });

  it('shows paused ahead of a slot wait', () => {
    expect(taskBadgeKind({ status: 'running', pausedAt: PAUSED_AT, slotWait: SLOT })).toBe(
      'paused',
    );
  });

  it('shows dead ahead of paused, a slot wait and the status, whatever status it died in', () => {
    for (const status of LIVE_STATUSES) {
      expect(taskBadgeKind({ status, deadAt: DEAD_AT })).toBe('dead');
      expect(taskBadgeKind({ status, deadAt: DEAD_AT, pausedAt: PAUSED_AT, slotWait: SLOT })).toBe(
        'dead',
      );
    }
  });

  it('shows finished ahead of everything, a dead_at left on the row included', () => {
    for (const status of ['cancelled', 'completed']) {
      expect(taskBadgeKind({ status })).toBe('finished');
      expect(taskBadgeKind({ status, deadAt: DEAD_AT, pausedAt: PAUSED_AT, slotWait: SLOT })).toBe(
        'finished',
      );
    }
  });

  it('keys on dead_at and never on a dead_reason that outlived it', () => {
    // NEGATIVE CONTROL: a version keyed on dead_reason badges this running task dead.
    expect(taskBadgeKind(COPY_ONLY)).toBe('status');
  });
});

describe('taskMenuKeys', () => {
  const idle = { stepRunning: false };

  it('offers Cancel and nothing else for a dead task', () => {
    for (const status of LIVE_STATUSES) {
      expect(taskMenuKeys({ status, deadAt: DEAD_AT }, idle)).toEqual(['cancel']);
    }
  });

  it('offers no Start, Retry, Resume, Pause or Stop on a dead task', () => {
    expect(taskMenuKeys({ status: 'created', deadAt: DEAD_AT }, idle)).toEqual(['cancel']);
    expect(taskMenuKeys({ status: 'failed', deadAt: DEAD_AT }, idle)).toEqual(['cancel']);
    expect(taskMenuKeys({ status: 'running', deadAt: DEAD_AT, pausedAt: PAUSED_AT }, idle)).toEqual(
      ['cancel'],
    );
    expect(taskMenuKeys({ status: 'running', deadAt: DEAD_AT }, { stepRunning: true })).toEqual([
      'cancel',
    ]);
  });

  it('keeps every action for a task whose dead_reason outlived its dead_at', () => {
    // NEGATIVE CONTROL: a version keyed on dead_reason strips the menu of a live task.
    expect(taskMenuKeys(COPY_ONLY, idle)).toEqual(['pause', 'cancel']);
  });

  it('offers Start only to a task that was created and never started', () => {
    expect(taskMenuKeys({ status: 'created' }, idle)).toEqual(['start', 'pause', 'cancel']);
  });

  it('offers Retry to a failed task', () => {
    expect(taskMenuKeys({ status: 'failed' }, idle)).toEqual(['retry', 'pause', 'cancel']);
  });

  it('offers Pause, or Resume while paused, and Cancel to a running task', () => {
    expect(taskMenuKeys({ status: 'running' }, idle)).toEqual(['pause', 'cancel']);
    expect(taskMenuKeys({ status: 'running', pausedAt: PAUSED_AT }, idle)).toEqual([
      'resume',
      'cancel',
    ]);
  });

  it('offers Stop between Pause and Cancel while a CLI step runs', () => {
    expect(taskMenuKeys({ status: 'running' }, { stepRunning: true })).toEqual([
      'pause',
      'stop',
      'cancel',
    ]);
  });

  it('offers nothing to a finished task, a dead_at left on the row included', () => {
    for (const status of ['cancelled', 'completed']) {
      expect(taskMenuKeys({ status }, idle)).toEqual([]);
      expect(taskMenuKeys({ status, deadAt: DEAD_AT }, idle)).toEqual([]);
    }
  });
});

describe('taskStatusWord', () => {
  it('says dead for a dead task, not the status it died in', () => {
    for (const status of LIVE_STATUSES) {
      expect(taskStatusWord({ status, deadAt: DEAD_AT })).toBe('dead');
    }
  });

  it('says the status for everything else', () => {
    expect(taskStatusWord({ status: 'waiting_user' })).toBe('waiting_user');
    expect(taskStatusWord({ status: 'cancelled', deadAt: DEAD_AT })).toBe('cancelled');
    expect(taskStatusWord({ status: 'completed', deadAt: DEAD_AT })).toBe('completed');
  });

  it('keys on dead_at and never on a dead_reason that outlived it', () => {
    expect(taskStatusWord(COPY_ONLY)).toBe('running');
  });
});
