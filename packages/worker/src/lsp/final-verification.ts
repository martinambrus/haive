import { executionPathSchema } from '@haive/shared';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  builtinRunListStrategy,
  composedLspRunListEligible,
  taskRunListIds,
} from '@haive/shared/run-list';
import { stepRegistry } from '../step-engine/registry.js';

/** Used at final verification and available to the future opt-in writer. Frozen
 * static/derived lists stay frozen; an old pin missing the final step is ineligible. */
export async function taskSupportsComposedLspFinal(db: Database, taskId: string): Promise<boolean> {
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  if (!task) return false;
  const definition =
    task.runListSnapshot == null && task.derivedRunPlan == null
      ? await db.query.taskTypeDefinitions.findFirst({
          where: eq(schema.taskTypeDefinitions.slug, task.type),
        })
      : null;
  const ids = taskRunListIds(
    {
      workflowType: task.type,
      runListStrategy:
        task.derivedRunPlan != null
          ? 'derived'
          : task.runListSnapshot != null
            ? 'static'
            : (definition?.runListStrategy ?? builtinRunListStrategy(task.type)),
      runListSnapshot: task.runListSnapshot,
      derivedRunPlan: task.derivedRunPlan,
      executionPath:
        task.executionPath == null ? null : executionPathSchema.parse(task.executionPath),
    },
    (type) => stepRegistry.listByWorkflow(type).map((step) => step.metadata.id),
  );
  return composedLspRunListEligible(ids);
}
