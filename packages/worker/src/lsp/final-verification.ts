import { executionPathSchema } from '@haive/shared';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  builtinRunListStrategy,
  composedLspRunListEligible,
  taskRunListIds,
} from '@haive/shared/run-list';
import { stepRegistry } from '../step-engine/registry.js';

/** The step ids of the task's run list, or null when the task row is missing. Frozen
 * static/derived lists stay frozen. */
export async function taskRunListStepIds(db: Database, taskId: string): Promise<string[] | null> {
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  if (!task) return null;
  const definition =
    task.runListSnapshot == null && task.derivedRunPlan == null
      ? await db.query.taskTypeDefinitions.findFirst({
          where: eq(schema.taskTypeDefinitions.slug, task.type),
        })
      : null;
  return taskRunListIds(
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
}

/** Used at final verification and by the new-environment adoption check; an old pin
 * missing the final step is ineligible. */
export async function taskSupportsComposedLspFinal(db: Database, taskId: string): Promise<boolean> {
  const ids = await taskRunListStepIds(db, taskId);
  return ids !== null && composedLspRunListEligible(ids);
}
