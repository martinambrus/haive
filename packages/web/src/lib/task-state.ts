import { isTaskDead } from './step-banners';
import type { TaskToneLike } from './task-tone';

export type TaskBadgeKind = 'finished' | 'dead' | 'paused' | 'slotWait' | 'status';

/** Which badge the task page wears, most specific first: finished, dead, paused, slot wait, status. */
export function taskBadgeKind(task: TaskToneLike): TaskBadgeKind {
  if (task.status === 'completed' || task.status === 'cancelled') return 'finished';
  if (isTaskDead(task)) return 'dead';
  if (task.pausedAt) return 'paused';
  if (task.slotWait) return 'slotWait';
  return 'status';
}

export type TaskMenuKey = 'start' | 'retry' | 'resume' | 'pause' | 'stop' | 'cancel';

/** The entries of the task page's actions menu. A dead task keeps Cancel and nothing else. */
export function taskMenuKeys(task: TaskToneLike, opts: { stepRunning: boolean }): TaskMenuKey[] {
  if (isTaskDead(task)) return ['cancel'];
  const open = task.status !== 'completed' && task.status !== 'cancelled';
  const keys: TaskMenuKey[] = [];
  if (task.status === 'created') keys.push('start');
  if (task.status === 'failed') keys.push('retry');
  if (open) keys.push(task.pausedAt != null ? 'resume' : 'pause');
  if (opts.stepRunning) keys.push('stop');
  if (open) keys.push('cancel');
  return keys;
}

/** The state word a list shows for a task: `dead` ahead of the status it died in. */
export function taskStatusWord(task: TaskToneLike): string {
  return isTaskDead(task) ? 'dead' : task.status;
}

interface TaskClockRow {
  completedAt?: string | null;
  deadAt?: string | null;
}

/** When a task's clocks stopped: it finished, else it died. Null while they still run. */
export function taskStoppedAt(task: TaskClockRow): string | null {
  return task.completedAt ?? task.deadAt ?? null;
}

/** The instant a task's timers read up to: where they stopped, else `nowMs`. */
export function taskClockEndMs(task: TaskClockRow, nowMs: number): number {
  const stoppedAt = taskStoppedAt(task);
  return stoppedAt === null ? nowMs : new Date(stoppedAt).getTime();
}
