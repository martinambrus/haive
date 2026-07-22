import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth.js';
import { repositories } from './repos.js';
import { dbUploads } from './db-dumps.js';
import { cliProviders } from './cli-providers.js';
import { envTemplates } from './env.js';
import { containers } from './containers.js';

/**
 * Structured hint payload stored in `task_steps.error_hint`. Mirror of the
 * `StepErrorHint` union in `@haive/shared`; duplicated here to keep
 * `@haive/database` free of a reverse dependency on shared (shared already
 * depends on database via the secrets services).
 */
type TaskStepErrorHint =
  | { type: 'cli_login_required'; providerId: string; providerName: string }
  | { type: 'local_model_destructive'; stepId: string; providerName: string }
  | {
      type: 'provider_unavailable';
      reason: 'rate_limit' | 'auth' | 'server_error';
      providerName?: string;
    };

export const cliInvocationModeEnum = pgEnum('cli_invocation_mode', [
  'cli',
  'subagent_emulated',
  'agent_mining',
  'dag_parallel',
]);

// 'env_replicate' kept in pgEnum for backward compat with existing DB rows.
// It is no longer a user-facing type — env-replicate steps run as a mandatory
// prelude for workflow tasks. The TS WorkflowType union enforces 'onboarding' | 'workflow'.
export const workflowTypeEnum = pgEnum('workflow_type', [
  'onboarding',
  'workflow',
  'env_replicate',
  'onboarding_upgrade',
  // Repo-anchored global-KB enrichment: expands a user skeleton into a
  // version-scoped global KB draft by reading the chosen repo (plan §5.1/§5.3).
  'kb_author',
  // Deterministic-first "run this repository": brings the per-task runtime up
  // (DDEV or app-runner) so the user can browse/test/edit the live app, then a
  // Finish button tears it all down. No implementation pipeline / triage.
  'run_app',
]);
export const taskStatusEnum = pgEnum('task_status', [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
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
    dbUploadId: uuid('db_upload_id').references(() => dbUploads.id, {
      onDelete: 'set null',
    }),
    /** Parent task this bug fix belongs to (one level only; the create handler
     *  flattens so this never points at another linked bug fix). Self-FK; set
     *  null on parent delete so deleting a feature un-links its bug fixes rather
     *  than cascading. Written only by the create path for workflow bug fixes. */
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),
    type: workflowTypeEnum('type').notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('created'),
    currentStepId: varchar('current_step_id', { length: 128 }),
    currentStepIndex: doublePrecision('current_step_index').notNull().default(0),
    containerId: varchar('container_id', { length: 255 }),
    /** Durable record of the feature worktree 01-worktree-setup created, written by
     *  that step's apply. The cancel reaper (removeTaskWorktree) used to read this
     *  from the step's `output`, which a Retry cascade nulls (_step-reset) while
     *  leaving the worktree on disk — so the worktree and its branch leaked. Task
     *  rows survive a step reset; step outputs do not. Left set on terminal tasks as
     *  an audit record. */
    worktreePath: text('worktree_path'),
    worktreeBranch: text('worktree_branch'),
    /** Durable record of the final workflow commit and the repo-relative paths it
     *  changed, written by 10-gate-3-commit apply. Both are computed today but only
     *  survive in step output (nulled by _step-reset) or a worktree artifact (deleted on
     *  cleanup); persisted on the task row so a completed task's touched-file set stays
     *  queryable after teardown — the anchor 00b-estimate uses to rank prior tasks by
     *  file overlap ("this feature touches files earlier tasks touched"). changed_paths
     *  is capped (MAX_PERSISTED_CHANGED_PATHS). Both NULL until the commit step runs, on
     *  legacy rows, and on a task that committed nothing. */
    commitSha: text('commit_sha'),
    changedPaths: jsonb('changed_paths').$type<string[]>(),
    /** Pull-request close-out (workflow tasks, opt-in via the 12-worktree-cleanup
     *  create_pr action; gated by CONFIG_KEYS.PR_WORKFLOW_ENABLED + the repo's
     *  pr_workflow_enabled). Durable on the task row — step output is nulled by
     *  _step-reset — so the 13-pr-wait park and the PR-status poller can read them.
     *  All NULL when no PR was opened; 13-pr-wait is then a no-op and the task
     *  completes normally. */
    prProvider: varchar('pr_provider', { length: 32 }),
    prUrl: text('pr_url'),
    /** The forge's PR identifier (GitHub/Gitea number, GitLab iid, Bitbucket id);
     *  text to cover every forge's id shape. */
    prNumber: text('pr_number'),
    /** 'open' | 'merged' | 'closed' (closed = declined without merging), tracked by
     *  the PR-status poller. */
    prState: text('pr_state'),
    prMergedAt: timestamp('pr_merged_at'),
    /** 'auto' | 'manual': auto-complete the task when the PR merges, or wait for a
     *  manual Finalize click. Chosen at PR-open on the 12-worktree-cleanup form. */
    prFinalizeMode: text('pr_finalize_mode'),
    /** Last PR-poll error (e.g. token lacks PR scope, host unreachable), surfaced in
     *  the 13-pr-wait UI; cleared on a successful poll. */
    prPollError: text('pr_poll_error'),
    /** The forge credential used to open the PR — the PR-status poller decrypts its
     *  token to read the PR state. Plain uuid (no FK) to avoid a tasks<->repos schema
     *  cycle; a deleted credential simply surfaces a poll error. */
    prCredentialId: uuid('pr_credential_id'),
    memoryLimitMb: integer('memory_limit_mb'),
    cpuLimitMilli: integer('cpu_limit_milli'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** Phase 3.5: run the AI code-simplification pass (07a-code-simplify) after
     *  implementation. Chosen on the new-task form; default off so existing
     *  tasks and direct-insert fixtures skip the step. */
    simplifyCode: boolean('simplify_code').notNull().default(false),
    /** Phase 7: adversarial QA level (08d-adversarial-qa). null/'none' = off;
     *  'poc'|'standard'|'enterprise' fan out 2/4/6 adversarial agents. Chosen on
     *  the new-task form; default off so existing tasks + fixtures skip the step. */
    adversarialQaLevel: text('adversarial_qa_level'),
    /** Broad audit (default ON): run the report-only broad spec audit (04a-spec-audit)
     *  and code audit (08c2-code-audit) on top of the narrow reviewers. Chosen on the
     *  00-triage form per the selected execution path (hidden + forced off for
     *  quick_bugfix, whose step set has neither audit) — read by 04a / 08c2 in their
     *  shouldRun gate. Per-task switch-off; default true so it runs unless opted out. */
    broadAudit: boolean('broad_audit').notNull().default(true),
    /** On-demand step-debugging: when true the per-task runtime is brought up with
     *  step-debugging wired (PHP/Xdebug under DDEV, JS via the VNC browser CDP, Node
     *  --inspect), so the Editor tab can attach. Chosen on the 01-debug-mode step
     *  (asked once before any runtime starts); default off so existing tasks and
     *  fixtures run with no debug overhead. Re-read at every runner start (survives
     *  warm-recover). Gated behind the global CONFIG_KEYS.DEBUG_MODE_ENABLED switch. */
    debugMode: boolean('debug_mode').notNull().default(false),
    /** Direct database access: when true the per-task DDEV runtime exposes the
     *  project's database on the loopback host port the runner reserved at start
     *  (a socat hop to the nested db container), so a local DB client can connect to
     *  127.0.0.1:<port>. Chosen on 06-run-config (workflow) / 98-choose-view (run_app);
     *  default off so a DB is never exposed without an explicit opt-in. Re-read at
     *  every runner bring-up. Gated behind the global CONFIG_KEYS.DB_DIRECT_ACCESS switch. */
    exposeDbPort: boolean('expose_db_port').notNull().default(false),
    /** Per-task direct browser access: when true the per-task runtime publishes its
     *  app to a loopback host port (DDEV also reconfigures its router to those custom
     *  ports), so the user opens the app in their OWN browser via the URLs the task
     *  surfaces. Chosen on 01b-browser-access (workflow) / 98-choose-view (run_app),
     *  BEFORE the runner boots; default false => DDEV stays on portless 80/443 and
     *  nothing is published (VNC-only), the robust default for apps that hard-code
     *  their own host. Re-read at every runner start (survives warm-recover). Gated
     *  behind the global CONFIG_KEYS.BROWSER_DIRECT_ACCESS kill-switch. */
    directAccess: boolean('direct_access').notNull().default(false),
    /** Allowance-back watch: set when a task FAILS on a provider rate-limit/quota
     *  (ProviderFatalClass.rate_limit) for a usage-readable CLI. Points at the depleted
     *  cli_provider so the usage poller knows which snapshot to watch. NULL = no watch.
     *  Cleared on replenishment (below) and on retry/resume/cancel. */
    awaitingAllowanceProviderId: uuid('awaiting_allowance_provider_id').references(
      () => cliProviders.id,
      { onDelete: 'set null' },
    ),
    /** The "blocked until" moment captured at arm time: the LATEST *_reset_at among the
     *  provider's windows that were >= EXHAUSTED_PCT in its usage snapshot. NULL when
     *  unknown (no snapshot yet, or a provider that exposes no reset, e.g. zai). */
    allowanceResetAt: timestamp('allowance_reset_at'),
    /** Stamped by the usage poller when the depleted allowance has replenished (the
     *  captured reset passed, or the snapshot's max consumed % fell below RECOVERED_PCT).
     *  Null -> set flip is the signal the web notifier diffs to fire the "allowance is
     *  back" browser notification. Cleared on retry/resume/cancel so a re-failure re-arms. */
    allowanceReplenishedAt: timestamp('allowance_replenished_at'),
    /** Consecutive auto-resumes the allowance poller has performed on this task (only when
     *  CONFIG_KEYS.AUTO_RESUME_ON_ALLOWANCE is on). Anti-thrash cap: at ALLOWANCE_AUTO_RESUME_CAP
     *  the poller falls back to notify-only. Reset to 0 on any manual action and on the next
     *  successful step progress, so only a run of back-to-back auto-resumes counts. */
    allowanceAutoResumeCount: integer('allowance_auto_resume_count').notNull().default(0),
    /** Stamped by the poller when it AUTO-resumes a task whose allowance came back (distinct
     *  from allowanceReplenishedAt, which is the notify-only "ready to retry" signal). Null ->
     *  set flip is what the web diffs to fire the "auto-resumed" notification. */
    allowanceAutoResumedAt: timestamp('allowance_auto_resumed_at'),
    /** Developer's estimated time to complete the task, in decimal hours
     *  (e.g. 0.25, 0.5, 1, 1.5). Optional, set on the new-task form; compared
     *  against the actual effort (agent work + user-active time) in the task
     *  header and a footer verdict card. NULL = no estimate; the comparison
     *  surfaces stay hidden. doublePrecision so it round-trips as a JS number. */
    estimatedTimeHours: doublePrecision('estimated_time_hours'),
    /** The AI's learned effort estimate (decimal hours), written by 00b-estimate from
     *  the repository's prior completed tasks and their MEASURED effort. Kept SEPARATE
     *  from the human/confirmed estimatedTimeHours (the 00b form defaults to this value
     *  and the user may accept or override it) so AI accuracy stays measurable against
     *  actual effort over time — that (aiEstimate, actual) pair is the calibration
     *  signal 00b feeds itself. NULL until 00b runs, and on legacy rows. */
    aiEstimatedTimeHours: doublePrecision('ai_estimated_time_hours'),
    /** Low/high effort band (decimal hours) around the AI estimate, from the spread of
     *  the anchor tasks' actual effort (p20/p80). Both NULL until 00b-estimate runs with
     *  enough anchors, and on legacy rows. Shown as a confidence range on the verdict
     *  card; the point estimate stays ai_estimated_time_hours. */
    aiEstimateLowHours: doublePrecision('ai_estimate_low_hours'),
    aiEstimateHighHours: doublePrecision('ai_estimate_high_hours'),
    /** Execution path chosen by the 00-triage step: 'quick_bugfix' | 'plan_tasklist'
     *  | 'full_workflow'. NULL until triage records it (and on legacy rows); buildRunList
     *  runs the full workflow when unset, and trims the workflow step list to the chosen
     *  path once set. Workflow tasks only — onboarding never reaches triage. */
    executionPath: varchar('execution_path', { length: 32 }),
    /** Per-task overrides for the maximum loop iterations a step can run.
     *  Map of stepId → maxIterations. The runner reads this when a step
     *  declares a loop hook and falls back to the loopSpec default when
     *  the step id is absent. Lets the new-task form pick a budget per
     *  loop step (e.g. spec-quality 5 instead of the default 10). */
    stepLoopLimits: jsonb('step_loop_limits')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Auto-continue: when true (default) the runner auto-submits info-only
     *  forms and the run-config pre-answers so the workflow runs hands-free
     *  between gates; when false EVERY step pauses for a Continue confirmation. */
    autoContinue: boolean('auto_continue').notNull().default(true),
    /** Per-task "use my chosen CLI for all steps" toggle (New Task form). When
     *  true, the step-CLI resolver + UI ignore the user's pre-existing saved
     *  per-step CLI prefs and default every step to this task's cli_provider_id;
     *  a step the user explicitly changes during the task is recorded in
     *  task_step_cli_touched and honored. Default false = today's behavior. */
    ignoreSavedStepClis: boolean('ignore_saved_step_clis').notNull().default(false),
    /** "Run configuration" answers applied to later steps' forms.
     *  Record<stepId, Record<fieldId, value>>. Written by 06-run-config apply();
     *  null until a task's run-config step records them. */
    preAnswers: jsonb('pre_answers').$type<Record<string, Record<string, unknown>>>(),
    /** Fix-loop: the round new step rows are materialized at (0 = original pass);
     *  bumped each time a blocking defect re-enters at 07-implement. */
    currentRound: integer('current_round').notNull().default(0),
    /** Per-task cap on automatic fix rounds before escalating to the user. Set on
     *  the Gate-1 run-config form; default 5. */
    maxFixRounds: integer('max_fix_rounds').notNull().default(5),
    /** Orchestration generation. Bumped by every retry/reset re-drive so any
     *  advance-step job enqueued under an older epoch is skipped as stale — closing
     *  the same-step concurrency race a retry-while-active otherwise triggers. */
    orchestrationEpoch: integer('orchestration_epoch').notNull().default(0),
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
    index('tasks_parent_task_id_idx').on(table.parentTaskId),
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
    /** Display-only ordering key: the step's position in the task's run list
     *  (buildRunList) at the time it was advanced. Unlike step_index (a global
     *  offset+metadata.index that is NOT monotonic with run order for steps reused
     *  across task types — the env_replicate prelude in a workflow, run_app's
     *  choose-view/env steps), run_seq always matches true run order, so the step
     *  list sorts by (round, run_seq). Nullable: stamped by the worker on advance
     *  and backfilled on boot; legacy rows fall back to created_at ordering. */
    runSeq: integer('run_seq'),
    /** Fix-loop round (0 = original pass). A blocking downstream defect re-enters
     *  at 07-implement and re-runs the chain as round+1; each round materializes
     *  its own rows. Unique per (task_id, step_id, round). */
    round: integer('round').notNull().default(0),
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
    /** Non-fatal advisory shown as a standalone amber banner on the step (during
     *  and after the run), separate from the last-writer-wins status_message so a
     *  per-file progress line can't bury it. Set e.g. when RAG embeddings fall back
     *  to CPU because the GPU is unavailable. Null = no warning. */
    warningMessage: text('warning_message'),
    /** Human-readable recap of what this step's LLM agent did, shown as the
     *  collapsible "What the agent did" panel on the done card. Populated from
     *  the apply output's curated summary (findingsSummary/summary/notes) when
     *  present, else by a best-effort async LLM summarizer. Null on steps that
     *  ran no agent (deterministic-only) or before the summary lands. */
    summary: text('summary'),
    errorMessage: text('error_message'),
    errorHint: jsonb('error_hint').$type<TaskStepErrorHint>(),
    /** Non-fatal advisory: set when a step's LLM output could not be parsed and the
     *  step silently fell back to a deterministic stub (source stub/salvage/fallback).
     *  The step status still finalizes as 'done'; the UI shows this as an amber banner
     *  so a weak-but-alive model's degraded output is visible instead of hidden. */
    degradedNote: text('degraded_note'),
    /** Set by the retry_ai action: the prior failure context for the
     *  diagnose-and-fix agent. The step-runner dispatches a fix agent when this
     *  is present, then clears it and re-runs apply against the fixed workspace. */
    aiFixContext: jsonb('ai_fix_context').$type<{ priorError: string; priorOutput: string }>(),
    /** Persisted state machine for the merge-resolution phase (resolveMergePhase),
     *  the 12-worktree-cleanup analogue of task_dag_levels.merge_state. Null until
     *  the merge phase first runs; left 'done' (or cleared) once the merge commits.
     *  Every ADVANCE_STEP re-entry is a pure function of this + on-disk git state so
     *  a crash + redelivery resumes correctly. jsonb, so the shape can evolve without
     *  a migration. */
    mergeResolveState: jsonb('merge_resolve_state').$type<MergeResolveState>(),
    /** Set true by the "Override and run" UI action (retry + overrideLocalModel):
     *  lets enforceLocalModelGuard bypass the unsafe-for-local-models block for
     *  THIS step, so a user without server shell access can run a destructive step
     *  on a local Ollama model without the ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS env
     *  flag. Per-step; a plain Retry resets it to false (re-arms the guard). */
    localModelOverride: boolean('local_model_override').notNull().default(false),
    /** One-shot marker set by a plain Retry (never "Override and run"): make this
     *  step STOP at its form on the retry even under auto-continue, so the user can
     *  inspect and edit a form that would otherwise auto-submit (autoSubmitDefaults /
     *  form autoSubmit / gate pre-answer / reuse-last-values / zero-field info form).
     *  step-runner suppresses auto-submit while this is set and clears it the moment
     *  the step parks at waiting_form, so the pause is strictly one-shot and never
     *  leaks into an automatic re-run (fix-loop / revise / gate loop-back). Scoped to
     *  the clicked step only; the downstream cascade keeps auto-continuing. */
    pauseFormOnRetry: boolean('pause_form_on_retry').notNull().default(false),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    /** Accumulated time (ms) the step spent idle waiting for user input
     *  (waiting_form). Subtracted from wall-clock to report active work time. */
    idleMs: integer('idle_ms').notNull().default(0),
    /** Timestamp the current idle period began; set while the step is in
     *  waiting_form, cleared and folded into idle_ms on resume. */
    waitingStartedAt: timestamp('waiting_started_at'),
    /** Focused-and-visible time (ms) the user actively spent on this step while
     *  it waited for input (waiting_form). The active-viewing subset of idle_ms,
     *  measured client-side and posted in increments; pauses while the agent
     *  works. Lets the UI report effort = active work + user active time. */
    userActiveMs: integer('user_active_ms').notNull().default(0),
    /** Timing carried over from PRIOR runs of this step (ms). A retry/revise/reset
     *  zeroes the live started_at/ended_at/idle_ms/user_active_ms so the current run
     *  measures cleanly; before zeroing it folds the finished run's work/idle/user
     *  contribution into these accumulators. Timing readers add carried_* on top of
     *  the current run, so work/idle/effort reflect the FULL step across all restarts
     *  instead of only the latest attempt. Default 0; legacy rows carry nothing. */
    carriedWorkMs: integer('carried_work_ms').notNull().default(0),
    carriedIdleMs: integer('carried_idle_ms').notNull().default(0),
    carriedUserActiveMs: integer('carried_user_active_ms').notNull().default(0),
    /** Surface B audit trail: context-window usage frozen at step completion.
     *  context_tokens = peak single-invocation prompt-side tokens
     *  (input + cacheRead + cacheCreation) over this step's non-superseded CLI
     *  invocations; context_window_size = that model's max context;
     *  context_left_percent = 100 - round(tokens / window * 100). All null on
     *  deterministic (no-CLI) steps and on rows finalized before this feature. */
    contextLeftPercent: integer('context_left_percent'),
    contextTokens: integer('context_tokens'),
    contextWindowSize: integer('context_window_size'),
    /** Surface B audit trail: the provider's subscription-allowance USED% (0-100),
     *  frozen at step completion from the usage_window_snapshots row of the step's
     *  CLI provider, so the finished step shows allowance-at-finish (the UI renders
     *  remaining = 100 - used). All null on deterministic steps, when usage tracking
     *  is not connected for the provider, and on rows finalized before this feature. */
    usageFiveHourPct: integer('usage_five_hour_pct'),
    usageSevenDayPct: integer('usage_seven_day_pct'),
    usageDailyPct: integer('usage_daily_pct'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_steps_task_id_idx').on(table.taskId),
    uniqueIndex('task_steps_task_step_round_idx').on(table.taskId, table.stepId, table.round),
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

export interface MergeResolveState {
  /** same-branch: feature -> base merged in the parent checkout (parent IS on base).
   *  cross-branch: parent moved off base, so the merge runs in a transient worktree
   *  checked out on base (under .haive/worktrees) and is persisted/pushed from there. */
  mode: 'same-branch' | 'cross-branch';
  phase: 'pending' | 'resolving' | 'awaiting-guidance' | 'pushing' | 'done';
  /** The branch the merge lands on (= recorded base, or parent HEAD fallback). */
  baseBranch: string;
  /** The branch being merged in (the worktree's feature branch). */
  featureBranch: string;
  /** Worker-absolute dir the merge runs in: ctx.repoPath (same-branch) or the
   *  base worktree path (cross-branch). */
  mergeDir: string;
  /** mergeDir as the cli-exec sandbox sees it — the conflict fix agent's cwd. */
  sandboxMergeDir: string;
  /** cli_invocations.id of the in-flight conflict fix agent (null = none). */
  fixInvocationId: string | null;
  /** Count of automatic (unguided) fix-agent attempts so far; bounds auto-retry. */
  conflictRetries: number;
  /** Set while phase==='awaiting-guidance': the agent's stated uncertainty + when it
   *  was asked, so the clarification form can be rebuilt deterministically. */
  pendingQuestion: { uncertainty: string; askedAt: string } | null;
  /** Whether the cleanup form requested a push of the base branch after merging. */
  pushAfterMerge: boolean;
  /** Terminal outcome (set when phase==='done'): whether a merge commit landed. */
  merged: boolean;
  /** When merged is false: why the merge did not run (e.g. cross-branch skip in the
   *  same-branch-only path, or no base/branch). Null when merged. */
  skipReason: string | null;
  /** Whether the base branch was pushed to origin (the pushing phase). */
  pushed: boolean;
  /** Which merge round this state is in. 'feature' = the worktree branch -> base merge;
   *  'base-sync' = the pre-push round that integrates origin/<base> into base so the
   *  push fast-forwards. Absent on rows written before this existed → treated as
   *  'feature'. */
  mergeStage?: 'feature' | 'base-sync';
  /** Count of pre-push base-sync rounds run; bounds repeated re-sync when origin keeps
   *  advancing. Absent → 0. */
  baseSyncRounds?: number;
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
    /** CLI invocations dispatched for this agent, including re-rolls. The llm-retry
     *  path counts attempts by counting cli_invocations rows, which does not work
     *  here: a mining row is UPDATEd in place on retry (the (task_step_id, agent_id)
     *  unique index forbids a second row), so the count has to live on the row. */
    attempts: integer('attempts').notNull().default(1),
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

// --- Per-task "CLI touched" markers --------------------------------------
// Records which (step, role) the user explicitly set a CLI for WITHIN a task
// that has ignore_saved_step_clis=true. Under that flag the resolver + UI ignore
// pre-existing global per-step prefs EXCEPT where a marker exists, so a mid-task
// manual change still takes effect (and still writes the global pref, as normal)
// while the auto-applied default stays the task's cli_provider_id. Keyed per
// task_id => no cross-task bleed. Only written for flagged tasks.
export const taskStepCliTouched = pgTable(
  'task_step_cli_touched',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: varchar('step_id', { length: 128 }).notNull(),
    role: varchar('role', { length: 32 }).notNull().default('default'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('task_step_cli_touched_pk').on(table.taskId, table.stepId, table.role),
    index('task_step_cli_touched_task_id_idx').on(table.taskId),
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
    /** Latest live-activity line parsed from THIS invocation's stream (throttled,
     *  truncated), so each terminal shows what its own agent is doing — distinct
     *  from the step's shared status_message (which is last-writer-wins). Null
     *  until the first status line. */
    statusMessage: varchar('status_message', { length: 256 }),
    /** Per-invocation title for multi-CLI loop steps — the role of this pass
     *  (Validator / Fixer, Reviewer / Corrector). The api COALESCEs it with the
     *  mining agent title so the terminal header shows which agent ran. */
    agentTitle: varchar('agent_title', { length: 256 }),
    /** True when this invocation was dispatched in steering mode (Claude-family,
     *  stream-json input). The api/web read it to show the steer box, and the
     *  steer endpoint 409s when false. Set by the step-runner from the dispatch
     *  plan's spec.steerable. */
    steerable: boolean('steerable').notNull().default(false),
    /** Set when the step-runner has incorporated this invocation's output
     *  into an apply pass. resolveLlmPhase ignores consumed rows so the
     *  next pass enqueues a fresh invocation. Null = pending or in-flight. */
    consumedAt: timestamp('consumed_at'),
    parsedOutput: jsonb('parsed_output').$type<unknown>(),
    /** Keep in sync with `CliTokenUsage` in @haive/shared — this package
     *  cannot import shared (circular; see the StepErrorHint note above). */
    tokenUsage: jsonb('token_usage').$type<{
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
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
    // At most one LIVE singleton invocation per step. Closes the TOCTOU race in
    // resolveLlmPhase's dispatch guard (see migration 0096): a second concurrent
    // live insert fails with 23505 and the dispatch path re-parks the loser.
    // 'agent_mining' (review fan-out) and 'dag_parallel' (DAG coder/reviewer
    // fan-out) are excluded because both run N concurrent invocations per step by
    // design — their concurrency is bounded by task_step_agent_minings /
    // task_dag_issues barrier rows, not by this singleton index.
    uniqueIndex('cli_invocations_one_live_per_step_idx')
      .on(table.taskStepId)
      .where(
        sql`${table.endedAt} is null and ${table.supersededAt} is null and ${table.mode} <> 'agent_mining' and ${table.mode} <> 'dag_parallel'`,
      ),
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
