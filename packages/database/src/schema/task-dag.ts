import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { tasks, taskSteps } from './tasks.js';

/**
 * Phase 2c sprint-planning decision + Phase 3 DAG execution state. All of it
 * persists here so the single DAG-executor step (06c) is crash-recoverable:
 * every ADVANCE_STEP re-entry derives its next action purely from these rows
 * (the current level = the lowest level whose `checkpointed_at` is null), the
 * same way the agent-mining fan-out derives results from task_step_agent_minings.
 *
 * Columns the executor only WRITES in later slices (inner review, escalation,
 * merge) are reserved here so the executor's resume tree can read them as no-ops
 * from Slice 3 without further migrations.
 */

export const dagIssueOutcomeEnum = pgEnum('dag_issue_outcome', [
  'pending',
  'running',
  'completed',
  'completed_with_debt',
  'failed_unrecoverable',
]);

export const dagAgentRoleEnum = pgEnum('dag_agent_role', [
  'coder',
  'reviewer',
  'issue_advisor',
  'replanner',
]);

// --- Plan (one row per 2c decision) --------------------------------------

export const taskDagPlans = pgTable(
  'task_dag_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** The 06b-sprint-planning task_steps row that produced this plan. */
    taskStepId: uuid('task_step_id')
      .notNull()
      .references(() => taskSteps.id, { onDelete: 'cascade' }),
    /** 'single' (the existing single-agent implement) or 'dag' (parallel). */
    mode: varchar('mode', { length: 16 }).notNull(),
    rationale: text('rationale'),
    /** Planner's max_parallel; the executor clamps live fan-out by
     *  min(this, the admin MAX_PARALLEL_AGENTS cap). */
    maxParallel: integer('max_parallel').notNull().default(1),
    /** Dependency waves: array-of-arrays of issueKeys (legacy `levels`). */
    levels: jsonb('levels')
      .$type<string[][]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Per-role model map chosen at the gate (coder/reviewer/issue_advisor/
     *  replanner/merger). Consumed by the escalation slices. */
    modelMap: jsonb('model_map')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Full raw planner JSON, for audit + replanning. */
    planJson: jsonb('plan_json').$type<unknown>(),
    /** Bumped each time the gate's "Modify Plan" re-runs the planner. */
    replanCount: integer('replan_count').notNull().default(0),
    /** When true, 06c auto-dispatches the LLM merge-fix agent for every
     *  conflicting branch and loops (bounded) until all merge — instead of
     *  halting for a manual "Retry with LLM". Chosen at the 2c gate. */
    autoResolveConflicts: boolean('auto_resolve_conflicts').notNull().default(false),
    /** When true, each issue's implementation is reviewed by a reviewer agent
     *  (coder<->reviewer inner loop) before merge. Chosen at the 2c gate. */
    reviewEnabled: boolean('review_enabled').notNull().default(false),
    // --- Outer-loop escalation (replanner) + debt aggregate (Slice 6) ---
    replannerInvocations: integer('replanner_invocations').notNull().default(0),
    lastReplannerAction: varchar('last_replanner_action', { length: 32 }),
    /** Active replanner invocation while one is in flight (plan-level agent). */
    replannerInvocationId: uuid('replanner_invocation_id'),
    escalationLog: jsonb('escalation_log')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    debtAggregate: jsonb('debt_aggregate')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_dag_plans_task_id_idx').on(table.taskId),
    uniqueIndex('task_dag_plans_task_step_idx').on(table.taskStepId),
  ],
);

// --- Levels (one row per dependency wave; the checkpoint cursor) ----------

export const taskDagLevels = pgTable(
  'task_dag_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dagPlanId: uuid('dag_plan_id')
      .notNull()
      .references(() => taskDagPlans.id, { onDelete: 'cascade' }),
    level: integer('level').notNull(),
    issueKeys: jsonb('issue_keys')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Executor cursor for this wave: pending | worktrees_ready | coding |
     *  coded | reviewing | merging | checkpointed. */
    phase: varchar('phase', { length: 32 }).notNull().default('pending'),
    /** Reserved (Slice 4): per-branch merge state for this level. */
    mergeState: jsonb('merge_state').$type<unknown>(),
    /** Set when the level is fully done — the crash-recovery resume anchor. */
    checkpointedAt: timestamp('checkpointed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_dag_levels_plan_id_idx').on(table.dagPlanId),
    uniqueIndex('task_dag_levels_plan_level_idx').on(table.dagPlanId, table.level),
  ],
);

// --- Issues (one row per issue; the per-coder barrier row) ----------------

export const taskDagIssues = pgTable(
  'task_dag_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dagPlanId: uuid('dag_plan_id')
      .notNull()
      .references(() => taskDagPlans.id, { onDelete: 'cascade' }),
    /** Denormalized for direct task-scoped lookups (mirrors cli_invocations). */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    issueKey: varchar('issue_key', { length: 64 }).notNull(),
    level: integer('level').notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    specSections: jsonb('spec_sections')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    acceptanceCriteria: jsonb('acceptance_criteria')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependsOn: jsonb('depends_on')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    estimatedFiles: jsonb('estimated_files')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    provides: text('provides'),
    guidance: jsonb('guidance').$type<Record<string, unknown>>(),
    // --- Per-coder worktree (set by the executor at fan-out) ---
    worktreePath: text('worktree_path'),
    sandboxWorktreePath: text('sandbox_worktree_path'),
    branchName: varchar('branch_name', { length: 256 }),
    // --- Execution tracking (the barrier row) ---
    outcome: dagIssueOutcomeEnum('outcome').notNull().default('pending'),
    cliInvocationId: uuid('cli_invocation_id'),
    filesModified: jsonb('files_modified')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    debtItems: jsonb('debt_items')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    concerns: text('concerns'),
    rawOutput: text('raw_output'),
    errorMessage: text('error_message'),
    // --- Reserved: inner review loop (Slice 5) ---
    reviewStatus: varchar('review_status', { length: 32 }),
    innerIteration: integer('inner_iteration').notNull().default(0),
    stuckCount: integer('stuck_count').notNull().default(0),
    reviewerVerdict: jsonb('reviewer_verdict').$type<unknown>(),
    // --- Reserved: middle/outer escalation (Slice 6) ---
    advisorInvocations: integer('advisor_invocations').notNull().default(0),
    lastAdvisorAction: varchar('last_advisor_action', { length: 32 }),
    retryContext: jsonb('retry_context').$type<unknown>(),
    /** Parent issue id when an advisor SPLIT spawned this sub-issue (plain id,
     *  no FK — mirrors cli_invocation_id on task_step_agent_minings). */
    parentIssueId: uuid('parent_issue_id'),
    resolution: varchar('resolution', { length: 32 }),
    // --- Reserved: merge (Slice 4) ---
    mergeStatus: varchar('merge_status', { length: 32 }),
    mergedAt: timestamp('merged_at'),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_dag_issues_plan_id_idx').on(table.dagPlanId),
    index('task_dag_issues_task_level_idx').on(table.taskId, table.level),
    uniqueIndex('task_dag_issues_plan_issue_idx').on(table.dagPlanId, table.issueKey),
  ],
);

// --- Agent runs (per-issue reviewer / fix-coder / advisor / replanner) --------

export const dagAgentRuns = pgTable(
  'dag_agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dagIssueId: uuid('dag_issue_id')
      .notNull()
      .references(() => taskDagIssues.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    role: dagAgentRoleEnum('role').notNull(),
    /** Inner-loop iteration this run belongs to (0-based). */
    iteration: integer('iteration').notNull().default(0),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    cliInvocationId: uuid('cli_invocation_id'),
    output: jsonb('output').$type<unknown>(),
    rawOutput: text('raw_output'),
    /** Set when the executor has folded this run's result into the issue state. */
    consumedAt: timestamp('consumed_at'),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('dag_agent_runs_issue_idx').on(table.dagIssueId),
    index('dag_agent_runs_task_idx').on(table.taskId),
  ],
);

export const taskDagPlansRelations = relations(taskDagPlans, ({ one, many }) => ({
  task: one(tasks, { fields: [taskDagPlans.taskId], references: [tasks.id] }),
  step: one(taskSteps, { fields: [taskDagPlans.taskStepId], references: [taskSteps.id] }),
  levels: many(taskDagLevels),
  issues: many(taskDagIssues),
}));

export const taskDagLevelsRelations = relations(taskDagLevels, ({ one }) => ({
  plan: one(taskDagPlans, { fields: [taskDagLevels.dagPlanId], references: [taskDagPlans.id] }),
}));

export const taskDagIssuesRelations = relations(taskDagIssues, ({ one, many }) => ({
  plan: one(taskDagPlans, { fields: [taskDagIssues.dagPlanId], references: [taskDagPlans.id] }),
  task: one(tasks, { fields: [taskDagIssues.taskId], references: [tasks.id] }),
  agentRuns: many(dagAgentRuns),
}));

export const dagAgentRunsRelations = relations(dagAgentRuns, ({ one }) => ({
  issue: one(taskDagIssues, {
    fields: [dagAgentRuns.dagIssueId],
    references: [taskDagIssues.id],
  }),
}));
