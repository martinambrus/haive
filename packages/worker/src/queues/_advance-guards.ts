/** Pure decision helpers for the advance-step guards. Kept out of task-queue.ts so they
 *  unit-test without pulling in BullMQ, the db, or the step registry. */

/** Banner text for the step that is holding a task up. The other-step guard refuses to advance
 *  any step while one is still running/waiting_cli/waiting_form, and used to do it silently — the
 *  blocker kept displaying whatever it last said ("Waiting for AI analysis…") while the task sat
 *  dead, which is what made the freeze unreadable. Written onto the BLOCKER's row (the one the
 *  user is looking at) and cleared by the next normal transition. */
export function blockedByActiveStepMessage(blockedStepId: string): string {
  return (
    `Still active — an advance for "${blockedStepId}" was skipped. ` +
    'The task cannot move on until this step finishes or is stopped.'
  );
}

/** A submit that reached a form reopened after it was sent: the step parks at a fresh form with no
 *  answers, and the job predates that park. Applying it would answer the new form with what was
 *  typed into the old one. A form submit carries no epoch, so this is the guard that drops one
 *  redelivered after its step moved on. */
export function isStaleSubmit(
  row: { status: string; formValues: unknown; waitingStartedAt: Date | null } | undefined,
  carriesFormValues: boolean,
  jobTimestamp: number | undefined,
): boolean {
  return (
    carriesFormValues &&
    row?.status === 'waiting_form' &&
    row.formValues == null &&
    row.waitingStartedAt != null &&
    jobTimestamp !== undefined &&
    jobTimestamp < row.waitingStartedAt.getTime()
  );
}

/** What an advance does with a stale submit. It is dropped, and the form parked again when the task
 *  still reads `running`: the pass that parked the form died before marking the task waiting. */
export function staleSubmitAction(
  row: { status: string; formValues: unknown; waitingStartedAt: Date | null } | undefined,
  carriesFormValues: boolean,
  jobTimestamp: number | undefined,
  taskStatus: string,
): 'proceed' | 'drop' | 'repark' {
  if (!isStaleSubmit(row, carriesFormValues, jobTimestamp)) return 'proceed';
  return taskStatus === 'running' ? 'repark' : 'drop';
}
