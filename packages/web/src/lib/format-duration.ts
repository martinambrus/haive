/** Human-readable duration: seconds under a minute, m+s under an hour, else h+m.
 *  Shared by the task page total-time card, the tasks listing rows, and the
 *  per-terminal runtime timer so they all format the same way. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
