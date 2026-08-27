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

/**
 * The chain of parents above a node, nearest first.
 *
 * Used to reveal a node the user reached from somewhere else — a link row, an
 * impact hop, a breadcrumb — since a selected row inside a folded branch is
 * selected invisibly, which reads as the click having done nothing.
 *
 * Carries its own visited guard: the parent chain is data, and a corrupt one
 * must not spin the browser.
 */
export function ancestorsOf(
  nodes: Pick<PlanTreeNode, 'id' | 'parentId'>[],
  nodeId: string,
): string[] {
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) parentOf.set(n.id, n.parentId);
  const chain: string[] = [];
  const seen = new Set<string>([nodeId]);
  let cur = parentOf.get(nodeId) ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return chain;
}

export interface PlanTreeRow {
  id: string;
  parentId: string | null;
  depth: number;
  hasChildren: boolean;
}

/**
 * The rows the tree actually shows, in the order they appear on screen.
 *
 * Keyboard navigation is the reason this exists as data rather than as the
 * shape of a recursive render: "the next row down" is only answerable against
 * the flattened, filtered, folded-aware order, and deriving it from the DOM
 * would make the answer depend on what happened to be painted.
 *
 * A filter forces every kept branch open — a folded ancestor would hide the
 * very matches the filter exists to show — so `collapsed` is ignored while
 * `keep` is set.
 */
export function flattenVisible(
  nodes: Pick<PlanTreeNode, 'id' | 'parentId'>[],
  collapsed: ReadonlySet<string>,
  keep: ReadonlySet<string> | null,
): PlanTreeRow[] {
  const byParent = new Map<string | null, Pick<PlanTreeNode, 'id' | 'parentId'>[]>();
  for (const n of nodes) {
    const run = byParent.get(n.parentId);
    if (run) run.push(n);
    else byParent.set(n.parentId, [n]);
  }
  const rows: PlanTreeRow[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    for (const node of byParent.get(parentId) ?? []) {
      if (keep && !keep.has(node.id)) continue;
      // The parent chain is data; a cycle must not spin the walk.
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const children = (byParent.get(node.id) ?? []).filter((c) => !keep || keep.has(c.id));
      rows.push({ id: node.id, parentId: node.parentId, depth, hasChildren: children.length > 0 });
      if (children.length > 0 && (keep ? true : !collapsed.has(node.id))) walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
