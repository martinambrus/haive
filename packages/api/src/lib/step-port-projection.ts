import { projectStepPorts } from '@haive/shared/step-ports';
import { parseDerivedRunPlan } from '@haive/shared/modularity';
import { readStepRole, STEP_ROLES, type RoleTaskPin } from '@haive/shared/step-outputs';
import type { StepCatalogRead, inspectDerivedDefinition } from '@haive/shared/modularity-server';

type Candidate = ReturnType<typeof inspectDerivedDefinition>['candidates'][number];
export function projectPortCandidates(
  candidates: readonly Pick<Candidate, 'executionPath' | 'stepIds' | 'roleBindings'>[],
  catalog: Pick<StepCatalogRead, 'composable'>,
) {
  const labels = new Map([...catalog.composable].map(([id, entry]) => [id, entry.label]));
  return {
    candidates: candidates.map((candidate) => ({
      executionPath: candidate.executionPath,
      graph: projectStepPorts(candidate.stepIds, { labels, roleBindings: candidate.roleBindings }),
    })),
  };
}

/** Only call after the route's owner predicate. Historical edges never consult a live type/catalog. */
export function projectTaskPorts(
  task: RoleTaskPin,
  steps: readonly { stepId: string; title?: string | null }[],
) {
  const labels = new Map(steps.map((step) => [step.stepId, step.title ?? step.stepId]));
  if (task.derivedRunPlan != null || task.runListStrategy === 'derived') {
    const plan = parseDerivedRunPlan(task.derivedRunPlan);
    // Reuse the strict pin reader's selected-path/snapshot consistency fence.
    for (const role of Object.values(STEP_ROLES))
      readStepRole(task, role, (binding) => binding, plan);
    return {
      candidatesOnly: task.executionPath == null,
      candidates: plan.candidates
        .filter((candidate) => candidate.executionPath === (task.executionPath ?? null))
        .map((candidate) => ({
          executionPath: candidate.executionPath,
          graph: projectStepPorts(candidate.stepIds, {
            labels,
            roleBindings: task.executionPath == null ? undefined : candidate.roleBindings,
          }),
        })),
    };
  }
  const ids = task.runListSnapshot ?? [...new Set(steps.map((step) => step.stepId))];
  return {
    candidates: [
      { executionPath: task.executionPath ?? null, graph: projectStepPorts(ids, { labels }) },
    ],
  };
}
