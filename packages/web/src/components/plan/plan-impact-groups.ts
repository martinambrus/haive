import type { PlanImpactHop } from '@/lib/api-client';

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

export interface PlanImpactGroup {
  /** Hops from the origin. */
  depth: number;
  /** `1 hop` / `2 hops`, already pluralised. */
  label: string;
  hops: PlanImpactHop[];
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
 * Order within a group is the order the walk found them, which is stable across
 * refetches; groups ascend by depth. Nothing is dropped: the diagram beside this
 * is the bounded surface, this one is the complete answer.
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
      hops: group,
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
