import { upgradeRunConfigSchema } from '@haive/shared/schemas';
import type { FormSchema } from '@haive/shared';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { projectStepOutputRoles, type RoleTaskPin } from '@haive/shared/step-outputs';

/** The caller has already loaded this task with its owner predicate. */
export async function projectTaskStepOutputRoles<T extends { stepId: string }>(
  db: Database,
  task: RoleTaskPin & { type: string },
  steps: readonly T[],
) {
  let pin: RoleTaskPin = task;
  if (
    task.derivedRunPlan == null &&
    !new Set<string>(schema.workflowTypeEnum.enumValues).has(task.type)
  ) {
    const definition = await db.query.taskTypeDefinitions.findFirst({
      where: eq(schema.taskTypeDefinitions.slug, task.type),
      columns: { runListStrategy: true },
    });
    pin = { ...task, runListStrategy: definition?.runListStrategy };
  }
  return projectStepOutputRoles(pin, steps).map((step) => {
    if (!('formSchema' in step)) return step;
    const previous = step.formSchema as FormSchema | null;
    const formSchema = upgradeRunConfigSchema(step.stepId, previous);
    return formSchema === previous ? step : { ...step, formSchema };
  });
}
