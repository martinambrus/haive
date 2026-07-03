import { describe, expect, it } from 'vitest';
import {
  detectTransitions,
  snapshotIdentities,
  detectAllowanceReplenished,
  snapshotAllowance,
} from './transitions';

const task = (
  id: string,
  status: string,
  title = `Task ${id}`,
  currentStepId: string | null = null,
  currentWaitStartedAt: string | null = 't0',
) => ({ id, title, status, currentStepId, currentWaitStartedAt });

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
        currentWaitStartedAt: 't0',
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

  it('does not re-fire while status, step and wait are unchanged', () => {
    const prev = snapshotIdentities([task('a', 'waiting_user')]);
    expect(detectTransitions(prev, [task('a', 'waiting_user')])).toEqual([]);
  });

  it('fires again on re-entry (waiting → running → waiting)', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    expect(detectTransitions(prev, [task('a', 'waiting_user')])).toHaveLength(1);
  });

  it('fires when the step advances while the status stays waiting_user', () => {
    const prev = snapshotIdentities([task('a', 'waiting_user', 'Task a', '04-tooling')]);
    const events = detectTransitions(prev, [task('a', 'waiting_user', 'Task a', '05-next')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.currentStepId).toBe('05-next');
  });

  it('fires when a restart re-enters the SAME gate (fresh wait occurrence)', () => {
    // Background-tab throttling can make the poll skip the intervening `running`
    // state, so the only signal is the fresh waitingStartedAt of the new wait.
    const prev = snapshotIdentities([task('a', 'waiting_user', 'Task a', '02-detect', 't0')]);
    const events = detectTransitions(prev, [
      task('a', 'waiting_user', 'Task a', '02-detect', 't1'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.currentWaitStartedAt).toBe('t1');
  });

  it('does not fire when an unrelated edit leaves the wait occurrence intact', () => {
    // A rename / autoContinue toggle does not touch the gate's waitingStartedAt,
    // so the identity is unchanged and no spurious notification fires.
    const prev = snapshotIdentities([task('a', 'waiting_user', 'Task a', '02-detect', 't0')]);
    const events = detectTransitions(prev, [
      task('a', 'waiting_user', 'Renamed', '02-detect', 't0'),
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
      currentWaitStartedAt: 't0',
      baseline: false,
    });
  });

  it('carries currentStepId so each gate keys a distinct episode', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    const [event] = detectTransitions(prev, [task('a', 'waiting_user', 'Task a', '09-gate-2')]);
    expect(event!.currentStepId).toBe('09-gate-2');
  });

  it('normalizes an absent wait occurrence to null on the event', () => {
    const prev = snapshotIdentities([task('a', 'running')]);
    const [event] = detectTransitions(prev, [
      { id: 'a', title: 'Task a', status: 'waiting_user', currentStepId: 'g' },
    ]);
    expect(event!.currentWaitStartedAt).toBeNull();
  });
});

describe('snapshotIdentities', () => {
  it('keys each task by status+step+wait so any of them changing is a new identity', () => {
    const a = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-1', 't0')]);
    const b = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-2', 't0')]);
    const c = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-1', 't1')]);
    expect(a.get('a')).not.toBe(b.get('a'));
    expect(a.get('a')).not.toBe(c.get('a'));
  });

  it('is stable when status, step and wait are unchanged', () => {
    const a = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-1', 't0')]);
    const b = snapshotIdentities([task('a', 'waiting_user', 'Task a', 'step-1', 't0')]);
    expect(a.get('a')).toBe(b.get('a'));
  });

  it('drops disappeared tasks naturally', () => {
    const snap = snapshotIdentities([task('a', 'running'), task('b', 'waiting_user')]);
    expect(snap.size).toBe(2);
    expect(snap.has('a')).toBe(true);
    expect(snap.has('b')).toBe(true);
  });
});

// Replenishment task: a task carrying an allowance-back stamp (or null).
const rtask = (
  id: string,
  status: string,
  allowanceReplenishedAt: string | null,
  title = `Task ${id}`,
) => ({ id, title, status, currentStepId: null, allowanceReplenishedAt });

describe('detectAllowanceReplenished', () => {
  it('first poll surfaces already-replenished FAILED tasks as baseline events only', () => {
    const events = detectAllowanceReplenished(null, [
      rtask('a', 'failed', '2026-07-03T00:00:00Z'),
      rtask('b', 'failed', null), // failed but not replenished
      rtask('c', 'running', '2026-07-03T00:00:00Z'), // replenished but not failed
    ]);
    expect(events.map((e) => e.taskId)).toEqual(['a']);
    expect(events[0]!.status).toBe('allowance_replenished');
    expect(events[0]!.baseline).toBe(true);
    expect(events[0]!.currentWaitStartedAt).toBe('2026-07-03T00:00:00Z');
  });

  it('fires on the empty->set flip for a failed task', () => {
    const prev = snapshotAllowance([rtask('a', 'failed', null)]);
    const events = detectAllowanceReplenished(prev, [rtask('a', 'failed', '2026-07-03T01:00:00Z')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.baseline).toBe(false);
    expect(events[0]!.currentWaitStartedAt).toBe('2026-07-03T01:00:00Z');
  });

  it('does not re-fire while the replenishment stamp is unchanged', () => {
    const prev = snapshotAllowance([rtask('a', 'failed', '2026-07-03T01:00:00Z')]);
    expect(
      detectAllowanceReplenished(prev, [rtask('a', 'failed', '2026-07-03T01:00:00Z')]),
    ).toEqual([]);
  });

  it('re-fires when a later re-recovery stamps a fresh time (new episode)', () => {
    const prev = snapshotAllowance([rtask('a', 'failed', '2026-07-03T01:00:00Z')]);
    const events = detectAllowanceReplenished(prev, [rtask('a', 'failed', '2026-07-03T09:00:00Z')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.currentWaitStartedAt).toBe('2026-07-03T09:00:00Z');
  });

  it('only fires for failed tasks — a stamp on a non-failed task is ignored', () => {
    const prev = snapshotAllowance([rtask('a', 'running', null)]);
    expect(
      detectAllowanceReplenished(prev, [rtask('a', 'running', '2026-07-03T01:00:00Z')]),
    ).toEqual([]);
  });

  it('does not fire for a failed task that never replenished', () => {
    const prev = snapshotAllowance([rtask('a', 'failed', null)]);
    expect(detectAllowanceReplenished(prev, [rtask('a', 'failed', null)])).toEqual([]);
  });
});

describe('snapshotAllowance', () => {
  it('maps each task to its replenishment stamp, empty string when absent', () => {
    const snap = snapshotAllowance([
      rtask('a', 'failed', '2026-07-03T01:00:00Z'),
      rtask('b', 'failed', null),
    ]);
    expect(snap.get('a')).toBe('2026-07-03T01:00:00Z');
    expect(snap.get('b')).toBe('');
  });
});
