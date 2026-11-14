/** Reconcile measurements remain available through the events API for benchmarks.
 * Keep them out of the human Activity feed, including future payload versions. */
export function activityEvents<T extends { eventType: string }>(events: readonly T[]): T[] {
  return events.filter((event) => event.eventType !== 'learning.reconciled');
}
