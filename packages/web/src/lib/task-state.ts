import type { StopActivityResult } from './api-client';
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

export interface TaskStopState {
  stepRunning: boolean;
  currentStepStatus?: string | null;
}

/** Stop covers live work and the current row waiting to be claimed after a hand-off or Retry. */
export function taskCanStop(task: TaskToneLike, opts: TaskStopState): boolean {
  if (isTaskDead(task) || task.status === 'completed' || task.status === 'cancelled') return false;
  return (
    opts.stepRunning ||
    opts.currentStepStatus === 'running' ||
    opts.currentStepStatus === 'waiting_cli' ||
    (task.status === 'running' && opts.currentStepStatus === 'pending')
  );
}

/** The entries of the task page's actions menu. A dead task keeps Cancel and nothing else. */
export function taskMenuKeys(
  task: TaskToneLike & { pauseLocked?: boolean },
  opts: TaskStopState,
): TaskMenuKey[] {
  if (isTaskDead(task)) return ['cancel'];
  const open = task.status !== 'completed' && task.status !== 'cancelled';
  const keys: TaskMenuKey[] = [];
  if (task.status === 'created') keys.push('start');
  if (task.status === 'failed') keys.push('retry');
  if (open) {
    if (task.pausedAt == null) keys.push('pause');
    else if (!task.pauseLocked) keys.push('resume');
  }
  if (taskCanStop(task, opts)) keys.push('stop');
  if (open) keys.push('cancel');
  return keys;
}

/** Created and never started: nothing queues it on its own, so its page offers Start. */
export function taskNotStarted(task: TaskToneLike): boolean {
  return task.status === 'created' && !isTaskDead(task);
}

/** The banner the task page shows while `taskNotStarted`: a bold lead, then the detail. */
export const notStartedBanner = {
  lead: 'This task has not started.',
  detail:
    'It was created without being started so its attachments could be uploaded first; nothing runs on it until you press Start.',
} as const;

/** What the task page's Steps tab says while the task has no step rows yet. */
export function noStepsMessage(task: TaskToneLike): string {
  return taskNotStarted(task)
    ? 'No steps recorded yet. This task has not started; press Start above and the task worker will populate them.'
    : 'No steps recorded yet. The task worker will populate them once it starts.';
}

/** Who the owner is told holds a paused task: an administrator's maintenance pause is not their own. */
export function pausedByLabel(task: { pausedByAdmin?: boolean }): string {
  return task.pausedByAdmin ? 'Paused by an administrator' : 'Paused by you';
}

/** The closing sentence of the paused banner: a locked pause has no Resume to press. */
export function pausedResumeHint(task: { pauseLocked?: boolean }): string {
  return task.pauseLocked
    ? 'Only an administrator can resume it.'
    : 'Press Resume to continue where it stopped.';
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

/** An empty Stop can race a completion; only explicit zero counts prove nothing was stopped. */
export function stopResultNotice(result: Partial<StopActivityResult>): string | null {
  return result.stopped === 0 && result.killed === 0 && result.cancelled === 0
    ? 'Nothing was running to stop.'
    : null;
}
