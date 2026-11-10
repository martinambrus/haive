import { and, eq } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';

export interface MergeDirHolder {
  id: string;
  title: string;
}

/** The task a claim holds the dir for, or null once the claim is stale: its task completed, its
 *  step skipped (a stale merge), or the task cancelled with its teardown recorded
 *  (`task.cancel_finished`: a CANCEL writes it after the release, an abandoned one before it). */
export async function liveClaimHolder(
  tx: Database | DbTx,
  claim: { taskId: string; taskStepId: string },
): Promise<MergeDirHolder | null> {
  const [holder] = await tx
    .select({
      title: schema.tasks.title,
      taskStatus: schema.tasks.status,
      stepStatus: schema.taskSteps.status,
    })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(eq(schema.taskSteps.id, claim.taskStepId));
  const [tornDown] =
    holder?.taskStatus === 'cancelled'
      ? await tx
          .select({ id: schema.taskEvents.id })
          .from(schema.taskEvents)
          .where(
            and(
              eq(schema.taskEvents.taskId, claim.taskId),
              eq(schema.taskEvents.eventType, 'task.cancel_finished'),
            ),
          )
          .limit(1)
      : [];
  if (holder && holder.taskStatus !== 'completed' && holder.stepStatus !== 'skipped' && !tornDown) {
    return { id: claim.taskId, title: holder.title };
  }
  return null;
}
