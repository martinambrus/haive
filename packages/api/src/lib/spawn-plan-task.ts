import { schema } from '@haive/database';
import { getDb } from '../db.js';
import { HttpError } from '../context.js';
import { enqueueStart, markQueuedForStart } from './task-start.js';

/** Insert the task row and enqueue it. Mirrors global-kb's enrich endpoint —
 *  the established "UI button -> LLM work" path. */
export async function spawnPlanTask(args: {
  userId: string;
  repositoryId: string;
  type: 'plan_build' | 'plan_chat' | 'advisory' | 'plan_sequence' | 'plan_merge';
  title: string;
  description?: string;
  metadata: Record<string, unknown>;
  cliProviderId: string | null;
  /** True when the caller named the CLI — a plan page picker. A saved per-step preference would
   *  otherwise run instead of the pick: MEASURED, a plan chat whose picker named codex ran on
   *  Claude, through an explicit `01-plan-chat` preference saved days earlier. A CLI changed on the
   *  running task still wins, through the touched-marker rule the New Task form's switch uses. */
  ignoreSavedStepClis?: boolean;
  /** Runs after the task row exists and BEFORE the job is enqueued. Anything a
   *  step's detect() must already see belongs here: once the job is on the
   *  queue the worker can pick it up immediately, and it does. */
  seed?: (taskId: string) => Promise<void>;
  /** Default true. False creates the row and stops: the caller is going to write
   *  something the seed hook cannot express — a stream of uploaded files, whose
   *  count and success are only known to the client — and will enqueue with the
   *  `start` task action once they all land. The row sits at `created`, which is
   *  what that action claims. */
  enqueue?: boolean;
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
      ignoreSavedStepClis: args.ignoreSavedStepClis ?? false,
      metadata: args.metadata,
      autoContinue: true,
      status: 'created',
    })
    .returning();
  if (!task) throw new HttpError(500, 'failed to create plan task');

  if (args.seed) await args.seed(task.id);

  if (args.enqueue === false) return task.id;

  if (await markQueuedForStart(db, task.id)) await enqueueStart(task.id, args.userId);
  return task.id;
}
