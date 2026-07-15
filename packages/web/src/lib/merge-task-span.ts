import type { Task } from './api-client.js';

// Merge a freshly-polled newest-first span into the current list. `fresh` is the
// authoritative window for the current filter — new tasks, status/timing changes,
// and drop-outs are all reflected. `requested` is the page size the poll asked
// for: a short page (fresh.length < requested) means `fresh` is the COMPLETE
// matching set with nothing beyond it, so return it wholesale — any row that
// dropped out of the filter (e.g. a task that just finished under "Unfinished")
// then disappears instead of lingering. Only a saturated window can have more
// rows beyond it, so only then keep the older tail from `prev` so a deep scroll
// is not truncated. createdAt is immutable, so the oldest fresh row's timestamp
// cleanly splits refreshed-window from the static tail (and id membership
// prevents duplicating a boundary row).
export function mergeSpan(prev: Task[] | null, fresh: Task[], requested: number): Task[] {
  if (!prev || fresh.length < requested) return fresh;
  const oldest = fresh[fresh.length - 1];
  if (!oldest || prev.length <= fresh.length) return fresh;
  const cutoff = new Date(oldest.createdAt).getTime();
  const freshIds = new Set(fresh.map((t) => t.id));
  const tail = prev.filter((t) => !freshIds.has(t.id) && new Date(t.createdAt).getTime() < cutoff);
  return [...fresh, ...tail];
}
