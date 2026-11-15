import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { DerivedRunPlanError } from '@haive/shared/modularity';
import type { RoleTaskPin } from '@haive/shared/step-outputs';

/** Read immutable task state, never reconstruct a binding from today's catalog. */
export async function loadRoleTaskPin(db: Database, taskId: string): Promise<RoleTaskPin> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { derivedRunPlan: true, executionPath: true, runListSnapshot: true, type: true },
  });
  if (!task) throw new DerivedRunPlanError();
  // Strategy is immutable on a definition; this read only detects a required missing plan.
  // It never supplies a candidate, producer or fallback binding.
  if (
    task.derivedRunPlan == null &&
    task.type &&
    !schema.workflowTypeEnum.enumValues.includes(
      task.type as (typeof schema.workflowTypeEnum.enumValues)[number],
    )
  ) {
    const definition = await db.query.taskTypeDefinitions.findFirst({
      where: eq(schema.taskTypeDefinitions.slug, task.type),
      columns: { runListStrategy: true },
    });
    if (definition?.runListStrategy === 'derived') throw new DerivedRunPlanError();
  }
  return task;
}
