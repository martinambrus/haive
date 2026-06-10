/** Pure diffing of task-list polls into attention events. DOM-free so it can
 *  run under vitest's node environment. */

export const NOTIFIABLE_STATUSES = ['waiting_user', 'failed', 'completed'] as const;
export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

export interface TaskSnapshot {
  id: string;
  title: string;
  /** TaskStatus, kept as plain string so the helper stays decoupled. */
  status: string;
}

export interface TaskTransitionEvent {
  taskId: string;
  title: string;
  status: NotifiableStatus;
  /** True when this event came from the first poll of the session (the task
   *  was already waiting before the watcher mounted). The provider dedupes
   *  these via sessionStorage so each browser session surfaces them at most
   *  once. */
  baseline: boolean;
}

function isNotifiable(status: string): status is NotifiableStatus {
  return (NOTIFIABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Diff two task-list snapshots into attention events.
 *
 * prev === null → first poll. Baseline rule: only tasks ALREADY in
 * waiting_user produce (baseline) events; failed/completed history is never
 * replayed. prev !== null → an event fires for every task whose status is
 * notifiable AND differs from prev.get(id); a task first appearing
 * mid-session directly in a notifiable status also fires.
 */
export function detectTransitions(
  prev: ReadonlyMap<string, string> | null,
  next: readonly TaskSnapshot[],
): TaskTransitionEvent[] {
  const events: TaskTransitionEvent[] = [];
  for (const task of next) {
    if (!isNotifiable(task.status)) continue;
    if (prev === null) {
      if (task.status === 'waiting_user') {
        events.push({ taskId: task.id, title: task.title, status: task.status, baseline: true });
      }
      continue;
    }
    if (prev.get(task.id) !== task.status) {
      events.push({ taskId: task.id, title: task.title, status: task.status, baseline: false });
    }
  }
  return events;
}

/** Convenience for the poll loop: Map of taskId → status. */
export function snapshotStatuses(next: readonly TaskSnapshot[]): Map<string, string> {
  return new Map(next.map((t) => [t.id, t.status]));
}
