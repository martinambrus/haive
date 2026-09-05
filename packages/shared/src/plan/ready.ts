import type { PlanNodeKind, PlanNodeStatus } from '../schemas/plan.js';
import type { PlanSequenceResult } from './sequence.js';

/**
 * "Which node do I start NOW, and how many could I start alongside it?"
 *
 * `computePlanSequence` answers what order the work happens in and what a node's
 * own unmet prerequisites are. Neither of those is the question a person arrives
 * with, and the obvious composition of the two gives the wrong answer, for a
 * reason worth stating here because it is the whole point of this module:
 * `blockedById` is DIRECT-only by design (see `sequence.ts` — inheriting it down
 * the tree marks most of a deep plan blocked and says nothing), so a node whose
 * CONTAINER is waiting still reads as ready.
 *
 * MEASURED on the dev install: of 7,079 taskable nodes in one plan, 1,286 carry
 * no unmet prerequisite of their own and 14 also have a clean ancestor chain. On
 * another, the lowest-numbered node the direct reading calls ready sits under two
 * containers that are themselves waiting. Picking by the direct rule therefore
 * hands a person work the plan says cannot start.
 *
 * A reading strict enough to CHOOSE is not one that should REFUSE, and this is
 * deliberately not wired into the `POST /tasks` gate: choosing badly wastes a
 * click, while refusing badly turns one wrong-direction `depends_on` into a
 * locked subtree.
 *
 * Derived, never stored, for the same reasons the sequence is.
 */

/** The node fields readiness is a function of. Structurally satisfied by
 *  `PlanNodeSkeleton`; declared here rather than imported so this module stays a
 *  leaf, exactly as `PlanSequenceNode` is. */
export interface PlanReadyNode {
  id: string;
  /** Materialised ancestry, self-inclusive and slash-terminated. The ancestor
   *  test reads this rather than walking `parentId`. */
  path: string;
  title: string;
  kind: PlanNodeKind;
  status: PlanNodeStatus;
  taskable: boolean;
}

export interface PlanReadyResult {
  /** Every ready node, lowest build-order number first. */
  readyIds: string[];
  /** The first of them, or null when nothing is startable. */
  nextId: string | null;
}

/** Strict ancestors of a node, from its materialised path.
 *
 *  Parsed here rather than through `ancestryOf` in `read.ts`: that resolves each
 *  id with a linear `find` over the node array, which is quadratic across the
 *  8,000-node plans this runs on. */
function ancestorIds(path: string): string[] {
  const ids = path.split('/').filter(Boolean);
  ids.pop();
  return ids;
}

/**
 * The nodes a person could open a task for right now.
 *
 * A node is ready when every one of these holds:
 *
 *  1. Its own status is `todo`. `in_progress` is a person saying they are on it,
 *     and the other three are settled or a human's verdict.
 *  2. It has no unmet prerequisite of its own.
 *  3. No ANCESTOR has an unmet prerequisite. This is the half `blockedById`
 *     deliberately omits, and the reason this module exists.
 *  4. No task linked to it is still open. Nothing writes `in_progress` when a
 *     task starts — `completePlanNodesForTask` is the only status writer and it
 *     runs at completion — so a node with a task already running still reads
 *     `todo`, and without this it would be offered again forever.
 *  5. It is a unit of work. `component`/`decision` say so with `taskable`;
 *     `research` and `external` ARE the unit of work by their kind, and carry
 *     `taskable` only sometimes (MEASURED: 10 of 16 research nodes, 4 of 12
 *     external), so for those the leaf test is what a plan actually records.
 *
 * Rules 2 and 3 also exclude every node inside a `depends_on` cycle and
 * everything beneath one — a cycle can never be satisfied, so its members never
 * lose their blockers. Nothing here needs to know about defects separately.
 */
export function computePlanReady(
  nodes: PlanReadyNode[],
  derived: PlanSequenceResult,
  openTaskNodeIds: ReadonlySet<string>,
): PlanReadyResult {
  const ready: PlanReadyNode[] = [];

  for (const node of nodes) {
    if (node.status !== 'todo') continue;
    if (derived.blockedById.has(node.id)) continue;
    if (openTaskNodeIds.has(node.id)) continue;
    if (ancestorIds(node.path).some((id) => derived.blockedById.has(id))) continue;

    if (node.kind === 'research' || node.kind === 'external') {
      if ((derived.statsById.get(node.id)?.directChildren ?? 0) > 0) continue;
    } else if (!node.taskable) {
      continue;
    }
    ready.push(node);
  }

  // Build order, which is what makes the first entry "next". A node the sequence
  // never numbered sorts last rather than first: 0 would put an unreachable node
  // at the head of the very list that exists to say what to do next.
  const seq = (id: string): number => derived.sequenceById.get(id) || Number.MAX_SAFE_INTEGER;
  ready.sort((a, b) => seq(a.id) - seq(b.id));

  const readyIds = ready.map((n) => n.id);
  return { readyIds, nextId: readyIds[0] ?? null };
}
