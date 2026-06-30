import type { ExecutionPath } from '@haive/shared';

// Execution-path filtering for workflow tasks. The 00-triage step records
// tasks.execution_path; buildRunList (task-queue.ts) then trims the WORKFLOW step
// list to the chosen path on every advance. The env-replicate prelude is never
// filtered here (buildRunList applies these sets only to the 'workflow' list).
// full_workflow keeps every registered workflow step (no filter).
//
// Safety with the forward walk (steps.findIndex(currentStepId) + [idx+1]): the
// SPINE is in EVERY path set, so the just-finished step is always present in the
// filtered list and findIndex never returns -1. The loop-target closure invariant
// (PATH_REQUIRED_TARGETS) is enforced at boot by assertPathStepSetsClosed.
// See plan: ~/.claude/plans/hidden-puzzling-lantern.md.

/** The pre-flight model-health canary id (workflow pipeline). Single source of
 *  truth — referenced by the SPINE and buildRunList (which pulls it to the very
 *  front, ahead of triage): a dead model fails loudly here before a path is chosen,
 *  since the chosen path is moot when no model can run it. */
export const MODEL_HEALTH_STEP_ID = '00-model-health-workflow';

/** The pre-flight triage step id. Single source of truth — referenced by the step
 *  definition, the SPINE, and buildRunList (which pulls it to the front, just behind
 *  the base-sync step). */
export const TRIAGE_STEP_ID = '00-triage';

/** The pre-branch base-sync step id. Runs after the model-health canary and before
 *  triage (orderWorkflowRunList pulls it between them): it freshens the local base
 *  branch from origin so the feature worktree is cut from the latest code and the
 *  12-worktree-cleanup base push is a fast-forward. Single source of truth. */
export const SYNC_BASE_STEP_ID = '00a-sync-base';

/** Steps present in every non-full path. 00-triage MUST be in every set so that,
 *  after triage records the path, the next buildRunList still finds it (else
 *  findIndex -> -1 -> the task would complete prematurely). 07-phase-2-implement is
 *  spine because spine verify steps (08-phase-5-verify fixLoop, 07c-ddev-reconcile
 *  fixLoopOnError) loop back to it. */
const SPINE: readonly string[] = [
  MODEL_HEALTH_STEP_ID,
  SYNC_BASE_STEP_ID,
  TRIAGE_STEP_ID,
  '01-worktree-setup',
  '01-debug-mode',
  '01a-app-boot',
  '01b-install-plugins',
  '01d-browser-access',
  '01c-ddev-env',
  '02-pre-rag-sync',
  '06a-db-migrate',
  '07-phase-2-implement',
  '07b-phase-4-validate',
  '07c-ddev-reconcile',
  '08-phase-5-verify',
  '08b-test-management',
  '10-gate-3-commit',
  '11a-gate-4-push',
  '12-worktree-cleanup',
];

/** plan_tasklist adds the spec + decomposition chain on top of the spine, plus a
 *  spec-quality review of the draft (05) and a peer/security code review of the
 *  result (08c). The broad audits (04a spec, 08c2 code) and their sinks (05a
 *  resolve-warnings, 09 gate-2) are included too so the broad-audit findings
 *  surface and get resolved here, not only in full_workflow. gate-1 doubles as
 *  the plan-approval gate; 06b/06c are the DAG tasklist + executor. Lighter than
 *  full: no 08d adversarial QA, no browser verify. */
const PLAN_TASKLIST_EXTRA: readonly string[] = [
  '03-phase-0a-discovery',
  '04-phase-0b-pre-planning',
  '04a-spec-audit',
  '05-phase-0b5-spec-quality',
  '05a-resolve-spec-warnings',
  '06-run-config',
  '06-gate-1-spec-approval',
  '06b-sprint-planning',
  '06c-dag-execute',
  '08c-code-review',
  '08c2-code-audit',
  '09-gate-2-verify-approval',
  '11-phase-8-learning',
  '11b-kb-commit',
  '11c-rag-reindex',
];

export const PATH_STEP_SETS: Record<
  Exclude<ExecutionPath, 'full_workflow'>,
  ReadonlySet<string>
> = {
  quick_bugfix: new Set(SPINE),
  plan_tasklist: new Set([...SPINE, ...PLAN_TASKLIST_EXTRA]),
};

/** Loop-back / revise / restart targets each emitter step requires: when an
 *  emitter is retained in a path, its target MUST be retained too, or the fix
 *  loop / revise route would jump to a filtered-out step. Asserted at boot
 *  (assertPathStepSetsClosed) against the actual hooks on the StepDefinitions.
 *  Keep in sync with the fixLoop / reviseLoop / restartLoop / fixLoopOnError
 *  hooks in steps/workflow/*. */
export const PATH_REQUIRED_TARGETS: Record<string, string> = {
  '07b-phase-4-validate': '07-phase-2-implement', // fixLoop
  '08-phase-5-verify': '07-phase-2-implement', // fixLoop
  '07c-ddev-reconcile': '07-phase-2-implement', // fixLoopOnError
  '08c-code-review': '07-phase-2-implement', // fixLoop
  '08a-browser-verify': '07-phase-2-implement', // fixLoop + restartLoop
  '09-gate-2-verify-approval': '07-phase-2-implement', // restartLoop
  '06-gate-1-spec-approval': '04-phase-0b-pre-planning', // reviseLoop
  '03c-business-requirements-review': '03b-business-requirements', // reviseLoop
  '11-phase-8-learning': '11-phase-8-learning', // reviseLoop (self-target: refine drafts)
};

/** Whether a 'workflow' step id runs under the given execution path. full_workflow
 *  keeps everything; other paths keep only their step set. Callers handle a null
 *  path (buildRunList returns the full list when execution_path is unset). */
export function keepForPath(stepId: string, path: ExecutionPath): boolean {
  if (path === 'full_workflow') return true;
  return PATH_STEP_SETS[path].has(stepId);
}

/** Minimal step shape this module needs — keeps execution-paths free of a
 *  dependency on the worker StepDefinition type (which it would otherwise import
 *  from the step engine). The real StepDefinition satisfies it structurally. */
export interface OrderableStep {
  readonly metadata: { readonly id: string; readonly workflowType: string };
}

/** Build the ordered run list for a workflow task: the model-health canary first (a
 *  dead model fails loudly before anything else runs), then 00a-sync-base (freshen the
 *  base branch from origin before any decision or branch is made), then 00-triage (so
 *  the path is chosen up front), then the env-replicate prelude, then the remaining
 *  workflow steps in their existing order. When a path is set, workflow steps are
 *  trimmed to that path; the env-replicate prelude is never filtered. The canary,
 *  base-sync, and triage are all in every path set (SPINE), so none is ever filtered
 *  out. Pure (no registry / DB) so it is unit-testable. */
export function orderWorkflowRunList<T extends OrderableStep>(
  main: readonly T[],
  prelude: readonly T[],
  path: ExecutionPath | null,
): T[] {
  const health = main.filter((s) => s.metadata.id === MODEL_HEALTH_STEP_ID);
  const sync = main.filter((s) => s.metadata.id === SYNC_BASE_STEP_ID);
  const triage = main.filter((s) => s.metadata.id === TRIAGE_STEP_ID);
  const rest = main.filter(
    (s) =>
      s.metadata.id !== MODEL_HEALTH_STEP_ID &&
      s.metadata.id !== SYNC_BASE_STEP_ID &&
      s.metadata.id !== TRIAGE_STEP_ID,
  );
  const ordered = [...health, ...sync, ...triage, ...prelude, ...rest];
  if (!path) return ordered;
  return ordered.filter(
    (s) => s.metadata.workflowType === 'env_replicate' || keepForPath(s.metadata.id, path),
  );
}
