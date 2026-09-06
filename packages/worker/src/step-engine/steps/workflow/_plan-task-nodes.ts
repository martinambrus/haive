import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { loadPlanEdges, loadPlanNodes } from '@haive/shared/plan';
import type { PlanNodeRecord } from '@haive/shared/plan';
import type { StepContext } from '../../step-definition.js';

/**
 * The plan nodes a task was CREATED to serve, and the order they must be built in.
 *
 * One loader for both readers, because they disagree about presentation and must
 * not disagree about facts: 04-phase-0b renders these into the spec with their
 * bodies, and 06b-sprint-planning renders only the ordering as a DAG constraint.
 * Two queries would be two definitions of "internal dependency" and they would
 * drift.
 *
 * `internalDeps` is deliberately only the `depends_on` edges BETWEEN seeded
 * nodes. A prerequisite outside the set is somebody else's work — the create-task
 * gate already refused the task if one was outstanding — and naming it here would
 * read as something this task has to cover.
 */
export interface SeededPlanNodes {
  nodes: PlanNodeRecord[];
  internalDeps: { fromNodeId: string; toNodeId: string }[];
  /** Ancestor titles per node, outermost first. A node title alone ("Order form")
   *  is routinely meaningless without what contains it. */
  ancestryById: Map<string, string[]>;
}

export async function loadSeededPlanNodes(
  ctx: StepContext,
  repositoryId: string,
): Promise<SeededPlanNodes | null> {
  const links = await ctx.db
    .select({ nodeId: schema.planNodeTasks.nodeId })
    .from(schema.planNodeTasks)
    .where(eq(schema.planNodeTasks.taskId, ctx.taskId));
  if (links.length === 0) return null;

  const seeded = new Set(links.map((l) => l.nodeId));
  const [all, edges] = await Promise.all([
    loadPlanNodes(ctx.db, repositoryId),
    loadPlanEdges(ctx.db, repositoryId),
  ]);
  const byId = new Map(all.map((n) => [n.id, n]));

  // Plan order, not link-row order: the set is what someone would build, and the
  // sequence is already the answer to "in what order". `loadPlanNodes` returns
  // stable sibling order, so filtering it preserves that.
  const nodes = all.filter((n) => seeded.has(n.id));
  if (nodes.length === 0) return null;

  const ancestryById = new Map(
    nodes.map((n) => [
      n.id,
      n.path
        .split('/')
        .filter(Boolean)
        .slice(0, -1)
        .map((id) => byId.get(id)?.title ?? id),
    ]),
  );

  return {
    nodes,
    internalDeps: edges
      .filter((e) => e.kind === 'depends_on' && seeded.has(e.fromNodeId) && seeded.has(e.toNodeId))
      .map((e) => ({ fromNodeId: e.fromNodeId, toNodeId: e.toNodeId })),
    ancestryById,
  };
}

/**
 * The seeded set as the spec writer is shown it: full bodies, at any depth.
 *
 * The plan index 04 also carries is capped at three levels for prompt size, which
 * is right for vocabulary and wrong for these — a seeded node deeper than that
 * would be absent from the only list the agent is told to copy ids from, so it
 * could not name the node the task exists for. The spec is then how the set
 * reaches the DAG planner, so the whole chain would break at its first hop.
 */
export function renderSeededNodesForSpec(seeded: SeededPlanNodes): string {
  const titleOf = (id: string): string => seeded.nodes.find((n) => n.id === id)?.title ?? id;
  const lines: string[] = [];
  for (const node of seeded.nodes) {
    lines.push(`### ${node.title} (\`node:${node.id}\`)`);
    const trail = seeded.ancestryById.get(node.id) ?? [];
    if (trail.length > 0) lines.push(`_In: ${trail.join(' › ')}_`);
    if (node.body?.trim()) lines.push('', node.body.trim());
    const waitsFor = seeded.internalDeps
      .filter((d) => d.fromNodeId === node.id)
      .map((d) => `\`node:${d.toNodeId}\` (${titleOf(d.toNodeId)})`);
    if (waitsFor.length > 0) {
      lines.push('', `Cannot start until these land: ${waitsFor.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The recorded build order, as one line per prerequisite.
 *
 * For the DAG planner, which cannot see the plan at all — it reads the spec. This
 * is a CONSTRAINT and it is stated as one, but it is not machine-enforced: the
 * planner's issues are not one-to-one with plan nodes, so a check would either
 * reject good decompositions or pass bad ones. Stating it and showing a person
 * what was stated is the honest limit.
 *
 * Empty when the set declares no order among itself, which is the parallel case
 * and needs no words.
 */
export function renderPlanOrderingConstraint(seeded: SeededPlanNodes): string {
  if (seeded.internalDeps.length === 0) return '';
  const titleOf = (id: string): string => seeded.nodes.find((n) => n.id === id)?.title ?? id;
  return seeded.internalDeps
    .map((d) => `- "${titleOf(d.toNodeId)}" must land before "${titleOf(d.fromNodeId)}"`)
    .join('\n');
}
