import {
  RagSyncLockAbortedError,
  RagSyncLockTimeoutError,
  acquireRagSyncLock,
  type RagSyncLock,
} from '@haive/shared/rag';
import { getRedis } from '../../redis.js';
import { TaskCancelledError, type StepContext } from '../step-definition.js';

/** Covers the longest measured onboarding populate (~71 min) with margin. */
export const RAG_SYNC_LOCK_WAIT_MS = 2 * 60 * 60_000;

/** Takes the repository's RAG lock, waiting for a running sync of it. The caller MUST release
 *  the lock in a finally. A stopped task ends as cancelled; the bound ends the step in error. */
export async function acquireRepoRagSyncLock(
  ctx: StepContext,
  repositoryId: string,
): Promise<RagSyncLock> {
  let announced = false;
  try {
    return await acquireRagSyncLock(getRedis(), repositoryId, {
      waitMs: RAG_SYNC_LOCK_WAIT_MS,
      signal: ctx.signal,
      onWait: () => {
        if (announced) return;
        announced = true;
        void ctx
          .emitProgress('Waiting for another RAG sync of this repository to finish...')
          .catch(() => undefined);
      },
    });
  } catch (err) {
    if (err instanceof RagSyncLockAbortedError) throw new TaskCancelledError();
    if (err instanceof RagSyncLockTimeoutError) {
      throw new Error(`${err.message}. Retry this step once it has finished.`);
    }
    throw err;
  }
}
