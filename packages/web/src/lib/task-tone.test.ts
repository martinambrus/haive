import { describe, expect, it } from 'vitest';
import {
  TASK_TONE_FILTERS,
  filterTasksByTone,
  isTaskToneFilter,
  taskTone,
  taskToneLabel,
} from './task-tone';

const DEAD_AT = '2026-10-14T10:00:00.000Z';

describe('taskTone', () => {
  it('colours a plain running task green', () => {
    expect(taskTone({ status: 'running' })).toBe('running');
  });

  it('colours both gate states amber', () => {
    expect(taskTone({ status: 'waiting_user' })).toBe('waiting');
    expect(taskTone({ status: 'waiting_pr' })).toBe('waiting');
  });

  it('colours a failed task red', () => {
    expect(taskTone({ status: 'failed' })).toBe('failed');
  });

  // The two cases the tone exists for: `status` says running and nothing is.
  it('reads a user-paused task as waiting, not running', () => {
    expect(taskTone({ status: 'running', pausedAt: '2026-09-09T10:00:00Z' })).toBe('waiting');
  });

  it('reads a slot-parked task as waiting, not running', () => {
    expect(taskTone({ status: 'running', slotWait: { kind: 'runtime' } })).toBe('waiting');
  });

  it('keeps failed ahead of a stale pause stamp', () => {
    expect(taskTone({ status: 'failed', pausedAt: '2026-09-09T10:00:00Z' })).toBe('failed');
  });

  it('leaves not-yet-started tasks uncoloured', () => {
    expect(taskTone({ status: 'created' })).toBe('idle');
    expect(taskTone({ status: 'queued' })).toBe('idle');
  });

  // The case the tone exists for here: a dead task keeps the status it died in, so `status`
  // alone paints it as running, waiting or idle while nothing will ever advance it.
  it('reads a dead task as failed, whatever status it died in', () => {
    for (const status of ['created', 'queued', 'running', 'waiting_user', 'waiting_pr', 'failed']) {
      expect(taskTone({ status, deadAt: DEAD_AT })).toBe('failed');
    }
  });

  it('puts dead ahead of a pause or a slot wait', () => {
    expect(taskTone({ status: 'running', deadAt: DEAD_AT, pausedAt: '2026-09-09T10:00:00Z' })).toBe(
      'failed',
    );
    expect(taskTone({ status: 'running', deadAt: DEAD_AT, slotWait: { kind: 'agent' } })).toBe(
      'failed',
    );
  });

  it('does not colour a cancelled or completed task for a dead_at it still carries', () => {
    expect(taskTone({ status: 'cancelled', deadAt: DEAD_AT })).toBe('idle');
    expect(taskTone({ status: 'completed', deadAt: DEAD_AT })).toBe('idle');
  });

  it('keys on dead_at and never on a dead_reason that outlived it', () => {
    // NEGATIVE CONTROL: a version keyed on dead_reason paints this running task red.
    const copyOnly = {
      status: 'running',
      deadAt: null,
      deadReason: 'the run list names a step this install does not register: module.x.y',
    };
    expect(taskTone(copyOnly)).toBe('running');
  });
});

describe('taskToneLabel', () => {
  it('names a dead task dead, not the failed its tone borrows', () => {
    expect(taskToneLabel({ status: 'waiting_user', deadAt: DEAD_AT })).toBe('dead');
    expect(taskToneLabel({ status: 'running', deadAt: DEAD_AT })).toBe('dead');
  });

  it('uses the tone word for every other task', () => {
    expect(taskToneLabel({ status: 'running' })).toBe('running');
    expect(taskToneLabel({ status: 'waiting_user' })).toBe('waiting');
    expect(taskToneLabel({ status: 'failed' })).toBe('failed');
    expect(taskToneLabel({ status: 'created' })).toBe('queued');
  });

  it('does not call a cancelled or completed task dead for a dead_at it still carries', () => {
    expect(taskToneLabel({ status: 'cancelled', deadAt: DEAD_AT })).not.toBe('dead');
    expect(taskToneLabel({ status: 'completed', deadAt: DEAD_AT })).not.toBe('dead');
  });
});

describe('filterTasksByTone', () => {
  const tasks = [
    { id: 'run', status: 'running' },
    { id: 'wait', status: 'waiting_user' },
    { id: 'fail', status: 'failed' },
    { id: 'queued', status: 'queued' },
    { id: 'paused', status: 'running', pausedAt: '2026-09-09T10:00:00Z' },
  ];
  const ids = (sel: Parameters<typeof filterTasksByTone>[1]) =>
    filterTasksByTone(tasks, sel).map((t) => (t as { id: string }).id);

  // The whole reason the group can be switched off: no selection is not "match nothing".
  it('returns everything when nothing is selected', () => {
    expect(ids([])).toEqual(['run', 'wait', 'fail', 'queued', 'paused']);
  });

  it('selects one tone', () => {
    expect(ids(['failed'])).toEqual(['fail']);
  });

  it('combines tones', () => {
    expect(ids(['running', 'failed'])).toEqual(['run', 'fail']);
  });

  // A paused task reports status 'running'; the filter must agree with the row tint.
  it('matches on the tone, not the raw status', () => {
    expect(ids(['waiting'])).toEqual(['wait', 'paused']);
    expect(ids(['running'])).toEqual(['run']);
  });

  // `idle` has no button, so a filtered view never contains a not-yet-started task.
  it('drops idle tasks whenever any filter is on', () => {
    for (const tone of TASK_TONE_FILTERS) expect(ids([tone])).not.toContain('queued');
  });

  it('files a dead task under failed, not under the status it died in', () => {
    const withDead = [...tasks, { id: 'dead', status: 'running', deadAt: DEAD_AT }];
    const idsOf = (sel: Parameters<typeof filterTasksByTone>[1]) =>
      filterTasksByTone(withDead, sel).map((t) => (t as { id: string }).id);
    expect(idsOf(['failed'])).toEqual(['fail', 'dead']);
    expect(idsOf(['running'])).toEqual(['run']);
  });
});

describe('isTaskToneFilter', () => {
  it('accepts the three filterable tones and rejects anything else', () => {
    expect(TASK_TONE_FILTERS.every(isTaskToneFilter)).toBe(true);
    // `idle` is a real tone but not a filter, so a stored blob naming it is discarded.
    expect(isTaskToneFilter('idle')).toBe(false);
    expect(isTaskToneFilter(null)).toBe(false);
    expect(isTaskToneFilter(3)).toBe(false);
  });
});
