import { and, asc, eq } from 'drizzle-orm';
import { schema, type MergeResolveState } from '@haive/database';
import { MERGE_LANDED_EVENT, readLandedMerge } from '@haive/shared/merge-left-open';
import { revParse } from './git-merge.js';
import type { DbHandle } from './merge-dir-claim.js';
import { StepSupersededError, updateOwnedStep } from './step-ownership.js';

/** Called inside the section that commits the merge (and its replacement squash). The event
 * survives step resets. A cancel can take the step while git runs: keep the landed fact and
 * leave that cancelled step untouched, rather than rolling the fact back with an ownership error.
 * Other errors must fail the section. No git history is changed here. */
export async function recordLandedMerge(
  tx: DbHandle,
  args: {
    taskId: string;
    stepId: string;
    stepKey: string;
    repoPath: string;
    state: MergeResolveState;
  },
): Promise<void> {
  const { taskId, stepId, stepKey, repoPath, state } = args;
  let factRecorded = false;
  if (stepKey === '12-worktree-cleanup' && state.baseShaBefore) {
    const after = await revParse(repoPath, `refs/heads/${state.baseBranch}^{commit}`);
    if (!after)
      throw new Error(
        `Cannot record the landed merge on ${state.baseBranch}: base tip unavailable`,
      );
    if (after !== state.baseShaBefore) {
      const previous = await tx
        .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, MERGE_LANDED_EVENT),
          ),
        )
        .orderBy(asc(schema.taskEvents.createdAt));
      const sameMerge = previous
        .map((e) => readLandedMerge(e.payload))
        .filter(
          (m) =>
            m !== null &&
            m.baseShaBefore === state.baseShaBefore &&
            m.landedOn === state.baseBranch,
        );
      if (!sameMerge.some((m) => m?.baseShaAfter === after))
        await tx.insert(schema.taskEvents).values({
          taskId,
          taskStepId: stepId,
          eventType: MERGE_LANDED_EVENT,
          payload: {
            baseShaBefore: state.baseShaBefore,
            baseShaAfter: after,
            landedOn: state.baseBranch,
            landedAt: sameMerge[0]?.landedAt ?? new Date().toISOString(),
            repoPath,
            dir: state.mergeDir,
          },
        });
      factRecorded = true;
    }
  }
  try {
    await updateOwnedStep(tx, stepId, { mergeResolveState: state });
  } catch (error) {
    if (!factRecorded || !(error instanceof StepSupersededError)) throw error;
  }
}
