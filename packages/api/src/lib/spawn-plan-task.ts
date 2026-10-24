import { lockRepositoryTasksKey, schema, type DbTx } from '@haive/database';
import { getDb } from '../db.js';
import { HttpError } from '../context.js';
import { admitNewWork } from '../middleware/maintenance.js';
import { definitionForCreate } from './task-type-definition.js';
import { boundedLockWait } from './repository-busy.js';
import { enqueueStart, markQueuedForStart } from './task-start.js';

/** Insert the task row, seed it and queue it in one transaction, then enqueue START after the
 *  commit. Mirrors global-kb's enrich endpoint — the established "UI button -> LLM work" path. */
export async function spawnPlanTask(args: {
  /** A caller-owned transaction, which queues the task; call enqueueStart once it commits.
   *  Allows creation to serialize with a node's other starts. */
  db?: DbTx;
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
  /** Runs after the task row exists and BEFORE the job is enqueued, in the creating transaction
   *  `tx`, where the row is invisible to every other handle until it commits. Anything a
   *  step's detect() must already see belongs here: once the job is on the
   *  queue the worker can pick it up immediately, and it does. */
  seed?: (taskId: string, tx: DbTx) => Promise<void>;
  /** Default true. False creates the row and stops: the caller is going to write
   *  something the seed hook cannot express — a stream of uploaded files, whose
   *  count and success are only known to the client — and will enqueue with the
   *  `start` task action once they all land. The row sits at `created`, which is
   *  what that action claims. */
  enqueue?: boolean;
  /** Original uploads to require at Start; stored only with enqueue: false, otherwise ignored.
   *  Null or omitted leaves the count unrecorded. */
  expectedAttachmentCount?: number | null;
}): Promise<string> {
  const create = async (tx: DbTx): Promise<string> => {
    await admitNewWork(tx);
    // Queuing takes this lock; taken before the insert, it inverts no lock the row's insert holds.
    await boundedLockWait(tx, () => lockRepositoryTasksKey(tx, args.repositoryId));
    const { runListSnapshot, customSteps } = await definitionForCreate(tx, args.type, {
      generic: false,
    });
    const [task] = await tx
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
        runListSnapshot,
        customSteps,
        status: 'created',
        expectedAttachmentCount:
          args.enqueue === false ? (args.expectedAttachmentCount ?? null) : null,
      })
      .returning();
    if (!task) throw new HttpError(500, 'failed to create plan task');

    if (args.seed) await args.seed(task.id, tx);
    if (args.enqueue !== false) await markQueuedForStart(tx, task.id);
    return task.id;
  };
  if (args.db) return create(args.db);

  const taskId = await getDb().transaction(create);
  if (args.enqueue !== false) await enqueueStart(taskId, args.userId);
  return taskId;
}

/** Called after a caller-owned transaction commits; never expose a queued job
 * whose task row is still invisible to the worker. The START claim is idempotent. */
export async function enqueuePlanTask(taskId: string, userId: string): Promise<void> {
  const queued = await getDb().transaction(async (tx) => {
    await admitNewWork(tx);
    return markQueuedForStart(tx, taskId);
  });
  if (queued) await enqueueStart(taskId, userId);
}
