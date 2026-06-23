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

/** The pre-flight triage step id. Single source of truth — referenced by the step
 *  definition, the SPINE, and buildRunList (which pulls it to the front). */
export const TRIAGE_STEP_ID = '00-triage';

/** Steps present in every non-full path. 00-triage MUST be in every set so that,
 *  after triage records the path, the next buildRunList still finds it (else
 *  findIndex -> -1 -> the task would complete prematurely). 07-phase-2-implement is
 *  spine because spine verify steps (08-phase-5-verify fixLoop, 07c-ddev-reconcile
 *  fixLoopOnError) loop back to it. */
const SPINE: readonly string[] = [
  TRIAGE_STEP_ID,
  '00-model-health-workflow',
  '01-worktree-setup',
  '01a-app-boot',
  '01b-install-plugins',
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
 *  spec-quality audit of the draft (05) and a peer/security code review of the
 *  result (08c). gate-1 doubles as the plan-approval gate; 06b/06c are the DAG
 *  tasklist + executor. Still lighter than full: no 05a warning auto-resolve, no
 *  08d adversarial QA, no browser verify, no gate-2. */
const PLAN_TASKLIST_EXTRA: readonly string[] = [
  '03-phase-0a-discovery',
  '04-phase-0b-pre-planning',
  '05-phase-0b5-spec-quality',
  '06-run-config',
  '06-gate-1-spec-approval',
  '06b-sprint-planning',
  '06c-dag-execute',
  '08c-code-review',
  '11-phase-8-learning',
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
  '08d-adversarial-qa': '07-phase-2-implement', // fixLoop
  '08a-browser-verify': '07-phase-2-implement', // fixLoop + restartLoop
  '09-gate-2-verify-approval': '07-phase-2-implement', // restartLoop
  '06-gate-1-spec-approval': '04-phase-0b-pre-planning', // reviseLoop
  '03c-business-requirements-review': '03b-business-requirements', // reviseLoop
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

/** Build the ordered run list for a workflow task: 00-triage first (ahead of the
 *  env-replicate prelude so the path is chosen up front), then the prelude, then the
 *  remaining workflow steps in their existing order. When a path is set, workflow
 *  steps are trimmed to that path; the env-replicate prelude is never filtered.
 *  Pure (no registry / DB) so it is unit-testable. */
export function orderWorkflowRunList<T extends OrderableStep>(
  main: readonly T[],
  prelude: readonly T[],
  path: ExecutionPath | null,
): T[] {
  const triage = main.filter((s) => s.metadata.id === TRIAGE_STEP_ID);
  const rest = main.filter((s) => s.metadata.id !== TRIAGE_STEP_ID);
  const ordered = [...triage, ...prelude, ...rest];
  if (!path) return ordered;
  return ordered.filter(
    (s) => s.metadata.workflowType === 'env_replicate' || keepForPath(s.metadata.id, path),
  );
}
