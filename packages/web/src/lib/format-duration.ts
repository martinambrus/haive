/** Human-readable duration: seconds under a minute, m+s under an hour, else h+m.
 *  Shared by the task page total-time card, the tasks listing rows, and the
 *  per-terminal runtime timer so they all format the same way. */
export function formatDuration(ms: number, opts?: { alwaysSeconds?: boolean }): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  // Past 1h the compact form drops seconds; alwaysSeconds keeps them so a live
  // (ticking) value still visibly changes each second instead of every minute.
  if (opts?.alwaysSeconds) return `${hours}h ${minutes % 60}m ${seconds}s`;
  return `${hours}h ${minutes % 60}m`;
}

/** Compact colon-style hours:minutes for the estimate-vs-effort comparison
 *  (header indicator + footer verdict), e.g. 1h15m -> "1:15", 2.5h -> "2:30",
 *  45m -> "0:45", 0 -> "0:00". Minutes zero-padded, hours unpadded. Seconds are
 *  dropped (estimates are hour-scale; the value advances by the minute). */
export function formatHoursMinutes(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}
