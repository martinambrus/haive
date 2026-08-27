import type { PlanTreeNode } from '@/lib/api-client';

/**
 * Which nodes a search filter leaves visible: every match, plus each match's
 * ancestors.
 *
 * An ancestor carries no hit of its own, but without it a match would render as
 * a detached root and the outline would stop answering "where is this".
 *
 * `set.has(cur)` doubles as the walk's cycle guard — every match walks its own
 * full chain, so stopping on an already-kept node loses nothing and a parent
 * pointer that loops cannot spin.
 *
 * Returns null when there is NO filter. An EMPTY match set is still a filter:
 * zero hits must render "Nothing matched." exactly as the tiles view does,
 * never silently unfilter the tree.
 */
export function computeVisibleSet(
  nodes: Pick<PlanTreeNode, 'id' | 'parentId'>[],
  matchIds: ReadonlySet<string> | null | undefined,
): Set<string> | null {
  if (!matchIds) return null;
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) parentOf.set(n.id, n.parentId);
  const set = new Set<string>(matchIds);
  for (const id of matchIds) {
    let cur = parentOf.get(id) ?? null;
    while (cur && !set.has(cur)) {
      set.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
  return set;
}
