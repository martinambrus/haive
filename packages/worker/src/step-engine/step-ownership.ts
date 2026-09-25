import { and, eq, notInArray } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';

type TaskStepRow = typeof schema.taskSteps.$inferSelect;
type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Statuses a task never comes back from. Cancel is the user's final word and completion is
 *  done; only `failed` is revivable (retry / allowance auto-resume). Every write that could flip
 *  a task back to running/waiting excludes these, so a stale job cannot raise the dead. */
export const TERMINAL_TASK_STATUSES = ['cancelled', 'completed'] as const;

/** A job's write to the task under the epoch the job holds. It lands only while the task is still
 *  at that epoch and has not failed since: a Stop fails a task without moving the epoch. A job may
 *  revive a task that was already failed when it picked it up (`reviveFailed`), which the pickup
 *  guard allows only for an answer to a form still parked, since answering it reopens the task. */
export interface TaskFence {
  epoch: number;
  reviveFailed?: boolean;
}

export function taskWriteTarget(taskId: string, fence?: TaskFence) {
  const refused = fence !== undefined && !fence.reviveFailed;
  return and(
    eq(schema.tasks.id, taskId),
    notInArray(schema.tasks.status, [
      ...TERMINAL_TASK_STATUSES,
      ...(refused ? (['failed'] as const) : []),
    ]),
    ...(fence ? [eq(schema.tasks.orchestrationEpoch, fence.epoch)] : []),
  );
}

const owned = (id: string) =>
  and(
    eq(schema.taskSteps.id, id),
    notInArray(schema.taskSteps.status, ['pending', 'skipped', 'failed']),
  );

/** A pass lost its row: a Retry, a Skip or a Stop that arrived meanwhile left it `pending`,
 *  `skipped` or `failed`. */
export class StepSupersededError extends Error {
  constructor(id: string) {
    super(`task step ${id} was reset, skipped or stopped while this pass ran`);
    this.name = 'StepSupersededError';
  }
}

/** Every write a pass makes to its row. It lands only while the row is still the pass's own, not
 *  `pending` (a Retry reset it), `skipped` (a Skip took it) or `failed` (a Stop or a cancel ended
 *  it, or the pass already failed it); otherwise it throws StepSupersededError, which
 *  `advanceStep` turns into `superseded`. */
export async function updateOwnedStep(
  db: Database | DbHandle,
  id: string,
  patch: PgUpdateSetSource<typeof schema.taskSteps>,
): Promise<TaskStepRow> {
  const rows = await db
    .update(schema.taskSteps)
    .set({ ...patch, updatedAt: new Date() })
    .where(owned(id))
    .returning();
  const row = rows[0];
  if (!row) throw new StepSupersededError(id);
  return row;
}

/** Hold a pass's row for the rest of a transaction while it is still the pass's own; false once a
 *  Retry, a Skip or a Stop took it. A Retry writes the steps before the task's epoch, so a hand-off
 *  fenced on the epoch alone can land inside one. */
export async function lockOwnedStep(db: Database | DbHandle, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.taskSteps.id })
    .from(schema.taskSteps)
    .where(owned(id))
    .for('update');
  return rows.length > 0;
}

/** A Retry or Resume supersedes a step's runs in the transaction that takes the step, so a pass
 *  that finds its own run superseded acts on it only while it still owns its row. */
export async function assertOwnsStep(db: Database | DbHandle, id: string): Promise<void> {
  if (!(await lockOwnedStep(db, id))) throw new StepSupersededError(id);
}

/** Record a run for a pass's own row, only while the row is still the pass's own. The insert goes
 *  before the lock, as a Retry takes runs before steps: it can wait on a run the Retry supersedes. */
export async function insertOwnedRun(
  db: Database | DbHandle,
  stepRowId: string,
  values: typeof schema.cliInvocations.$inferInsert,
): Promise<typeof schema.cliInvocations.$inferSelect> {
  return db.transaction(async (tx) => {
    const [run] = await tx.insert(schema.cliInvocations).values(values).returning();
    if (!run) throw new Error(`failed to insert a cli_invocations row for task step ${stepRowId}`);
    await assertOwnsStep(tx, stepRowId);
    return run;
  });
}

class ClaimOvertaken extends Error {}

/** Open a pass on its `pending` row (claim it, or skip it). With the job's epoch, the fence is read
 *  FOR SHARE after the flip, so a reset's uncommitted epoch bump holds it and then refuses it. */
export async function openPendingStep(
  db: Database,
  taskId: string,
  epoch: number | null | undefined,
  id: string,
  patch: PgUpdateSetSource<typeof schema.taskSteps>,
): Promise<TaskStepRow | null> {
  const flip = (h: Database | DbHandle) =>
    h
      .update(schema.taskSteps)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(schema.taskSteps.id, id), eq(schema.taskSteps.status, 'pending')))
      .returning();
  if (epoch == null) return (await flip(db))[0] ?? null;
  try {
    return await db.transaction(async (tx) => {
      const [claimed] = await flip(tx);
      if (!claimed) return null;
      const held = await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(taskWriteTarget(taskId, { epoch }))
        .for('share');
      if (held.length === 0) throw new ClaimOvertaken();
      return claimed;
    });
  } catch (err) {
    if (err instanceof ClaimOvertaken) return null;
    throw err;
  }
}
