import { z } from 'zod';

export const workflowTypeSchema = z.enum([
  'onboarding',
  'workflow',
  'onboarding_upgrade',
  'run_app',
]);

/** Execution path for a workflow task, chosen at the 00-triage step. quick_bugfix
 *  hands the CLI the problem directly; plan_tasklist drafts a spec and runs a
 *  decomposed DAG; full_workflow is the complete pipeline. Workflow tasks only. */
export const executionPathSchema = z.enum(['quick_bugfix', 'plan_tasklist', 'full_workflow']);

export type ExecutionPath = z.infer<typeof executionPathSchema>;

export const EXECUTION_PATHS = executionPathSchema.options;

export const EXECUTION_PATH_LABELS: Record<ExecutionPath, string> = {
  quick_bugfix: 'Quick bugfix',
  plan_tasklist: 'Plan + tasklist',
  full_workflow: 'Full workflow',
};

export const taskStatusSchema = z.enum([
  'created',
  'queued',
  'running',
  'waiting_user',
  'waiting_pr',
  'completed',
  'failed',
  'cancelled',
]);

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_form',
  'waiting_cli',
  'done',
  'failed',
  'skipped',
]);

export const resourceLimitsSchema = z
  .object({
    memoryLimitMb: z.number().int().min(128).max(65536).optional(),
    cpuLimitMilli: z.number().int().min(100).max(16000).optional(),
  })
  .optional();

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;

/** Per-step loop iteration overrides. Map of step id → max iterations.
 *  Currently exercised by 05-phase-0b5-spec-quality (default 10 if absent).
 *  Future loop-enabled steps register here too. Values are integers in
 *  [1, 50]; outside that range is rejected to bound LLM cost. */
export const stepLoopLimitsSchema = z
  .record(z.string().min(1), z.number().int().min(1).max(50))
  .optional();

export type StepLoopLimits = z.infer<typeof stepLoopLimitsSchema>;

export const createTaskRequestSchema = z
  .object({
    type: workflowTypeSchema,
    title: z.string().min(1).max(512),
    description: z.string().optional(),
    /** Developer's estimated completion time in decimal hours (0.25, 0.5, 1, 1.5).
     *  Optional; stored on tasks.estimated_time_hours and compared against actual
     *  effort (work + user-active) in the task UI. All task types. */
    estimatedTimeHours: z.number().positive().max(1000).optional(),
    repositoryId: z.string().uuid().optional(),
    cliProviderId: z.string().uuid().optional(),
    envTemplateId: z.string().uuid().optional(),
    /** Optional DB dump (uploaded via the chunked db-dumps endpoint) to import
     *  into the task's ephemeral environment before migrations run. */
    dbUploadId: z.string().uuid().optional(),
    /** Phase 3.5: run an AI code-simplification pass (plus a conditional fixup
     *  pass) over the implementation before verification. Workflow tasks only. */
    simplifyCode: z.boolean().optional(),
    /** Phase 7: adversarial QA level. Fans out 2/4/6 adversarial agents before
     *  gate 2. Workflow tasks only; omitted/'none' = off. */
    adversarialQaLevel: z.enum(['none', 'poc', 'standard', 'enterprise']).optional(),
    /** Broad audit (default true): run the report-only broad spec + code audits on
     *  top of the narrow reviewers. Creation-time toggle. Workflow tasks only. */
    broadAudit: z.boolean().optional(),
    /** Marks the task as a bug fix → the learning step also authors a durable
     *  investigation (root cause + lesson) into the knowledge base. Stored in
     *  tasks.metadata.category. Workflow tasks only. */
    isBugFix: z.boolean().optional(),
    /** Short feature/area the task targets (e.g. "checkout", "user-import").
     *  Stored in tasks.metadata.feature. Baked into the bug investigation and
     *  used to bias knowledge discovery search. Workflow tasks only. */
    feature: z.string().trim().max(120).optional(),
    /** Clients/tenants impacted by the bug being fixed. Stored in
     *  tasks.metadata.affectedClients and recorded only in the local investigation
     *  frontmatter — never promoted to the cross-repo KB. Workflow tasks only. */
    affectedClients: z.array(z.string().trim().max(120)).max(50).optional(),
    /** Optional parent task this bug fix belongs to (one level only). Must be a
     *  completed workflow task in the same repository; if the chosen parent is
     *  itself a linked bug fix, the create handler re-points to ITS parent so the
     *  link never chains past one level. Stored on tasks.parent_task_id.
     *  Workflow bug-fix tasks only. */
    parentTaskId: z.string().uuid().optional(),
    /** Auto-continue: auto-submit info-only forms and gate-1 pre-answers so the
     *  workflow runs hands-free between gates. Defaults to true. */
    autoContinue: z.boolean().optional(),
    /** Per-task override: ignore the user's saved per-step CLI prefs and default
     *  every step to this task's cliProviderId. Manual mid-task step changes
     *  still save globally as usual (see tasks.ignore_saved_step_clis). */
    ignoreSavedStepClis: z.boolean().optional(),
    resourceLimits: resourceLimitsSchema,
    stepLoopLimits: stepLoopLimitsSchema,
  })
  .refine(
    (d) =>
      d.type !== 'workflow' || (d.description !== undefined && d.description.trim().length > 0),
    { message: 'description is required for workflow tasks', path: ['description'] },
  );

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const submitStepRequestSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export type SubmitStepRequest = z.infer<typeof submitStepRequestSchema>;

/** Body for POST /tasks/:id/steps/:stepId/clarify — a free-text answer to a mid-step
 *  clarification question (e.g. the merge-resolver's "how should I resolve this?"). */
export const clarifyStepRequestSchema = z.object({
  answer: z.string().min(1).max(8000),
});

export type ClarifyStepRequest = z.infer<typeof clarifyStepRequestSchema>;

/** task_events event types for the merge-resolver clarification channel. Shared so
 *  the worker (which reads outstanding guidance) and the api /clarify route (which
 *  writes the answer) key on the same string. */
export const MERGE_CLARIFICATION_ASKED_EVENT = 'merge_resolution.clarification_asked';
export const MERGE_CLARIFICATION_ANSWERED_EVENT = 'merge_resolution.clarification_answered';

export const taskActionSchema = z.enum(['cancel', 'retry']);

export const taskActionRequestSchema = z.object({
  action: taskActionSchema,
});

export type TaskAction = z.infer<typeof taskActionSchema>;

/** PR close-out: whether a task auto-completes when its pull request merges, or
 *  waits for a manual Finalize click. Chosen per task at PR-open; stored on
 *  tasks.pr_finalize_mode. The background poller tracks PR status either way. */
export const prFinalizeModeSchema = z.enum(['auto', 'manual']);
export type PrFinalizeMode = z.infer<typeof prFinalizeModeSchema>;

/** Lifecycle of the opened pull/merge request as tracked by the poller. Stored on
 *  tasks.pr_state. `closed` = closed without merging (declined/rejected). */
export const prRecordStateSchema = z.enum(['open', 'merged', 'closed']);
export type PrRecordState = z.infer<typeof prRecordStateSchema>;

export const stepActionSchema = z.enum(['retry', 'retry_ai', 'skip', 'resume', 'abort']);

export const stepActionRequestSchema = z.object({
  action: stepActionSchema,
  note: z.string().max(2000).optional(),
  /** Which round of the step to act on. A fix-loop step recurs once per round
   *  (round 0 = original pass), each rendered as its own row with its own
   *  buttons, so the UI must say which one was clicked. Omitted → latest round. */
  round: z.number().int().nonnegative().optional(),
  /** Only meaningful with action 'retry'. When true, the retry sets
   *  task_steps.local_model_override on the clicked step so the
   *  unsafe-for-local-models guard is bypassed on re-run (the "Override and run"
   *  button). Omitted/false → a normal retry that re-arms the guard. */
  overrideLocalModel: z.boolean().optional(),
});

export type StepAction = z.infer<typeof stepActionSchema>;

export const setCliProviderRequestSchema = z.object({
  cliProviderId: z.string().uuid().nullable(),
  /** Which CLI role this preference targets. Omitted / 'default' uses the
   *  single per-step provider (legacy path); named roles (e.g. 'reviewer',
   *  'corrector') are stored per (user, step, role) for multi-CLI steps. */
  role: z.string().max(32).optional(),
  /** Which round of the step to act on (see stepActionRequestSchema). Omitted →
   *  latest round. */
  round: z.number().int().nonnegative().optional(),
  /** Optional per-step effort/reasoning override stored beside the CLI for this
   *  (step, role). Null/omitted clears it (the step uses the provider's configured
   *  effort). Validated against the resolved provider's effortScale server-side; an
   *  out-of-scale value (e.g. claude 'max' on codex) is dropped. */
  effortLevel: z.string().max(32).nullable().optional(),
});

export type SetCliProviderRequest = z.infer<typeof setCliProviderRequestSchema>;

export const renameTaskRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(512).optional(),
    autoContinue: z.boolean().optional(),
  })
  .refine((d) => d.title !== undefined || d.autoContinue !== undefined, {
    message: 'title or autoContinue is required',
  });

export type RenameTaskRequest = z.infer<typeof renameTaskRequestSchema>;

// --- Tasks listing: status filter tokens -------------------------------------
// The /tasks listing filters by a status *token* emitted by the dropdown and by
// the repositories-page badge deep-links (?status=open|active). 'open' =
// non-terminal; 'active' = open minus waiting_user; 'unfinished' = open plus
// failed (everything still needing attention). These sets are the single source
// of truth shared by the web dropdown and the server-side query, so the listing
// can paginate/filter in SQL instead of folding a full in-memory list. 'paused'
// is a live DB status even though the shared TaskStatus union omits it, so these
// are plain string literals rather than TaskStatus[].
export const OPEN_TASK_STATUSES = [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
] as const;

export const ACTIVE_TASK_STATUSES = ['created', 'queued', 'running', 'paused'] as const;

const ALL_TASK_STATUSES = [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
  'completed',
  'failed',
  'cancelled',
] as const;

/** Expand a status filter token into the concrete set of statuses to filter on,
 *  or null for "no status filter" (all). Mirrors the web matchesStatus grouping
 *  exactly. An empty or unrecognized token yields null — the dropdown only emits
 *  known tokens, so a hand-typed garbage value falls back to the unfiltered (but
 *  still user-scoped) list rather than an empty-IN edge case. */
export function expandTaskStatusFilter(token: string | undefined | null): string[] | null {
  if (!token) return null;
  if (token === 'open') return [...OPEN_TASK_STATUSES];
  if (token === 'active') return [...ACTIVE_TASK_STATUSES];
  if (token === 'unfinished') return [...OPEN_TASK_STATUSES, 'failed'];
  return (ALL_TASK_STATUSES as readonly string[]).includes(token) ? [token] : null;
}
