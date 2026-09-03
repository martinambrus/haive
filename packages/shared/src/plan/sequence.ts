import type { PlanBlocker, PlanEdgeKind, PlanNodeStatus } from '../schemas/plan.js';
import { rollUpStatus } from '../schemas/plan.js';

/**
 * "What do I build first, and what is not ready yet?"
 *
 * The plan tree says what a project is MEANT to be; it does not say in which
 * order to build it. This module derives both answers from rows that already
 * exist — the hierarchy plus `depends_on` edges — and stores nothing.
 *
 * DERIVED, NEVER STORED, for the same reason `rollUpStatus` is: a stored copy
 * needs a writer on every path and drifts the moment one is missed, and
 * `importPlanMirror` is a deliberate bypass of the one applier. Two further
 * reasons are specific to a number:
 *
 *  - It is a POSITION, not an identity. Inserting a node near the front of a
 *    2743-node plan shifts ~2700 numbers (MEASURED on the dev install). Stored,
 *    that is a ~2700-row UPDATE inside `applyPlanPatch`'s transaction, per op,
 *    against a patch that may carry `PLAN_PATCH_MAX_OPS` = 500 of them. Derived,
 *    it costs zero writes.
 *  - It round-trips across Haive instances for free: `plan.json` already exports
 *    `parentId` and `ordinal`, which is everything the number is computed from.
 *    A `sequence` field in that file would be a stored derived value inside the
 *    one artifact that gets re-imported.
 *
 * Never reference a node by its number across time. It names a slot in the
 * current plan, not a thing.
 */

/** The node fields the sequence is a function of. Structurally satisfied by
 *  `PlanNodeSkeleton` and `PlanNodeRecord`; declared here rather than imported
 *  so this module stays a leaf — `read.ts` calls INTO it, and a runtime cycle
 *  between the two would be a real one. */
export interface PlanSequenceNode {
  id: string;
  parentId: string | null;
  ordinal: number;
  title: string;
  status: PlanNodeStatus;
}

/** As above for `PlanEdgeRecord`. Only `depends_on` is read; `affects` and
 *  `implements` say a change PROPAGATES, not that work must wait. */
export interface PlanSequenceEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: PlanEdgeKind;
}

/** The descendant facts every card renders, folded on the same walk that
 *  numbers the tree rather than by a second recursion over the same rows. */
export interface PlanNodeStats {
  directChildren: number;
  totalDescendants: number;
  rolledStatus: PlanNodeStatus;
}

export interface PlanSequenceResult {
  /** node id -> its 1-based position in build order. Total over the input. */
  sequenceById: Map<string, number>;
  statsById: Map<string, PlanNodeStats>;
  /** node id -> ITS OWN unmet `depends_on` targets.
   *
   *  Direct only, never inherited down the tree. Post-order already builds
   *  children before their parent, so a parent's prerequisite is a statement
   *  about the PARENT's completion; and inheriting would mark most of a deep
   *  tree blocked — MEASURED on the dev install, 1302 of 4106 nodes hold an
   *  unmet dependency across seven levels, so the inherited reading blocks
   *  nearly everything and says nothing.
   *
   *  Only nodes with at least one unmet prerequisite appear. */
  blockedById: Map<string, PlanBlocker[]>;
  /** `depends_on` cycles: node ids in the order the walk closed the loop.
   *  These can NEVER unblock, so they are a plan defect rather than a wait, and
   *  every surface must say so differently. MEASURED on the dev install: one
   *  plan carries 5 — four mutual pairs and one three-node loop. Counting EDGE
   *  ROWS instead reports 8 for the pairs alone, which is the same fact
   *  double-counted; a cycle is reported once, keyed on its member set. */
  cycles: string[][];
  /** `depends_on` edges pointing at the node's own ancestor. Also unsatisfiable:
   *  `rollUpStatus` cannot green an ancestor while a descendant is outstanding,
   *  and the descendant is waiting on the ancestor. MEASURED: 11 on one plan. */
  ancestorDeps: { fromNodeId: string; toNodeId: string }[];
}

/** `depends_on` adjacency, restricted to endpoints present in `nodes`. A
 *  dangling endpoint cannot happen through the foreign keys, but this module is
 *  also handed sibling runs, patch previews and test fixtures. */
function indexDependsOn(
  nodes: PlanSequenceNode[],
  edges: PlanSequenceEdge[],
): Map<string, Set<string>> {
  const known = new Set(nodes.map((n) => n.id));
  const out = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== 'depends_on') continue;
    if (!known.has(edge.fromNodeId) || !known.has(edge.toNodeId)) continue;
    if (edge.fromNodeId === edge.toNodeId) continue;
    const run = out.get(edge.fromNodeId);
    if (run) run.add(edge.toNodeId);
    else out.set(edge.fromNodeId, new Set([edge.toNodeId]));
  }
  return out;
}

export interface SiblingOrdering {
  ordered: PlanSequenceNode[];
  /** The run's own `depends_on` edges contradict each other, so it kept its
   *  stored order. */
  contradictory: boolean;
  /** The edges pinned exactly one order — every step of the sort had a single
   *  ready node. False means the edges left a choice, which only a reader of the
   *  work itself can make. */
  decided: boolean;
}

/** A prerequisite is met only when it is SETTLED — finished, or deliberately not
 *  being done. Anything else, including a parent still rolling up as in
 *  progress, is something to wait for. */
function isSettled(status: PlanNodeStatus): boolean {
  return status === 'done' || status === 'not_applicable';
}

/**
 * Order one sibling run by the `depends_on` edges its own members declare.
 *
 * Kahn's algorithm with a stable tie-break: among the nodes nothing is waiting
 * on, take the one that came first in the stored order. A run whose members
 * declare nothing therefore comes back exactly as it was, which makes this a
 * refinement of `ordinal` rather than a replacement for it.
 *
 * MEASURED on the dev install: 87 of 334 sibling runs already carry 468 such
 * edges, so this alone orders a quarter of a plan with no agent and no new data.
 *
 * This is a WRITE-side helper — the sequencing step calls it to decide what to
 * store in `ordinal`. It is deliberately NOT applied by `computePlanSequence`:
 * a read that silently re-orders on top of `ordinal` would make the number
 * disagree with the order a person set by hand, with `plan.json`, and with the
 * committed markdown, and would leave them no way to override it. `ordinal` is
 * the one stored statement of order; everything else reads it.
 *
 * A run whose edges contradict each other keeps its stored order and says so.
 * Picking a winner would be inventing an answer the plan does not contain.
 */
export function orderSiblingsByDependency(
  run: PlanSequenceNode[],
  edges: PlanSequenceEdge[],
): SiblingOrdering {
  if (run.length < 2) return { ordered: run, contradictory: false, decided: true };
  const dependsOn = indexDependsOn(run, edges);

  const inRun = new Set(run.map((n) => n.id));
  /** id -> how many of its OWN siblings it is still waiting on. */
  const waitingOn = new Map<string, number>();
  /** prerequisite id -> the siblings waiting on it. */
  const unlocks = new Map<string, string[]>();

  for (const node of run) {
    let count = 0;
    for (const target of dependsOn.get(node.id) ?? []) {
      if (!inRun.has(target) || target === node.id) continue;
      count++;
      const run_ = unlocks.get(target);
      if (run_) run_.push(node.id);
      else unlocks.set(target, [node.id]);
    }
    waitingOn.set(node.id, count);
  }

  const ordered: PlanSequenceNode[] = [];
  const placed = new Set<string>();
  // A step where more than one node was ready is a TIE the edges did not
  // decide. It is the difference between "these edges state the order" and
  // "these edges are consistent with several orders", which is what the
  // sequencing step uses to spend an agent only where one is needed.
  let decided = true;
  // Re-scanning the run for the earliest ready node is O(n^2) in the worst
  // case, on runs whose measured maximum width is 22. A heap here would be
  // machinery for a number that never gets large.
  for (;;) {
    const ready = run.filter((n) => !placed.has(n.id) && (waitingOn.get(n.id) ?? 0) === 0);
    const next = ready[0];
    if (!next) break;
    if (ready.length > 1) decided = false;
    ordered.push(next);
    placed.add(next.id);
    for (const waiter of unlocks.get(next.id) ?? []) {
      waitingOn.set(waiter, (waitingOn.get(waiter) ?? 1) - 1);
    }
  }

  if (ordered.length === run.length) return { ordered, contradictory: false, decided };
  // Whatever is left is inside a cycle. Keep the stored order for it, so the
  // run is still fully numbered, and let the caller report it.
  for (const node of run) if (!placed.has(node.id)) ordered.push(node);
  return { ordered, contradictory: true, decided: false };
}

/** Every `depends_on` cycle, as the ids on the loop. Iterative DFS with an
 *  explicit stack: a plan is a few thousand nodes and a dependency chain can be
 *  arbitrarily long, so recursion depth is not something to bet on. */
function findDependencyCycles(ids: string[], dependsOn: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'open' | 'closed'>();
  const seenCycle = new Set<string>();

  for (const start of ids) {
    if (state.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    const stack: { id: string; targets: string[]; index: number }[] = [
      { id: start, targets: [...(dependsOn.get(start) ?? [])], index: 0 },
    ];
    state.set(start, 'open');
    path.push(start);
    onPath.add(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.targets.length) {
        state.set(frame.id, 'closed');
        onPath.delete(frame.id);
        path.pop();
        stack.pop();
        continue;
      }
      const target = frame.targets[frame.index]!;
      frame.index++;
      if (onPath.has(target)) {
        const loop = path.slice(path.indexOf(target));
        // One cycle reported once, whichever node the walk happened to enter it
        // from: the rotation-invariant key is the sorted id set.
        const key = [...loop].sort().join('\0');
        if (!seenCycle.has(key)) {
          seenCycle.add(key);
          cycles.push(loop);
        }
        continue;
      }
      if (state.get(target) === 'closed' || !dependsOn.has(target)) {
        if (!state.has(target)) state.set(target, 'closed');
        continue;
      }
      state.set(target, 'open');
      path.push(target);
      onPath.add(target);
      stack.push({ id: target, targets: [...(dependsOn.get(target) ?? [])], index: 0 });
    }
  }
  return cycles;
}

/**
 * Number a plan in build order and say what is not ready.
 *
 * The number is a POST-ORDER depth-first index: every descendant is numbered
 * before its container. That is the order the work happens in — a container is
 * finished when the things inside it are — and it matches how the roll-up
 * already greens a parent only once its children are settled.
 *
 * `nodes` is expected in the order `loadPlanNodes`/`loadPlanSkeletons` return
 * (`ORDER BY ordinal, created_at`), and that order is honoured exactly: the
 * number a node gets is a function of the tree plus `ordinal`, nothing else, so
 * it always agrees with the order shown in the canvas, committed to
 * `plan.json`, and reachable by a person reordering siblings by hand.
 *
 * The result is total: a node whose parent is missing from the input still
 * receives a number, appended after the reachable tree, because a view that
 * silently omits a node is worse than one that shows it last.
 */
export function computePlanSequence(
  nodes: PlanSequenceNode[],
  edges: PlanSequenceEdge[],
): PlanSequenceResult {
  const sequenceById = new Map<string, number>();
  const statsById = new Map<string, PlanNodeStats>();
  const blockedById = new Map<string, PlanBlocker[]>();
  const ancestorDeps: { fromNodeId: string; toNodeId: string }[] = [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dependsOn = indexDependsOn(nodes, edges);

  // Sibling runs in STORED order — the order `loadPlanNodes` returned, which is
  // `ordinal`. See `orderSiblingsByDependency` for why the refinement lives on
  // the write side instead.
  const orderedChildren = new Map<string | null, PlanSequenceNode[]>();
  for (const node of nodes) {
    const run = orderedChildren.get(node.parentId);
    if (run) run.push(node);
    else orderedChildren.set(node.parentId, [node]);
  }

  let counter = 0;
  const visited = new Set<string>();

  /** Post-order walk, iterative for the same reason the cycle finder is. Returns
   *  the subtree's statuses so the roll-up folds on the way back up. */
  const walk = (root: PlanSequenceNode): void => {
    type Frame = { node: PlanSequenceNode; children: PlanSequenceNode[]; index: number };
    const descendantStatuses = new Map<string, PlanNodeStatus[]>();
    const stack: Frame[] = [{ node: root, children: orderedChildren.get(root.id) ?? [], index: 0 }];
    visited.add(root.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.index < frame.children.length) {
        const child = frame.children[frame.index]!;
        frame.index++;
        // A parentage cycle is impossible through `path`, but this guard is what
        // keeps a corrupt row from hanging a page render.
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        stack.push({ node: child, children: orderedChildren.get(child.id) ?? [], index: 0 });
        continue;
      }

      counter++;
      sequenceById.set(frame.node.id, counter);
      const statuses: PlanNodeStatus[] = [];
      for (const child of frame.children) {
        if (!sequenceById.has(child.id)) continue;
        statuses.push(child.status, ...(descendantStatuses.get(child.id) ?? []));
        descendantStatuses.delete(child.id);
      }
      descendantStatuses.set(frame.node.id, statuses);
      statsById.set(frame.node.id, {
        directChildren: frame.children.length,
        totalDescendants: statuses.length,
        rolledStatus: rollUpStatus(frame.node.status, statuses),
      });
      stack.pop();
    }
  };

  for (const root of orderedChildren.get(null) ?? []) walk(root);
  // Anything the tree did not reach — a node whose parent is not in the input.
  for (const node of nodes) if (!visited.has(node.id)) walk(node);

  const rolledOf = (id: string): PlanNodeStatus =>
    statsById.get(id)?.rolledStatus ?? byId.get(id)?.status ?? 'todo';

  for (const node of nodes) {
    const targets = dependsOn.get(node.id);
    if (!targets) continue;
    const blockers: PlanBlocker[] = [];
    for (const targetId of targets) {
      const target = byId.get(targetId)!;
      // Walk up from the dependent: a prerequisite that is also an ancestor can
      // never be satisfied, because the roll-up cannot green it first.
      for (let cursor = node.parentId, guard = 0; cursor && guard < nodes.length; guard++) {
        if (cursor === targetId) {
          ancestorDeps.push({ fromNodeId: node.id, toNodeId: targetId });
          break;
        }
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      if (isSettled(rolledOf(targetId))) continue;
      blockers.push({
        nodeId: targetId,
        sequence: sequenceById.get(targetId) ?? 0,
        title: target.title,
      });
    }
    if (blockers.length === 0) continue;
    // Lowest number first: the thing to go and do is at the top of the list.
    blockers.sort((a, b) => a.sequence - b.sequence);
    blockedById.set(node.id, blockers);
  }

  return {
    sequenceById,
    statsById,
    blockedById,
    cycles: findDependencyCycles(
      nodes.map((n) => n.id),
      dependsOn,
    ),
    ancestorDeps,
  };
}
