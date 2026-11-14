import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tasks, taskSteps } from './tasks.js';

export type CheckSlot = 'test' | 'lint' | 'php_lint' | 'typecheck';
export type CheckOutcome = 'running' | 'passed' | 'failed' | 'not_run' | 'interrupted';

// Measurements only: never store command text or output from a repository.
export const taskCheckRuns = pgTable(
  'task_check_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskStepId: uuid('task_step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    stepId: text('step_id').notNull(),
    slot: text('slot').$type<CheckSlot>().notNull(),
    attemptId: text('attempt_id').notNull(),
    outcome: text('outcome').$type<CheckOutcome>().notNull(),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    endedAt: timestamp('ended_at'),
  },
  (t) => [
    check(
      'task_check_runs_slot_check',
      sql`${t.slot} in ('test', 'lint', 'php_lint', 'typecheck')`,
    ),
    check(
      'task_check_runs_outcome_check',
      sql`${t.outcome} in ('running', 'passed', 'failed', 'not_run', 'interrupted')`,
    ),
    unique('task_check_runs_attempt_unique').on(t.taskId, t.stepId, t.slot, t.attemptId),
    index('task_check_runs_task_id_idx').on(t.taskId),
    index('task_check_runs_task_step_id_idx').on(t.taskStepId),
  ],
);

/** Seeded once by 0239; independent of retained tasks and never derived from their rows. */
export const taskCheckRecording = pgTable(
  'task_check_recording',
  {
    id: integer('id').primaryKey(),
    startedAt: timestamp('started_at').notNull().defaultNow(),
  },
  (t) => [check('task_check_recording_singleton', sql`${t.id} = 1`)],
);
