import type { PlanEdge, PlanEdgeKind } from '@/lib/api-client';

export interface PlanEdgeGroupItem {
  edgeId: string;
  /** The OTHER node — the one this node points at, or the one pointing here.
   *  Carried so the row can navigate to it. */
  nodeId: string;
  title: string;
  note: string | null;
}

export interface PlanEdgeGroup {
  id: string;
  label: string;
  items: PlanEdgeGroupItem[];
}

/**
 * Direction is half the meaning of a link, so it is half the label: "X depends
 * on this" and "this depends on X" are opposite facts and grouping them under
 * one heading would state the wrong one for every inbound edge.
 */
const LABELS: Record<PlanEdgeKind, { out: string; in: string }> = {
  depends_on: { out: 'Depends on', in: 'Depended on by' },
  affects: { out: 'Affects', in: 'Affected by' },
  implements: { out: 'Implements', in: 'Implemented by' },
};

/** Outgoing before incoming within a kind: what this node asserts about others
 *  reads first, what others assert about it second. */
const ORDER: PlanEdgeKind[] = ['depends_on', 'affects', 'implements'];

/**
 * Every outgoing group is ALWAYS returned, empty or not: each one is a link the
 * user can create from this node, and a group that renders only once it has
 * content cannot offer the affordance that creates its first item. Incoming
 * groups are facts about this node written elsewhere, so they appear only when
 * something is there to state.
 */

export function groupPlanEdges(edges: PlanEdge[], nodeId: string): PlanEdgeGroup[] {
  const groups: PlanEdgeGroup[] = [];
  for (const kind of ORDER) {
    for (const dir of ['out', 'in'] as const) {
      const items = edges
        .filter(
          (e) =>
            e.kind === kind && (dir === 'out' ? e.fromNodeId === nodeId : e.toNodeId === nodeId),
        )
        .map((e) => ({
          edgeId: e.id,
          nodeId: dir === 'out' ? e.toNodeId : e.fromNodeId,
          // A title the server did not send is still a real link; naming it
          // beats dropping the row and under-reporting what is connected.
          title: (dir === 'out' ? e.toTitle : e.fromTitle) ?? 'Untitled node',
          note: e.note,
        }))
        // By name: a group can hold dozens of links (86 on one node of the
        // dev plan), and insertion order is the order edges happened to be
        // written, which tells the reader nothing.
        .sort((a, b) => a.title.localeCompare(b.title));
      if (dir === 'out' || items.length > 0) {
        groups.push({ id: `${kind}:${dir}`, label: LABELS[kind][dir], items });
      }
    }
  }
  return groups;
}
