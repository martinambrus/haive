/** Pure diffing of task-list polls into attention events. DOM-free so it can
 *  run under vitest's node environment. */

export const NOTIFIABLE_STATUSES = ['waiting_user', 'failed', 'completed'] as const;
export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

/** A notification episode kind: a watched TASK status, plus the synthetic
 *  'allowance_replenished' episode (a failed task whose CLI allowance came back). Keyed by
 *  the notifier for copy/tint/dedupe; NOT a task status (detectTransitions never emits it,
 *  it is produced only by detectAllowanceReplenished). */
export type AttentionKind = NotifiableStatus | 'allowance_replenished' | 'auto_resumed';

export interface TaskSnapshot {
  id: string;
  title: string;
  /** TaskStatus, kept as plain string so the helper stays decoupled. */
  status: string;
  /** The step the task is paused on (a gate / waiting_form). Part of the
   *  attention identity so advancing to a DIFFERENT step re-notifies even while
   *  the task status stays waiting_user across both gates. */
  currentStepId: string | null;
  /** ISO time the current gate began waiting (the waiting_form step's
   *  waitingStartedAt). Re-stamped each time the task (re)enters a gate, so it
   *  tags the wait OCCURRENCE: a restart/retry that returns to the SAME step
   *  gets a fresh value (→ a fresh notification) whereas an unrelated task edit
   *  leaves it untouched (→ no spurious re-fire). Null/absent when not at a gate. */
  currentWaitStartedAt?: string | null;
  /** ISO time the task's depleted-allowance watch flipped to replenished (list endpoint
   *  only). Null/absent unless a rate-limit-failed task's allowance has come back; its
   *  empty->set transition is a distinct notifiable episode from the failure itself. */
  allowanceReplenishedAt?: string | null;
  /** ISO time the poller AUTO-resumed this task after its allowance came back (list endpoint
   *  only; set only when CONFIG_KEYS.AUTO_RESUME_ON_ALLOWANCE is on). Distinct from
   *  allowanceReplenishedAt (the notify-only "ready to retry" signal). Its empty->set flip is
   *  a live "it auto-resumed" episode. */
  allowanceAutoResumedAt?: string | null;
}

export interface TaskTransitionEvent {
  taskId: string;
  title: string;
  status: AttentionKind;
  /** Step the task is paused on, threaded so the provider keys a distinct
   *  notification episode per gate (each gate notifies once). */
  currentStepId: string | null;
  /** Wait-occurrence tag (the gate's waitingStartedAt) folded into the provider's
   *  persistent seen-key so the same gate re-notifies after a restart — the new
   *  wait carries a fresh value — without re-firing on unrelated edits. */
  currentWaitStartedAt: string | null;
  /** True when this event came from the first poll of the session (the task
   *  was already waiting before the watcher mounted). The provider dedupes
   *  these via the persistent seen-store so each browser session surfaces them
   *  at most once. */
  baseline: boolean;
}

function isNotifiable(status: string): status is NotifiableStatus {
  return (NOTIFIABLE_STATUSES as readonly string[]).includes(status);
}

/** In-memory attention identity for the poll-to-poll diff: status + the step the
 *  task is paused on + the wait occurrence. A change in ANY is a fresh thing to
 *  surface — so the next gate fires (different step) AND a restart that re-enters
 *  the SAME gate fires (different waitingStartedAt), even when background-tab
 *  timer throttling makes the poll skip over the intervening `running` state. */
function identityOf(
  status: string,
  currentStepId: string | null,
  waitStartedAt: string | null | undefined,
): string {
  return `${status} ${currentStepId ?? ''} ${waitStartedAt ?? ''}`;
}

/**
 * Diff two task-list snapshots into attention events.
 *
 * prev === null → first poll. Baseline rule: only tasks ALREADY in
 * waiting_user produce (baseline) events; failed/completed history is never
 * replayed. prev !== null → an event fires for every notifiable task whose
 * attention identity (status + current step + wait occurrence) differs from
 * prev.get(id); a task first appearing mid-session directly in a notifiable
 * status also fires.
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
          currentWaitStartedAt: task.currentWaitStartedAt ?? null,
          baseline: true,
        });
      }
      continue;
    }
    if (
      prev.get(task.id) !== identityOf(task.status, task.currentStepId, task.currentWaitStartedAt)
    ) {
      events.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        currentStepId: task.currentStepId,
        currentWaitStartedAt: task.currentWaitStartedAt ?? null,
        baseline: false,
      });
    }
  }
  return events;
}

/** Convenience for the poll loop: Map of taskId → attention identity (status +
 *  current step + wait occurrence), compared against the next poll by
 *  detectTransitions. */
export function snapshotIdentities(next: readonly TaskSnapshot[]): Map<string, string> {
  return new Map(
    next.map((t) => [t.id, identityOf(t.status, t.currentStepId, t.currentWaitStartedAt)]),
  );
}

/**
 * Diff two allowance snapshots into "allowance is back" events — a SEPARATE channel from
 * detectTransitions (which stays keyed on task status), so the failure notification and the
 * later replenishment notification are independent episodes.
 *
 * An event fires for a `failed` task whose allowanceReplenishedAt is set AND differs from
 * prev (an empty->set flip observed live). On the first poll (prev === null) every already-
 * replenished failed task fires a `baseline` event — like waiting_user, so a replenishment
 * that happened while the tab was closed is still surfaced; the provider's persistent seen-
 * store dedupes it to once per episode. The retry/resume/cancel paths clear the column, so a
 * retried task drops out and a re-failure + re-recovery yields a fresh (later) timestamp →
 * a fresh episode.
 */
export function detectAllowanceReplenished(
  prev: ReadonlyMap<string, string> | null,
  next: readonly TaskSnapshot[],
): TaskTransitionEvent[] {
  const events: TaskTransitionEvent[] = [];
  for (const task of next) {
    if (task.status !== 'failed') continue;
    const cur = task.allowanceReplenishedAt ?? '';
    if (!cur) continue;
    if (prev !== null && (prev.get(task.id) ?? '') === cur) continue;
    events.push({
      taskId: task.id,
      title: task.title,
      status: 'allowance_replenished',
      currentStepId: task.currentStepId,
      // Fold the replenishment stamp into the seen-key slot so each replenishment episode
      // dedupes as one, while a later re-recovery (fresh stamp) re-notifies.
      currentWaitStartedAt: cur,
      baseline: prev === null,
    });
  }
  return events;
}

/** taskId -> allowanceReplenishedAt ('' when absent), compared against the next poll by
 *  detectAllowanceReplenished. Seeds the baseline so a replenishment is diffed as a flip. */
export function snapshotAllowance(next: readonly TaskSnapshot[]): Map<string, string> {
  return new Map(next.map((t) => [t.id, t.allowanceReplenishedAt ?? '']));
}

/**
 * Diff two auto-resume snapshots into "task auto-resumed" events — the counterpart to
 * detectAllowanceReplenished for when CONFIG_KEYS.AUTO_RESUME_ON_ALLOWANCE is on. Fires on
 * the empty->set (or changed) flip of allowanceAutoResumedAt, for a task in ANY status
 * (auto-resume flips it back to `running`, so this channel — unlike the replenished one — is
 * NOT gated on `failed`).
 *
 * NO baseline: on the first poll (prev === null) it only seeds the snapshot and emits nothing.
 * An auto-resume that happened while the tab was closed needs no attention — the task already
 * resumed itself and is running — whereas the notify-only path DOES baseline because that task
 * is still failed and waiting on the user. The stamp is a historical column (not cleared by
 * CLEAR_ALLOWANCE_WATCH), so baselining it would re-fire stale episodes on every page load.
 */
export function detectAutoResumed(
  prev: ReadonlyMap<string, string> | null,
  next: readonly TaskSnapshot[],
): TaskTransitionEvent[] {
  const events: TaskTransitionEvent[] = [];
  if (prev === null) return events;
  for (const task of next) {
    const cur = task.allowanceAutoResumedAt ?? '';
    if (!cur) continue;
    if ((prev.get(task.id) ?? '') === cur) continue;
    events.push({
      taskId: task.id,
      title: task.title,
      status: 'auto_resumed',
      currentStepId: task.currentStepId,
      // Fold the auto-resume stamp into the seen-key slot so each auto-resume dedupes as one.
      currentWaitStartedAt: cur,
      baseline: false,
    });
  }
  return events;
}

/** taskId -> allowanceAutoResumedAt ('' when absent), compared against the next poll by
 *  detectAutoResumed. Seeds the baseline so an auto-resume is diffed as a flip. */
export function snapshotAutoResumed(next: readonly TaskSnapshot[]): Map<string, string> {
  return new Map(next.map((t) => [t.id, t.allowanceAutoResumedAt ?? '']));
}
