import { PLAN_MIRROR_JOB_NAMES } from '@haive/shared';
import type {
  ProjectStateResolvePayload,
  ProjectStateResolveResult,
} from '@haive/shared/project-state';
import { getPlanMirrorQueue, getPlanMirrorQueueEvents } from '../queues.js';

/** The worker answers the question, since it owns every write to the checkout's record files, and
 *  the answer is waited for: a person who clicked it wants to see what it did. */
export async function resolveProjectStateConflict(
  payload: ProjectStateResolvePayload,
): Promise<ProjectStateResolveResult> {
  const job = await getPlanMirrorQueue().add(PLAN_MIRROR_JOB_NAMES.RESOLVE_PROJECT_STATE, payload, {
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  return job.waitUntilFinished(
    getPlanMirrorQueueEvents(),
    60_000,
  ) as Promise<ProjectStateResolveResult>;
}
