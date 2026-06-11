import { describe, expect, it } from 'vitest';
import { detectTransitions, snapshotIdentities } from './transitions';

const task = (
  id: string,
  status: string,
  title = `Task ${id}`,
  currentStepId: string | null = null,
  updatedAt = 't0',
) => ({ id, title, status, currentStepId, updatedAt });

describe('detectTransitions', () => {
  it('first poll surfaces only already-waiting tasks as baseline events', () => {
    const events = detectTransitions(null, [
      task('a', 'waiting_user'),
      task('b', 'failed'),
      task('c', 'completed'),
      task('d', 'running'),
    ]);
    expect(events).toEqual([
      {
        taskId: 'a',
        title: 'Task a',
        status: 'waiting_user',
        currentStepId: null,
        updatedAt: 't0',
        baseline: true,
      },
    ]);
  });

  it('fires on transitions into notifiable statuses', () => {
    const prev = snapshotIdentities([
      task('a', 'running'),
      task('b', 'running'),
      task('c', 'running'),
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

  it('does not re-fire while the status and step are unchanged', () => {
    const prev = snapshotIdentities([task('a', 'waiting_user')]);
    expect(detectTransitions(prev, [task('a', 'waiting_user')])).toEqual([]);
  });

  it('fires again on re-entry (waiting → running → waiting)', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    expect(detectTransitions(prev, [task('a', 'waiting_user')])).toHaveLength(1);
  });

  it('fires when the step advances while the status stays waiting_user', () => {
    // Two consecutive gates: the intervening `running` window was shorter than
    // the poll interval, so the poller sees waiting_user → waiting_user. The
    // step change must still surface the second gate.
    const prev = snapshotIdentities([task('a', 'waiting_user', 'Task a', '04-tooling')]);
    const events = detectTransitions(prev, [task('a', 'waiting_user', 'Task a', '05-next')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.currentStepId).toBe('05-next');
  });

  it('does not re-fire when only updatedAt changes (same gate, unrelated edit)', () => {
    // A rename / autoContinue toggle bumps updatedAt but the task is parked on
    // the same gate — it must not re-notify.
    const prev = snapshotIdentities([task('a', 'waiting_user', 'Task a', '04-tooling', 't0')]);
    const events = detectTransitions(prev, [
      task('a', 'waiting_user', 'Task a', '04-tooling', 't1'),
    ]);
    expect(events).toEqual([]);
  });

  it('fires for a task first appearing mid-session in a notifiable status', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    const events = detectTransitions(prev, [task('a', 'running'), task('new', 'waiting_user')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe('new');
  });

  it('ignores a task appearing in a non-notifiable status', () => {
    const prev = new Map<string, string>();
    expect(detectTransitions(prev, [task('a', 'queued')])).toEqual([]);
  });

  it('never fires for cancelled', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    expect(detectTransitions(prev, [task('a', 'cancelled')])).toEqual([]);
  });

  it('carries the task payload verbatim', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    const [event] = detectTransitions(prev, [task('a', 'failed', 'My fix')]);
    expect(event).toEqual({
      taskId: 'a',
      title: 'My fix',
      status: 'failed',
      currentStepId: null,
      updatedAt: 't0',
      baseline: false,
    });
  });

  it('carries currentStepId so each gate keys a distinct episode', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    const [event] = detectTransitions(prev, [task('a', 'waiting_user', 'Task a', '09-gate-2')]);
    expect(event!.currentStepId).toBe('09-gate-2');
  });

  it('carries updatedAt so the provider can key a wait occurrence', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    const [event] = detectTransitions(prev, [task('a', 'waiting_user', 'Task a', 'g', 't9')]);
    expect(event!.updatedAt).toBe('t9');
  });
});

describe('snapshotIdentities', () => {
  it('keys each task by status+step so a step change is a new identity', () => {
    const a = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-1')]);
    const b = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-2')]);
    expect(a.get('a')).not.toBe(b.get('a'));
  });

  it('is stable when status and step are unchanged regardless of updatedAt', () => {
    const a = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-1', 't0')]);
    const b = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-1', 't1')]);
    expect(a.get('a')).toBe(b.get('a'));
  });

  it('drops disappeared tasks naturally', () => {
    const snap = snapshotIdentities([task('a', 'running'), task('b', 'waiting_user')]);
    expect(snap.size).toBe(2);
    expect(snap.has('a')).toBe(true);
    expect(snap.has('b')).toBe(true);
  });
});
