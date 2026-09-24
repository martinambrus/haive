import { and, eq, notInArray } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';

type TaskStepRow = typeof schema.taskSteps.$inferSelect;

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
  db: Database,
  id: string,
  patch: PgUpdateSetSource<typeof schema.taskSteps>,
): Promise<TaskStepRow> {
  const rows = await db
    .update(schema.taskSteps)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(schema.taskSteps.id, id), notInArray(schema.taskSteps.status, ['pending', 'skipped'])),
    )
    .returning();
  const row = rows[0];
  if (!row) throw new StepSupersededError(id);
  return row;
}
