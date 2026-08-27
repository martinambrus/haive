import { schema } from '@haive/database';
import { TASK_JOB_NAMES, type TaskJobPayload } from '@haive/shared';
import { getDb } from '../db.js';
import { getTaskQueue } from '../queues.js';
import { HttpError } from '../context.js';

/** Insert the task row and enqueue it. Mirrors global-kb's enrich endpoint —
 *  the established "UI button -> LLM work" path. */
export async function spawnPlanTask(args: {
  userId: string;
  repositoryId: string;
  type: 'plan_build' | 'plan_chat' | 'advisory';
  title: string;
  description?: string;
  metadata: Record<string, unknown>;
  cliProviderId: string | null;
  /** Runs after the task row exists and BEFORE the job is enqueued. Anything a
   *  step's detect() must already see belongs here: once the job is on the
   *  queue the worker can pick it up immediately, and it does. */
  seed?: (taskId: string) => Promise<void>;
}): Promise<string> {
  const db = getDb();
  const [task] = await db
    .insert(schema.tasks)
    .values({
      userId: args.userId,
      type: args.type,
      title: args.title.slice(0, 512),
      description: args.description ?? null,
      repositoryId: args.repositoryId,
      cliProviderId: args.cliProviderId,
      metadata: args.metadata,
      autoContinue: true,
      status: 'created',
    })
    .returning();
  if (!task) throw new HttpError(500, 'failed to create plan task');

  if (args.seed) await args.seed(task.id);

  await getTaskQueue().add(
    TASK_JOB_NAMES.START,
    { taskId: task.id, userId: args.userId } satisfies TaskJobPayload,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
  return task.id;
}
