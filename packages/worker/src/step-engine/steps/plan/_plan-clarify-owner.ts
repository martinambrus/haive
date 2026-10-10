import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { PlanNodeSkeleton } from '@haive/shared/plan';
import type { StepContext } from '../../step-definition.js';

/**
 * True when this task's `00b-plan-clarify` drafted the plan whose root is in `nodes`. Such a plan
 * did not exist before the task (the build route refuses a clarifying build on a repository with a
 * plan, and locks the root while it runs), so every node in it is this build's to expand, whatever
 * `sourceTaskId` an edit on the canvas has since left on it.
 */
export async function ownsClarifiedOutline(
  ctx: Pick<StepContext, 'db' | 'taskId'>,
  nodes: readonly PlanNodeSkeleton[],
): Promise<boolean> {
  const root = nodes.find((n) => n.parentId === null);
  if (!root) return false;
  const [marker] = await ctx.db
    .select({ rootId: schema.planClarifyRounds.rootId })
    .from(schema.planClarifyRounds)
    .where(
      and(eq(schema.planClarifyRounds.taskId, ctx.taskId), eq(schema.planClarifyRounds.round, 0)),
    )
    .limit(1);
  return marker?.rootId === root.id;
}
