import { EXECUTION_PATHS, type ExecutionPath } from '../schemas/tasks.js';
import { orderWorkflowRunList } from './execution-paths.js';

export type RunListStrategy = 'static' | 'workflow_paths' | 'run_app_modes';

/** Used by the boot seeder and by readers before that seed exists. */
export function builtinRunListStrategy(type: string): RunListStrategy {
  if (type === 'workflow') return 'workflow_paths';
  if (type === 'run_app') return 'run_app_modes';
  return 'static';
}

/** Pure run-list selection shared by orchestration and advisory readers. The caller
 * supplies registered steps in index order and resolves the returned IDs itself. */
export function taskRunListIds(
  task: {
    workflowType: string;
    runListStrategy: RunListStrategy;
    runListSnapshot: readonly string[] | null;
    executionPath: ExecutionPath | null;
  },
  listByWorkflow: (type: string) => readonly string[],
  containerTool?: string | null,
): string[] {
  if (task.runListStrategy === 'run_app_modes') {
    const runtime =
      containerTool === 'ddev'
        ? ['01c-ddev-env', '01c1-restore-database', '06a-db-migrate']
        : containerTool
          ? ['02-generate-dockerfile', '03-build-image', '01a-app-boot']
          : [];
    return [
      '01-declare-deps',
      '01-worktree-setup',
      '01-debug-mode',
      '98-choose-view',
      ...runtime,
      '99-run-app-ready',
      '11g-save-database',
    ];
  }
  if (task.runListStrategy === 'workflow_paths') {
    const steps = (type: string) =>
      listByWorkflow(type).map((id) => ({ metadata: { id, workflowType: type } }));
    return orderWorkflowRunList(steps('workflow'), steps('env_replicate'), task.executionPath).map(
      (step) => step.metadata.id,
    );
  }
  return [...(task.runListSnapshot ?? listByWorkflow(task.workflowType))];
}

/** JSON-safe candidate shape shared by the catalog adapter, evaluator and future task pins.
 * null is the full pre-triage list, not a selected execution path. */
export interface DerivedBaseCandidate {
  readonly executionPath: ExecutionPath | null;
  readonly stepIds: readonly string[];
}

/** The API must read these fields coherently from step_catalog. No DB reader lives here. */
export interface OrderedStepCatalogRow {
  readonly stepId: string;
  readonly workflowType: string;
  readonly stepIndex: number;
}

export type DerivedBaseEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'base-not-builtin' | 'base-not-supported' | 'run-app-mode-selection-unavailable';
      message: string;
    };

/** V1 deliberately admits only the built-in workflow. Authoring belongs to admins;
 * consumption and admission are later API work, not policy implemented by this helper. */
export function derivedBaseEligibility(base: {
  slug: string;
  source: string;
  runListStrategy: string;
}): DerivedBaseEligibility {
  if (base.source !== 'builtin') {
    return {
      eligible: false,
      reason: 'base-not-builtin',
      message: 'Only built-in task types can be bases; derived parents are not supported.',
    };
  }
  if (base.slug === 'run_app' || base.runListStrategy === 'run_app_modes') {
    return {
      eligible: false,
      reason: 'run-app-mode-selection-unavailable',
      message:
        'Run the app chooses its runtime mode after 01-declare-deps, lacks complete composable lists, and needs a finalization seam separate from workflow triage.',
    };
  }
  if (base.slug !== 'workflow' || base.runListStrategy !== 'workflow_paths') {
    return {
      eligible: false,
      reason: 'base-not-supported',
      message: 'Only the built-in workflow is eligible as a derived base in v1.',
    };
  }
  return { eligible: true };
}

/** Always use the existing selector: duplicating its path or prelude rules would drift. */
export function workflowBaseCandidates(
  listByWorkflow: (type: string) => readonly string[],
): DerivedBaseCandidate[] {
  return [null, ...EXECUTION_PATHS].map((executionPath) => ({
    executionPath,
    stepIds: taskRunListIds(
      {
        workflowType: 'workflow',
        runListStrategy: 'workflow_paths',
        runListSnapshot: null,
        executionPath,
      },
      listByWorkflow,
    ),
  }));
}

/** Registry.listByWorkflow orders by index, not by ID or database collation.
 * Equal indices cannot be reconstructed from catalog rows: refuse ambiguity rather
 * than choosing an order that could differ from registration's stable tie order. */
export function catalogWorkflowBaseCandidates(
  rows: readonly OrderedStepCatalogRow[],
): DerivedBaseCandidate[] {
  const ids = new Set<string>();
  const workflows = new Map<string, OrderedStepCatalogRow[]>();
  for (const row of rows) {
    if (row.workflowType !== 'workflow' && row.workflowType !== 'env_replicate') continue;
    if (ids.has(row.stepId)) throw new Error('Duplicate base catalog step ID: ' + row.stepId);
    if (!Number.isFinite(row.stepIndex))
      throw new Error('Invalid base catalog index: ' + row.stepId);
    ids.add(row.stepId);
    const steps = workflows.get(row.workflowType) ?? [];
    steps.push(row);
    workflows.set(row.workflowType, steps);
  }
  for (const steps of workflows.values()) {
    steps.sort((a, b) => a.stepIndex - b.stepIndex);
    for (let i = 1; i < steps.length; i++) {
      if (steps[i]!.stepIndex === steps[i - 1]!.stepIndex) {
        throw new Error('Ambiguous base catalog order: ' + steps[i]!.workflowType);
      }
    }
  }
  return workflowBaseCandidates((type) => workflows.get(type)?.map((s) => s.stepId) ?? []);
}

export interface BaseCandidateParityIssue {
  executionPath: ExecutionPath | null;
  expected: readonly string[] | null;
  actual: readonly string[] | null;
}

/** Compare paths and every ordered ID, including the pre-triage/null candidate. */
export function baseCandidateParityIssues(
  expected: readonly DerivedBaseCandidate[],
  actual: readonly DerivedBaseCandidate[],
): BaseCandidateParityIssue[] {
  const paths = new Set([...expected, ...actual].map((c) => c.executionPath));
  return [...paths].flatMap((executionPath) => {
    const left = expected.filter((c) => c.executionPath === executionPath);
    const right = actual.filter((c) => c.executionPath === executionPath);
    const a = left[0]?.stepIds ?? null;
    const b = right[0]?.stepIds ?? null;
    if (
      left.length === 1 &&
      right.length === 1 &&
      a!.length === b!.length &&
      a!.every((id, index) => id === b![index])
    )
      return [];
    return [{ executionPath, expected: a, actual: b }];
  });
}
