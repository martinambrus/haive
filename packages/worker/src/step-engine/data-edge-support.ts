import { parseDataEdgePlan, selectDataEdgeCandidate } from '@haive/shared/data-edge-plan';
import { STEP_ROLE_REGISTRY, type StepRoleId } from '@haive/shared/step-outputs';
import { CORE_COMPOSABLE_STEPS } from './composable-core.js';
import { PinnedStepSupportError, type StepRegistry } from './registry.js';

/** Availability check only. Never rewrite the pinned producer or contract. */
export function assertDataEdgeSupport(
  task: {
    dataEdgePlan?: unknown;
    executionPath?: string | null;
    runListSnapshot?: readonly string[] | null;
  },
  registry: Pick<StepRegistry, 'get'>,
): void {
  if (task.dataEdgePlan == null) return;
  const plan = parseDataEdgePlan(task.dataEdgePlan);
  const selected = selectDataEdgeCandidate({ ...task, dataEdgePlan: task.dataEdgePlan }, plan);
  const candidates =
    plan.selection === 'derived' && task.executionPath == null ? plan.candidates : [selected];
  for (const candidate of candidates)
    for (const b of Object.values(candidate.bindings)) {
      if (!b) continue;
      const role = STEP_ROLE_REGISTRY[b.role as StepRoleId];
      const def = registry.get(b.producerStepId);
      if (
        !Object.hasOwn(STEP_ROLE_REGISTRY, b.role) ||
        !def ||
        role.contract.id !== b.contract.id ||
        role.contract.version !== b.contract.version
      )
        throw new PinnedStepSupportError(b.producerStepId);
      if ('hostPolicy' in role) {
        if (
          def.outputContract?.id !== b.contract.id ||
          def.outputContract.version !== b.contract.version
        )
          throw new PinnedStepSupportError(b.producerStepId);
      } else {
        const provided = def.providesRoles?.find((p) => p.role === b.role);
        if (
          provided &&
          provided.contract.id === b.contract.id &&
          provided.contract.version === b.contract.version
        )
          continue;
        const declaration =
          CORE_COMPOSABLE_STEPS.find((e) => e.stepId === b.producerStepId)?.providesRoles?.find(
            (p) => p.role === b.role,
          ) ?? def.providesRoles?.find((p) => p.role === b.role);
        if (
          declaration?.contract.id !== b.contract.id ||
          declaration.contract.version !== b.contract.version
        )
          throw new PinnedStepSupportError(b.producerStepId);
      }
    }
}
