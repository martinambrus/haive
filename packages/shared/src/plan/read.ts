import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type {
  PlanEdgeKind,
  PlanEdgeView,
  PlanNodeKind,
  PlanNodeOrigin,
  PlanNodeStatus,
  PlanNodeView,
} from '../schemas/plan.js';
import { rollUpStatus } from '../schemas/plan.js';

/** A node's structural fields — everything except the (potentially large) body.
 *  The whole repo's worth of these is loaded to compute counts and status
 *  roll-up; bodies are fetched only for the node actually being read. */
export interface PlanNodeSkeleton {
  id: string;
  parentId: string | null;
  path: string;
  ordinal: number;
  title: string;
  kind: PlanNodeKind;
  status: PlanNodeStatus;
  taskable: boolean;
  version: number;
  createdBy: PlanNodeOrigin;
  sourceTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanNodeRecord extends PlanNodeSkeleton {
  body: string | null;
}

export interface PlanEdgeRecord {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: PlanEdgeKind;
  note: string | null;
}

/**
 * Every structural row for a repository's plan, in stable sibling order.
 *
 * Loaded whole rather than one level at a time on purpose. Counts and status
 * roll-up are functions of the ENTIRE subtree, so a per-level read would need a
 * recursive CTE per card; a plan is a few hundred rows of short strings, and the
 * client is still only ever SENT one level. "The server counts" is the invariant,
 * not "the counting happens in SQL".
 */
export async function loadPlanSkeletons(
  db: Database,
  repositoryId: string,
): Promise<PlanNodeSkeleton[]> {
  return db
    .select({
      id: schema.planNodes.id,
      parentId: schema.planNodes.parentId,
      path: schema.planNodes.path,
      ordinal: schema.planNodes.ordinal,
      title: schema.planNodes.title,
      kind: schema.planNodes.kind,
      status: schema.planNodes.status,
      taskable: schema.planNodes.taskable,
      version: schema.planNodes.version,
      createdBy: schema.planNodes.createdBy,
      sourceTaskId: schema.planNodes.sourceTaskId,
      createdAt: schema.planNodes.createdAt,
      updatedAt: schema.planNodes.updatedAt,
    })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, repositoryId))
    .orderBy(asc(schema.planNodes.ordinal), asc(schema.planNodes.createdAt));
}

/** As above, with bodies. Used by the markdown render (which is both the prompt
 *  input and the committed mirror) and by the single-node read. */
export async function loadPlanNodes(db: Database, repositoryId: string): Promise<PlanNodeRecord[]> {
  return db
    .select({
      id: schema.planNodes.id,
      parentId: schema.planNodes.parentId,
      path: schema.planNodes.path,
      ordinal: schema.planNodes.ordinal,
      title: schema.planNodes.title,
      kind: schema.planNodes.kind,
      body: schema.planNodes.body,
      status: schema.planNodes.status,
      taskable: schema.planNodes.taskable,
      version: schema.planNodes.version,
      createdBy: schema.planNodes.createdBy,
      sourceTaskId: schema.planNodes.sourceTaskId,
      createdAt: schema.planNodes.createdAt,
      updatedAt: schema.planNodes.updatedAt,
    })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, repositoryId))
    .orderBy(asc(schema.planNodes.ordinal), asc(schema.planNodes.createdAt));
}

export async function loadPlanEdges(db: Database, repositoryId: string): Promise<PlanEdgeRecord[]> {
  return db
    .select({
      id: schema.planNodeEdges.id,
      fromNodeId: schema.planNodeEdges.fromNodeId,
      toNodeId: schema.planNodeEdges.toNodeId,
      kind: schema.planNodeEdges.kind,
      note: schema.planNodeEdges.note,
    })
    .from(schema.planNodeEdges)
    .where(eq(schema.planNodeEdges.repositoryId, repositoryId));
}

export async function loadPlanNode(
  db: Database,
  repositoryId: string,
  nodeId: string,
): Promise<PlanNodeRecord | null> {
  const [row] = await db
    .select({
      id: schema.planNodes.id,
      parentId: schema.planNodes.parentId,
      path: schema.planNodes.path,
      ordinal: schema.planNodes.ordinal,
      title: schema.planNodes.title,
      kind: schema.planNodes.kind,
      body: schema.planNodes.body,
      status: schema.planNodes.status,
      taskable: schema.planNodes.taskable,
      version: schema.planNodes.version,
      createdBy: schema.planNodes.createdBy,
      sourceTaskId: schema.planNodes.sourceTaskId,
      createdAt: schema.planNodes.createdAt,
      updatedAt: schema.planNodes.updatedAt,
    })
    .from(schema.planNodes)
    .where(and(eq(schema.planNodes.id, nodeId), eq(schema.planNodes.repositoryId, repositoryId)))
    .limit(1);
  return row ?? null;
}

/** children-by-parent, each run already in sibling order. */
export function indexChildren<T extends { id: string; parentId: string | null }>(
  nodes: T[],
): Map<string | null, T[]> {
  const byParent = new Map<string | null, T[]>();
  for (const n of nodes) {
    const run = byParent.get(n.parentId);
    if (run) run.push(n);
    else byParent.set(n.parentId, [n]);
  }
  return byParent;
}

/** Descendant STATUSES for every node, keyed by node id. One pass over the
 *  children index rather than one subtree query per card. */
function collectDescendantStatuses(
  nodes: PlanNodeSkeleton[],
): Map<string, { statuses: PlanNodeStatus[]; direct: number }> {
  const byParent = indexChildren(nodes);
  const out = new Map<string, { statuses: PlanNodeStatus[]; direct: number }>();

  const walk = (id: string): PlanNodeStatus[] => {
    const cached = out.get(id);
    if (cached) return cached.statuses;
    const children = byParent.get(id) ?? [];
    const statuses: PlanNodeStatus[] = [];
    for (const child of children) {
      statuses.push(child.status, ...walk(child.id));
    }
    out.set(id, { statuses, direct: children.length });
    return statuses;
  };

  for (const n of nodes) walk(n.id);
  return out;
}

/** Turn skeletons into the API's node view, with server-computed counts and the
 *  derived roll-up status. `bodies` supplies bodies for the nodes that need one
 *  (the client is never sent every body). */
export function toNodeViews(
  nodes: PlanNodeSkeleton[],
  pick: PlanNodeSkeleton[],
  bodies: Map<string, string | null> = new Map(),
): PlanNodeView[] {
  const stats = collectDescendantStatuses(nodes);
  return pick.map((n) => {
    const s = stats.get(n.id) ?? { statuses: [], direct: 0 };
    return {
      id: n.id,
      parentId: n.parentId,
      path: n.path,
      ordinal: n.ordinal,
      title: n.title,
      kind: n.kind,
      body: bodies.get(n.id) ?? null,
      status: n.status,
      taskable: n.taskable,
      version: n.version,
      createdBy: n.createdBy,
      sourceTaskId: n.sourceTaskId,
      directChildren: s.direct,
      totalDescendants: s.statuses.length,
      rolledStatus: rollUpStatus(n.status, s.statuses),
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
    };
  });
}

export function toEdgeViews(edges: PlanEdgeRecord[]): PlanEdgeView[] {
  return edges.map((e) => ({
    id: e.id,
    fromNodeId: e.fromNodeId,
    toNodeId: e.toNodeId,
    kind: e.kind,
    note: e.note,
  }));
}

/** Root-to-node ancestry (inclusive), for the breadcrumb. Read off `path` rather
 *  than walked parent-by-parent — that is what the materialised ancestry is for. */
export function ancestryOf(nodes: PlanNodeSkeleton[], nodeId: string): PlanNodeSkeleton[] {
  const target = nodes.find((n) => n.id === nodeId);
  if (!target) return [];
  const ids = target.path.split('/').filter(Boolean);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return ids.flatMap((id) => {
    const n = byId.get(id);
    return n ? [n] : [];
  });
}
