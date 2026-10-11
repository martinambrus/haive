import { and, eq, isNotNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

/** The task row, or null while its current step's form is not yet parked. A `waiting_user` task
 *  names its next step before that step stamps `waiting_started_at`, and a submit sent in that gap
 *  predates the park, so the worker drops it as stale (`isStaleSubmit`). */
export async function taskAtParkedForm(db: Database, taskId: string) {
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  if (!task || task.status !== 'waiting_user' || !task.currentStepId) return task ?? null;
  const parked = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, task.currentStepId),
      eq(schema.taskSteps.status, 'waiting_form'),
      isNotNull(schema.taskSteps.waitingStartedAt),
    ),
    columns: { id: true },
  });
  return parked ? task : null;
}
