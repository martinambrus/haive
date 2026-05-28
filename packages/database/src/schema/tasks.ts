import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  doublePrecision,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth.js';
import { repositories } from './repos.js';
import { cliProviders } from './cli-providers.js';
import { envTemplates } from './env.js';
import { containers } from './containers.js';

/**
 * Structured hint payload stored in `task_steps.error_hint`. Mirror of the
 * `StepErrorHint` union in `@haive/shared`; duplicated here to keep
 * `@haive/database` free of a reverse dependency on shared (shared already
 * depends on database via the secrets services).
 */
type TaskStepErrorHint = { type: 'cli_login_required'; providerId: string; providerName: string };

export const cliInvocationModeEnum = pgEnum('cli_invocation_mode', [
  'cli',
  'subagent_emulated',
  'agent_mining',
]);

// 'env_replicate' kept in pgEnum for backward compat with existing DB rows.
// It is no longer a user-facing type — env-replicate steps run as a mandatory
// prelude for workflow tasks. The TS WorkflowType union enforces 'onboarding' | 'workflow'.
export const workflowTypeEnum = pgEnum('workflow_type', [
  'onboarding',
  'workflow',
  'env_replicate',
  'onboarding_upgrade',
]);
export const taskStatusEnum = pgEnum('task_status', [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'completed',
  'failed',
  'cancelled',
]);
export const stepStatusEnum = pgEnum('step_status', [
  'pending',
  'running',
  'waiting_form',
  'waiting_cli',
  'done',
  'failed',
  'skipped',
]);

export const agentMiningStatusEnum = pgEnum('agent_mining_status', [
  'pending',
  'running',
  'done',
  'failed',
]);

// --- Tasks ---------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'set null',
    }),
    envTemplateId: uuid('env_template_id').references(() => envTemplates.id, {
      onDelete: 'set null',
    }),
    type: workflowTypeEnum('type').notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('created'),
    currentStepId: varchar('current_step_id', { length: 128 }),
    currentStepIndex: doublePrecision('current_step_index').notNull().default(0),
    containerId: varchar('container_id', { length: 255 }),
    worktreePath: text('worktree_path'),
    memoryLimitMb: integer('memory_limit_mb'),
    cpuLimitMilli: integer('cpu_limit_milli'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** Per-task overrides for the maximum loop iterations a step can run.
     *  Map of stepId → maxIterations. The runner reads this when a step
     *  declares a loop hook and falls back to the loopSpec default when
     *  the step id is absent. Lets the new-task form pick a budget per
     *  loop step (e.g. spec-quality 5 instead of the default 10). */
    stepLoopLimits: jsonb('step_loop_limits')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('tasks_user_id_idx').on(table.userId),
    index('tasks_status_idx').on(table.status),
    index('tasks_repository_id_idx').on(table.repositoryId),
    index('tasks_env_template_id_idx').on(table.envTemplateId),
  ],
);

export const taskSteps = pgTable(
  'task_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: varchar('step_id', { length: 128 }).notNull(),
    stepIndex: doublePrecision('step_index').notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    status: stepStatusEnum('status').notNull().default('pending'),
    detectOutput: jsonb('detect_output').$type<unknown>(),
    formSchema: jsonb('form_schema').$type<unknown>(),
    formValues: jsonb('form_values').$type<Record<string, unknown>>(),
    output: jsonb('output').$type<unknown>(),
    /** Append-only history of every loop pass this step ran. Each entry
     *  records the LLM output (if any), the apply output, and whether the
     *  loop should still continue after that pass. Empty array on steps
     *  that don't declare a loop hook. */
    iterations: jsonb('iterations')
      .$type<StepIterationEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Mirror of jsonb_array_length(iterations) so the runner can branch
     *  on iteration count without parsing the JSONB blob. */
    iterationCount: integer('iteration_count').notNull().default(0),
    statusMessage: text('status_message'),
    errorMessage: text('error_message'),
    errorHint: jsonb('error_hint').$type<TaskStepErrorHint>(),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_steps_task_id_idx').on(table.taskId),
    uniqueIndex('task_steps_task_step_idx').on(table.taskId, table.stepId),
  ],
);

export interface StepIterationEntry {
  iteration: number;
  llmOutput: unknown;
  applyOutput: unknown;
  /** True when the loop's shouldContinue predicate was still true after
   *  this pass — meaning another pass would have run if budget remained.
   *  False on the final pass (either shouldContinue returned false or the
   *  iteration budget was exhausted). */
  continueRequested: boolean;
  /** Set on the LAST iteration when shouldContinue was still true but no
   *  more passes were attempted because the iteration budget was hit. The
   *  user-facing gate uses this to flag "loop budget exhausted, spec may
   *  still have findings". */
  exhaustedBudget?: boolean;
  recordedAt: string;
}

export const taskEvents = pgTable(
  'task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskStepId: uuid('task_step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_events_task_id_idx').on(table.taskId),
    index('task_events_event_type_idx').on(table.eventType),
  ],
);

export const taskUserInputs = pgTable(
  'task_user_inputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskStepId: uuid('task_step_id')
      .notNull()
      .references(() => taskSteps.id, { onDelete: 'cascade' }),
    questionId: varchar('question_id', { length: 128 }).notNull(),
    answerType: varchar('answer_type', { length: 32 }).notNull(),
    answerValue: jsonb('answer_value').$type<unknown>(),
    answeredAt: timestamp('answered_at').notNull().defaultNow(),
  },
  (table) => [index('task_user_inputs_task_step_id_idx').on(table.taskStepId)],
);

export const taskStepAgentMinings = pgTable(
  'task_step_agent_minings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskStepId: uuid('task_step_id')
      .notNull()
      .references(() => taskSteps.id, { onDelete: 'cascade' }),
    agentId: varchar('agent_id', { length: 128 }).notNull(),
    agentTitle: varchar('agent_title', { length: 256 }),
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'set null',
    }),
    status: agentMiningStatusEnum('status').notNull().default('pending'),
    cliInvocationId: uuid('cli_invocation_id'),
    output: jsonb('output').$type<unknown>(),
    rawOutput: text('raw_output'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_step_agent_minings_task_step_id_idx').on(table.taskStepId),
    uniqueIndex('task_step_agent_minings_step_agent_idx').on(table.taskStepId, table.agentId),
  ],
);

// --- CLI Invocations -----------------------------------------------------

export const cliInvocations = pgTable(
  'cli_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskStepId: uuid('task_step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'set null',
    }),
    mode: cliInvocationModeEnum('mode').notNull(),
    prompt: text('prompt').notNull(),
    envVars: jsonb('env_vars').$type<Record<string, string>>(),
    exitCode: integer('exit_code'),
    rawOutput: text('raw_output'),
    /** Full live-stream transcript: command header + every stdout/stderr
     *  chunk + the final exit annotation, exactly as the cli-stream WS
     *  delivered them. Used by the inline per-step terminal viewer for
     *  historical replay. Null on rows written before this column was
     *  added; consumers should fall back to rawOutput in that case. */
    streamLog: text('stream_log'),
    /** Set when the step-runner has incorporated this invocation's output
     *  into an apply pass. resolveLlmPhase ignores consumed rows so the
     *  next pass enqueues a fresh invocation. Null = pending or in-flight. */
    consumedAt: timestamp('consumed_at'),
    parsedOutput: jsonb('parsed_output').$type<unknown>(),
    tokenUsage: jsonb('token_usage').$type<{
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>(),
    durationMs: integer('duration_ms'),
    containerId: varchar('container_id', { length: 255 }),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    supersededAt: timestamp('superseded_at'),
  },
  (table) => [
    index('cli_invocations_task_id_idx').on(table.taskId),
    index('cli_invocations_task_step_id_idx').on(table.taskStepId),
  ],
);

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  user: one(users, { fields: [tasks.userId], references: [users.id] }),
  repository: one(repositories, {
    fields: [tasks.repositoryId],
    references: [repositories.id],
  }),
  cliProvider: one(cliProviders, {
    fields: [tasks.cliProviderId],
    references: [cliProviders.id],
  }),
  envTemplate: one(envTemplates, {
    fields: [tasks.envTemplateId],
    references: [envTemplates.id],
  }),
  steps: many(taskSteps),
  events: many(taskEvents),
  invocations: many(cliInvocations),
  containers: many(containers),
}));

export const taskStepsRelations = relations(taskSteps, ({ one, many }) => ({
  task: one(tasks, { fields: [taskSteps.taskId], references: [tasks.id] }),
  events: many(taskEvents),
  userInputs: many(taskUserInputs),
  invocations: many(cliInvocations),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, { fields: [taskEvents.taskId], references: [tasks.id] }),
  step: one(taskSteps, { fields: [taskEvents.taskStepId], references: [taskSteps.id] }),
}));

export const taskUserInputsRelations = relations(taskUserInputs, ({ one }) => ({
  step: one(taskSteps, { fields: [taskUserInputs.taskStepId], references: [taskSteps.id] }),
}));

export const cliInvocationsRelations = relations(cliInvocations, ({ one }) => ({
  task: one(tasks, { fields: [cliInvocations.taskId], references: [tasks.id] }),
  step: one(taskSteps, { fields: [cliInvocations.taskStepId], references: [taskSteps.id] }),
  cliProvider: one(cliProviders, {
    fields: [cliInvocations.cliProviderId],
    references: [cliProviders.id],
  }),
}));
