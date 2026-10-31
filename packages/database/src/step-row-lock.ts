import type { SQL } from 'drizzle-orm';
import * as schema from './schema/index.js';
import type { DbTx } from './task-attachments-lock.js';

/** Lock the task_steps rows `where` matches in one id-ordered batch, and answer them as
 *  `{ id, taskId }`.
 *
 *  `task_steps.id` is a random uuid, so two transactions that lock overlapping rows of one task in
 *  the order their caller lists them, or their statement scans them, hold one row each and want the
 *  other's (40P01). Every multi-row writer takes the rows it will write through here first, so they
 *  all wait in the same order. FOR NO KEY UPDATE is the lock an UPDATE takes anyway: it conflicts
 *  with every other writer but not with a child insert's KEY SHARE, which FOR UPDATE would.
 *
 *  Where it goes: after the transaction's cli_invocations, agent-mining and DAG statements and before
 *  its first step-row write (a pass locks a run and then its step row), and never as a blocking wait
 *  once the task row has been written (a pass holding a step row waits for the task row).
 *
 *  A row created after the batch is not held. A writer that holds the task row across a bulk UPDATE
 *  bounds that UPDATE to the ids answered here (`cancelStillOpen`), or the UPDATE locks the new row
 *  in scan order while a claim of it, holding it, waits for the task row. */
export async function lockStepRows(
  tx: DbTx,
  where: SQL | undefined,
): Promise<Array<{ id: string; taskId: string }>> {
  return tx
    .select({ id: schema.taskSteps.id, taskId: schema.taskSteps.taskId })
    .from(schema.taskSteps)
    .where(where)
    .orderBy(schema.taskSteps.id)
    .for('no key update');
}
