import { and, eq, notInArray } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';

type TaskStepRow = typeof schema.taskSteps.$inferSelect;
type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

const owned = (id: string) =>
  and(eq(schema.taskSteps.id, id), notInArray(schema.taskSteps.status, ['pending', 'skipped']));

/** A pass lost its row: a Retry or a Skip that arrived meanwhile left it `pending` or `skipped`. */
export class StepSupersededError extends Error {
  constructor(id: string) {
    super(`task step ${id} was reset or skipped while this pass ran`);
    this.name = 'StepSupersededError';
  }
}

/** Every write a pass makes to its row. It lands only while the row is still the pass's own, not
 *  `pending` (a Retry reset it) or `skipped` (a Skip took it); otherwise it throws
 *  StepSupersededError, which `advanceStep` turns into `superseded`. */
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
 *  Retry or a Skip took it. A Retry writes the steps before the task's epoch, so a hand-off fenced
 *  on the epoch alone can land inside one. */
export async function lockOwnedStep(db: Database | DbHandle, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.taskSteps.id })
    .from(schema.taskSteps)
    .where(owned(id))
    .for('update');
  return rows.length > 0;
}
