import {
  PLAN_MIRROR_JOB_NAMES,
  logger,
  type PlanMirrorJobPayload,
  type PlanMirrorJobResult,
} from '@haive/shared';
import { getPlanMirrorQueue, getPlanMirrorQueueEvents } from '../queues.js';

/** Wake the worker after an API-side plan mutation. The database revision row
 *  is the durable outbox, so Redis failure must not turn an already-committed DB
 *  edit into an HTTP error; the scheduled sweep will recover it. */
export async function enqueuePlanMirrorRefresh(
  repositoryId: string,
  userId: string,
): Promise<void> {
  try {
    await getPlanMirrorQueue().add(
      PLAN_MIRROR_JOB_NAMES.REFRESH,
      { repositoryId, userId } satisfies PlanMirrorJobPayload,
      {
        // UUIDs contain no colon (BullMQ reserves it in custom ids). While one
        // refresh is queued/active, later mutations only need to dirty the DB
        // revision; that job or the scheduled sweep will read the newest state.
        jobId: `plan-mirror-${repositoryId}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } catch (err) {
    logger.warn({ err, repositoryId }, 'plan mirror refresh enqueue failed; sweep will retry');
  }
}

/** Explicit Save is synchronous from the user's perspective: it does not claim
 *  success until the worker has refreshed, committed and optionally pushed. */
export async function savePlanMirror(args: {
  repositoryId: string;
  userId: string;
  push: boolean;
  commitMessage?: string;
}): Promise<PlanMirrorJobResult> {
  const queue = getPlanMirrorQueue();
  const job = await queue.add(
    PLAN_MIRROR_JOB_NAMES.SAVE,
    {
      repositoryId: args.repositoryId,
      userId: args.userId,
      push: args.push,
      ...(args.commitMessage ? { commitMessage: args.commitMessage } : {}),
    } satisfies PlanMirrorJobPayload,
    { removeOnComplete: 100, removeOnFail: 100 },
  );
  return job.waitUntilFinished(getPlanMirrorQueueEvents(), 120_000) as Promise<PlanMirrorJobResult>;
}
