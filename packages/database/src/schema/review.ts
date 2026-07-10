import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tasks, taskSteps, cliInvocations } from './tasks.js';

/**
 * Durable, queryable review findings.
 *
 * Findings previously lived only inside `task_steps.output` jsonb. Fix-loop rounds
 * preserved them (each round gets its own step row), but a manual retry nulls that
 * column via `resetStepAndDownstream`, and nothing recorded what became of a
 * finding — whether it was fixed, dismissed by the developer, or shipped. Without
 * that, no change to the reviewers can be shown to have helped.
 *
 * Writes are BEST-EFFORT: a telemetry insert must never fail a review step. Nothing
 * in the pipeline reads this table to make a decision.
 */

/** Keep in sync with `ReviewSeverity` in @haive/shared/review — this package cannot
 *  import shared (circular; see the CliTokenUsage note in tasks.ts). */
export const reviewSeverityEnum = pgEnum('review_severity', ['critical', 'high', 'medium', 'low']);

/** What became of a finding after it was raised.
 *  - open: raised, not yet resolved either way.
 *  - fixed: a later round of the same reviewer no longer raises it.
 *  - recurred: raised again in a later round after being seen before.
 *  - dismissed_human: the developer accepted it at 08d2 or approved past it at gate 2.
 *  - dismissed_refuted: a refutation pass could not substantiate it.
 *  - accepted_risk: the fix-loop cap was reached and the developer accepted the remainder. */
export const reviewFindingDispositionEnum = pgEnum('review_finding_disposition', [
  'open',
  'fixed',
  'recurred',
  'dismissed_human',
  'dismissed_refuted',
  'accepted_risk',
]);

export const reviewFindings = pgTable(
  'review_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Nullable + set null: a finding outlives the step row it came from, which is
     *  the whole point — `resetStepAndDownstream` must not erase the record. */
    taskStepId: uuid('task_step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    cliInvocationId: uuid('cli_invocation_id').references(() => cliInvocations.id, {
      onDelete: 'set null',
    }),
    /** Step that raised it, e.g. '08c-code-review'. */
    stepId: varchar('step_id', { length: 128 }).notNull(),
    /** Fix-loop round the finding was raised in. */
    round: integer('round').notNull().default(0),
    /** Which reviewer raised it: 'peer-reviewer', 'security-code-reviewer', an
     *  adversary id, 'validator', or the auditing step's own id. */
    reviewerId: varchar('reviewer_id', { length: 128 }).notNull(),
    severity: reviewSeverityEnum('severity').notNull(),
    path: text('path'),
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),
    issue: text('issue').notNull(),
    fix: text('fix'),
    /** sha256 of (reviewerId, path, normalised issue). Identifies "the same finding"
     *  across rounds so recurrence and resolution can be detected. */
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    /** Whether this finding contributed to the step's blocking decision. */
    blocking: boolean('blocking').notNull().default(false),
    disposition: reviewFindingDispositionEnum('disposition').notNull().default('open'),
    dispositionAt: timestamp('disposition_at'),
    /** What set the disposition: a step id, 'fix_loop', or 'refuter'. */
    dispositionSource: varchar('disposition_source', { length: 128 }),
    /** The finding as the reviewer emitted it, for fields this table does not model
     *  (cwe, attack, poc, snippet, dimension). */
    raw: jsonb('raw').$type<unknown>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('review_findings_task_id_idx').on(table.taskId),
    index('review_findings_task_fingerprint_idx').on(table.taskId, table.fingerprint),
    index('review_findings_task_step_id_idx').on(table.taskStepId),
    // One row per finding per step row. A step's apply() can run more than once for
    // the same round -- 07b loops validator/fixer passes, and a mining retry re-runs
    // apply() after re-rolling one agent -- so writers insert with onConflictDoNothing
    // and let the same finding re-raised within one step row collapse onto one row.
    uniqueIndex('review_findings_dedupe_idx').on(
      table.taskId,
      table.taskStepId,
      table.round,
      table.fingerprint,
    ),
  ],
);

export const reviewFindingsRelations = relations(reviewFindings, ({ one }) => ({
  task: one(tasks, { fields: [reviewFindings.taskId], references: [tasks.id] }),
  taskStep: one(taskSteps, { fields: [reviewFindings.taskStepId], references: [taskSteps.id] }),
  cliInvocation: one(cliInvocations, {
    fields: [reviewFindings.cliInvocationId],
    references: [cliInvocations.id],
  }),
}));
