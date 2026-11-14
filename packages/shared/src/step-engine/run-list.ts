import type { ExecutionPath } from '../schemas/tasks.js';
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
