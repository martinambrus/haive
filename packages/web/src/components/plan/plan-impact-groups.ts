import type { PlanEdgeKind, PlanImpactHop } from '@/lib/api-client';

/** Mirrors IMPACT_DEFAULT_VIEW_DEPTH in @haive/shared/plan/impact. Web must not
 *  import from that barrel — it reaches the database layer and drags drizzle and
 *  ioredis into the browser bundle — so this is a local copy, the same
 *  arrangement `task-vote.tsx` uses for the vote bounds. The API applies the
 *  real one; this only decides which button starts pressed, so a drift shows up
 *  as a highlighted button that disagrees with the data, never as a wrong
 *  radius. */
export const DEFAULT_IMPACT_DEPTH = 1;

/** The radii the control offers. Capped at 4 because that is the walk's own
 *  safety cap (`IMPACT_DEFAULT_MAX_DEPTH`) — offering 5 would return the same
 *  answer as 4 and read as a broken control. */
export const IMPACT_DEPTH_CHOICES = [1, 2, 3, 4] as const;

export interface PlanImpactRelationGroup {
  id: string;
  /** `Depends on` / `Depended on by` — the relation read in the direction the
   *  walk actually crossed it. */
  label: string;
  hops: PlanImpactHop[];
}

export interface PlanImpactGroup {
  /** Hops from the origin. */
  depth: number;
  /** `1 hop` / `2 hops`, already pluralised. */
  label: string;
  hops: PlanImpactHop[];
  /** The same hops split by relation, in the Links tab's order. */
  relations: PlanImpactRelationGroup[];
}

/** The same labels the Links tab uses, for the same reason: direction is half
 *  the meaning. A hop reached by walking WITH the arrow and one reached against
 *  it are opposite facts, and one heading for both would state the wrong one
 *  every other row. Kept as a local copy rather than imported from
 *  `plan-edge-groups` because that module is about a node's own edges, and one
 *  shared constant would tie two views' vocabularies together for no reason
 *  beyond today's coincidence. */
const RELATION_LABELS: Record<PlanEdgeKind, { out: string; in: string }> = {
  depends_on: { out: 'Depends on', in: 'Depended on by' },
  affects: { out: 'Affects', in: 'Affected by' },
  implements: { out: 'Implements', in: 'Implemented by' },
};

const RELATION_ORDER: PlanEdgeKind[] = ['depends_on', 'affects', 'implements'];

/** By name. A group can hold over a hundred hops, and the order the walk
 *  happened to reach them tells the reader nothing they can use to find one. */
const byTitle = (a: PlanImpactHop, b: PlanImpactHop): number =>
  (a.title ?? '').localeCompare(b.title ?? '');

/** Split one depth's hops by relation, emitting only the relations that are
 *  actually there. Unlike the Links tab, an empty group here offers nothing —
 *  there is no "add a hop" action, a hop is something the walk found. */
function relationGroups(hops: PlanImpactHop[]): PlanImpactRelationGroup[] {
  const out: PlanImpactRelationGroup[] = [];
  for (const kind of RELATION_ORDER) {
    for (const dir of ['out', 'in'] as const) {
      const items = hops
        .filter((h) => h.viaKind === kind && (dir === 'in') === h.reversed)
        .sort(byTitle);
      if (items.length > 0) {
        out.push({ id: `${kind}:${dir}`, label: RELATION_LABELS[kind][dir], hops: items });
      }
    }
  }
  return out;
}

/**
 * A node's affected set, split by how far away each node is.
 *
 * Grouped rather than listed flat because the flat list was the same length as
 * the walk: 192 rows of `· · · Title (depends on)` where the only thing telling
 * you the distance was how many dots the row started with. Distance is the one
 * thing an impact answer is ABOUT — a node one hop away is a change you must
 * make, a node four hops away is a thing to be aware of — so it becomes the
 * structure instead of a prefix.
 *
 * Groups ascend by depth and split again by relation, so a row's two facts —
 * how far away it is and how it is connected — are both structure rather than a
 * suffix. Within a relation, rows are alphabetical. Nothing is dropped: the
 * diagram beside this is the bounded surface, this one is the complete answer.
 */
export function groupImpactHops(hops: PlanImpactHop[]): PlanImpactGroup[] {
  const byDepth = new Map<number, PlanImpactHop[]>();
  for (const hop of hops) {
    const run = byDepth.get(hop.depth);
    if (run) run.push(hop);
    else byDepth.set(hop.depth, [hop]);
  }
  return [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, group]) => ({
      depth,
      label: `${depth} hop${depth === 1 ? '' : 's'}`,
      hops: [...group].sort(byTitle),
      relations: relationGroups(group),
    }));
}

/**
 * Which depth groups start open.
 *
 * The nearest group only. It is the answer to the question that was asked, and
 * on a hub-shaped plan the next one out holds over a hundred rows — opening
 * that by default buries the two nodes that actually matter. Matches the Links
 * tab, where a group nobody asked about starts collapsed.
 */
export function defaultOpenImpactDepths(groups: PlanImpactGroup[]): Set<number> {
  return new Set(groups.length > 0 ? [groups[0]!.depth] : []);
}
