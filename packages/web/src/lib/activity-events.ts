/** Reconcile measurements and insight journals remain available through the events API.
 * Keep them out of the human Activity feed, including future payload versions. */
export function activityEvents<T extends { eventType: string }>(events: readonly T[]): T[] {
  return events.filter(
    (event) =>
      event.eventType !== 'learning.reconciled' &&
      event.eventType !== 'insight.batch' &&
      event.eventType !== 'insight.page' &&
      event.eventType !== 'task.markdown_report',
  );
}
