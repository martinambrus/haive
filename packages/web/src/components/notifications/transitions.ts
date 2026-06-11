/** Pure diffing of task-list polls into attention events. DOM-free so it can
 *  run under vitest's node environment. */

export const NOTIFIABLE_STATUSES = ['waiting_user', 'failed', 'completed'] as const;
export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

export interface TaskSnapshot {
  id: string;
  title: string;
  /** TaskStatus, kept as plain string so the helper stays decoupled. */
  status: string;
  /** The step the task is paused on (a gate / waiting_form). Part of the
   *  attention identity so advancing to a DIFFERENT step re-notifies even while
   *  the task status stays waiting_user across both gates. */
  currentStepId: string | null;
  /** Task row updatedAt. Stamped when the wait (re)starts (markTaskWaiting) and
   *  stable for the duration of one wait, so it tags the wait OCCURRENCE: a
   *  restart/retry that re-enters the same step gets a fresh value and thus a
   *  fresh notification episode in the provider's persistent seen-store. */
  updatedAt: string;
}

export interface TaskTransitionEvent {
  taskId: string;
  title: string;
  status: NotifiableStatus;
  /** Step the task is paused on, threaded so the provider keys a distinct
   *  notification episode per gate (each gate notifies once). */
  currentStepId: string | null;
  /** Occurrence tag of this wait (the task's updatedAt). Folded into the
   *  provider's persistent seen-key so the same gate re-notifies after a
   *  restart/retry — the new wait carries a new updatedAt. */
  updatedAt: string;
  /** True when this event came from the first poll of the session (the task
   *  was already waiting before the watcher mounted). The provider dedupes
   *  these via the persistent seen-store so each browser session surfaces them
   *  at most once. */
  baseline: boolean;
}

function isNotifiable(status: string): status is NotifiableStatus {
  return (NOTIFIABLE_STATUSES as readonly string[]).includes(status);
}

/** In-memory attention identity for the poll-to-poll diff: status + the step
 *  the task is paused on. A change in EITHER is a fresh thing to surface (so a
 *  waiting_user → waiting_user move to the next gate still fires). The
 *  wait-occurrence tag (updatedAt) is deliberately NOT folded in here: an
 *  unrelated task edit (rename, autoContinue toggle) bumps updatedAt but must
 *  not re-fire the same gate. A genuine restart is still detected because it
 *  routes through `running` first, so the status change carries it. */
function identityOf(status: string, currentStepId: string | null): string {
  return `${status} ${currentStepId ?? ''}`;
}

/**
 * Diff two task-list snapshots into attention events.
 *
 * prev === null → first poll. Baseline rule: only tasks ALREADY in
 * waiting_user produce (baseline) events; failed/completed history is never
 * replayed. prev !== null → an event fires for every notifiable task whose
 * attention identity (status + current step) differs from prev.get(id); a task
 * first appearing mid-session directly in a notifiable status also fires.
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
        events.push({
          taskId: task.id,
          title: task.title,
          status: task.status,
          currentStepId: task.currentStepId,
          updatedAt: task.updatedAt,
          baseline: true,
        });
      }
      continue;
    }
    if (prev.get(task.id) !== identityOf(task.status, task.currentStepId)) {
      events.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        currentStepId: task.currentStepId,
        updatedAt: task.updatedAt,
        baseline: false,
      });
    }
  }
  return events;
}

/** Convenience for the poll loop: Map of taskId → attention identity (status +
 *  current step), compared against the next poll by detectTransitions. */
export function snapshotIdentities(next: readonly TaskSnapshot[]): Map<string, string> {
  return new Map(next.map((t) => [t.id, identityOf(t.status, t.currentStepId)]));
}
