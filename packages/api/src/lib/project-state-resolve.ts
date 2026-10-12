import { PLAN_MIRROR_JOB_NAMES } from '@haive/shared';
import type {
  ProjectStateResolvePayload,
  ProjectStateResolveResult,
} from '@haive/shared/project-state';
import { getPlanMirrorQueue, getPlanMirrorQueueEvents } from '../queues.js';

/** The worker answers the question, since it owns every write to the checkout's record files, and
 *  the answer is waited for: a person who clicked it wants to see what it did. A job still queued or
 *  running when the wait ends is `pending`, never a failure: it can still apply the answer. */
export async function resolveProjectStateConflict(
  payload: ProjectStateResolvePayload,
): Promise<ProjectStateResolveResult | { kind: 'pending' }> {
  const job = await getPlanMirrorQueue().add(PLAN_MIRROR_JOB_NAMES.RESOLVE_PROJECT_STATE, payload, {
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  try {
    return (await job.waitUntilFinished(
      getPlanMirrorQueueEvents(),
      60_000,
    )) as ProjectStateResolveResult;
  } catch (err) {
    const state = await job.getState().catch(() => 'unknown');
    if (state === 'failed') throw err;
    return { kind: 'pending' };
  }
}
