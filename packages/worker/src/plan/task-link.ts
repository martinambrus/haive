import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { applyPlanPatch } from '@haive/shared/plan';

/**
 * A completed workflow task greens the plan node it was created from.
 *
 * This is the link that stops the plan becoming a stale wiki: without it, a
 * canvas records intent once and then diverges from the repo forever. Hooked
 * onto `markTaskCompleted` specifically — cancel and fail have their own write
 * paths, so an abandoned task can never mark a node done.
 *
 * Only `todo` and `in_progress` are advanced. `blocked_human` and
 * `not_applicable` are verdicts a PERSON entered, and a task finishing is weaker
 * evidence than that: a node blocked on an unsigned contract is not unblocked by
 * shipping its code, and one written off should stay written off.
 *
 * Best-effort throughout. A plan write must never fail the task that produced it.
 */
export async function completePlanNodesForTask(db: Database, taskId: string): Promise<void> {
  try {
    const links = await db
      .select({ nodeId: schema.planNodeTasks.nodeId })
      .from(schema.planNodeTasks)
      .where(eq(schema.planNodeTasks.taskId, taskId));
    if (links.length === 0) return;

    const nodes = await db
      .select({
        id: schema.planNodes.id,
        repositoryId: schema.planNodes.repositoryId,
        status: schema.planNodes.status,
        version: schema.planNodes.version,
      })
      .from(schema.planNodes)
      .where(
        inArray(
          schema.planNodes.id,
          links.map((l) => l.nodeId),
        ),
      );

    const advance = nodes.filter((n) => n.status === 'todo' || n.status === 'in_progress');
    if (advance.length === 0) return;

    // Grouped by repository because a patch is scoped to one plan. In practice a
    // task has one node, but the link table permits several.
    const byRepo = new Map<string, typeof advance>();
    for (const n of advance) {
      const run = byRepo.get(n.repositoryId);
      if (run) run.push(n);
      else byRepo.set(n.repositoryId, [n]);
    }

    for (const [repositoryId, group] of byRepo) {
      // No expectedVersion: this is not competing with a human editing the same
      // node, it is recording a fact that already happened. A conflict here would
      // just drop the update on the floor.
      await applyPlanPatch(
        db,
        {
          ops: group.map((n) => ({
            op: 'upsert' as const,
            nodeRef: n.id,
            status: 'done' as const,
          })),
        },
        { repositoryId, origin: 'user', sourceTaskId: taskId },
      );
    }
    logger.info(
      { taskId, nodes: advance.map((n) => n.id) },
      'plan nodes marked done on task completion',
    );
  } catch (err) {
    logger.warn({ err, taskId }, 'plan node completion failed (non-fatal)');
  }
}
