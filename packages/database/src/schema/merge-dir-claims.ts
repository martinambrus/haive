import { pgTable, text, uuid, timestamp, index } from 'drizzle-orm/pg-core';
import { tasks, taskSteps } from './tasks.js';

/** The task step that owns a merge dir: taken before the first git write in it, released when its
 *  merge is done or its task is cancelled. One row per dir, so a second task cannot open there. */
export const mergeDirClaims = pgTable(
  'merge_dir_claims',
  {
    mergeDir: text('merge_dir').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskStepId: uuid('task_step_id')
      .notNull()
      .references(() => taskSteps.id, { onDelete: 'cascade' }),
    claimedAt: timestamp('claimed_at').notNull().defaultNow(),
  },
  (table) => [index('merge_dir_claims_task_id_idx').on(table.taskId)],
);
