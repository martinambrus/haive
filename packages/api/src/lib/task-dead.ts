import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { TASK_DEAD_EVENT } from '@haive/shared';
import { parseStepId } from '@haive/shared/modularity';
import { HttpError } from '../context.js';
import { readModuleStates } from './task-type-definition.js';

interface DeadFields {
  status: string;
  deadAt: Date | null;
}

/** Dead is structural: dead_at set on a task not cancelled or completed. dead_reason is copy. */
export function isTaskDead<T extends DeadFields>(task: T): task is T & { deadAt: Date } {
  return task.deadAt instanceof Date && task.status !== 'cancelled' && task.status !== 'completed';
}

/** Throws 409 `task_dead` for a dead task; call it before the route writes, kills or enqueues. */
export function refuseDeadTask(task: DeadFields): void {
  if (isTaskDead(task)) {
    throw new HttpError(
      409,
      'This task is dead: a step it needs is not installed, so only Cancel is left',
      'task_dead',
    );
  }
}

export interface TaskDeadDetail {
  at: string;
  steps: {
    stepId: string;
    /** `missing`: not installed (no row, or flagged missing), as against installed without this step. */
    module: { id: string; name: string | null; missing: boolean } | null;
  }[];
}

const moduleIdOf = (stepId: string): string | null => {
  const parsed = parseStepId(stepId);
  return parsed?.kind === 'module' ? parsed.moduleId : null;
};

/** Why the task is dead: the unresolved step ids and the module behind each; null unless dead. */
export async function loadTaskDead(
  db: Pick<Database, 'select'>,
  task: DeadFields & { id: string },
): Promise<TaskDeadDetail | null> {
  if (!isTaskDead(task)) return null;
  const [event] = await db
    .select({ payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(eq(schema.taskEvents.taskId, task.id), eq(schema.taskEvents.eventType, TASK_DEAD_EVENT)),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(1);
  const listed = event?.payload?.unresolved;
  const stepIds = Array.isArray(listed)
    ? listed.filter((id): id is string => typeof id === 'string')
    : [];
  const modules = stepIds.some((id) => moduleIdOf(id) !== null) ? await readModuleStates(db) : null;
  return {
    at: task.deadAt.toISOString(),
    steps: stepIds.map((stepId) => {
      const moduleId = moduleIdOf(stepId);
      if (moduleId === null) return { stepId, module: null };
      const state = modules?.get(moduleId);
      return {
        stepId,
        module: { id: moduleId, name: state?.name ?? null, missing: state?.missing ?? true },
      };
    }),
  };
}
