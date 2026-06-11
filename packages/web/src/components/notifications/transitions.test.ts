import { describe, expect, it } from 'vitest';
import { detectTransitions, snapshotStatuses } from './transitions';

const task = (
  id: string,
  status: string,
  title = `Task ${id}`,
  currentStepId: string | null = null,
) => ({ id, title, status, currentStepId });

describe('detectTransitions', () => {
  it('first poll surfaces only already-waiting tasks as baseline events', () => {
    const events = detectTransitions(null, [
      task('a', 'waiting_user'),
      task('b', 'failed'),
      task('c', 'completed'),
      task('d', 'running'),
    ]);
    expect(events).toEqual([
      { taskId: 'a', title: 'Task a', status: 'waiting_user', currentStepId: null, baseline: true },
    ]);
  });

  it('fires on transitions into notifiable statuses', () => {
    const prev = new Map([
      ['a', 'running'],
      ['b', 'running'],
      ['c', 'running'],
    ]);
    const events = detectTransitions(prev, [
      task('a', 'waiting_user'),
      task('b', 'failed'),
      task('c', 'completed'),
    ]);
    expect(events.map((e) => `${e.taskId}:${e.status}`)).toEqual([
      'a:waiting_user',
      'b:failed',
      'c:completed',
    ]);
    expect(events.every((e) => !e.baseline)).toBe(true);
  });

  it('does not re-fire while the status is unchanged', () => {
    const prev = new Map([['a', 'waiting_user']]);
    expect(detectTransitions(prev, [task('a', 'waiting_user')])).toEqual([]);
  });

  it('fires again on re-entry (waiting → running → waiting)', () => {
    const prev = new Map([['a', 'running']]);
    expect(detectTransitions(prev, [task('a', 'waiting_user')])).toHaveLength(1);
  });

  it('fires for a task first appearing mid-session in a notifiable status', () => {
    const prev = new Map([['a', 'running']]);
    const events = detectTransitions(prev, [task('a', 'running'), task('new', 'waiting_user')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe('new');
  });

  it('ignores a task appearing in a non-notifiable status', () => {
    const prev = new Map<string, string>();
    expect(detectTransitions(prev, [task('a', 'queued')])).toEqual([]);
  });

  it('never fires for cancelled', () => {
    const prev = new Map([['a', 'running']]);
    expect(detectTransitions(prev, [task('a', 'cancelled')])).toEqual([]);
  });

  it('carries the task payload verbatim', () => {
    const prev = new Map([['a', 'running']]);
    const [event] = detectTransitions(prev, [task('a', 'failed', 'My fix')]);
    expect(event).toEqual({
      taskId: 'a',
      title: 'My fix',
      status: 'failed',
      currentStepId: null,
      baseline: false,
    });
  });

  it('carries currentStepId so each gate keys a distinct episode', () => {
    const prev = new Map([['a', 'running']]);
    const [event] = detectTransitions(prev, [task('a', 'waiting_user', 'Task a', '09-gate-2')]);
    expect(event!.currentStepId).toBe('09-gate-2');
  });
});

describe('snapshotStatuses', () => {
  it('maps ids to statuses and drops disappeared tasks naturally', () => {
    const snap = snapshotStatuses([task('a', 'running'), task('b', 'waiting_user')]);
    expect(snap.get('a')).toBe('running');
    expect(snap.get('b')).toBe('waiting_user');
    expect(snap.size).toBe(2);
  });
});
