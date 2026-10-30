/** The single definition of "an entry the idle reaper keeps", shared by the reaper and the editor
 *  ensure. */
export function ideSessionHeld(
  entry: Record<string, string>,
  graceMs: number,
  now = Date.now(),
): boolean {
  const refcount = Number.parseInt(entry.refcount ?? '0', 10);
  const lastSeenAt = Number.parseInt(entry.lastSeenAt ?? '0', 10);
  return refcount > 0 || now - lastSeenAt < graceMs;
}
