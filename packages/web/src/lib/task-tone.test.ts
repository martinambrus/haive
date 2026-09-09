import { describe, expect, it } from 'vitest';
import { TASK_TONE_FILTERS, filterTasksByTone, isTaskToneFilter, taskTone } from './task-tone';

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
