import {
  DerivedRunPlanError,
  parseDerivedRunPlan,
  type DerivedRunPlan,
} from '../modularity/derived-task-types.js';
import { executionPathSchema } from '../schemas/tasks.js';
import { STEP_ROLES, type StepRoleId, type StepOutputContractRef } from './output-contracts.js';
export { STEP_ROLES } from './output-contracts.js';

export interface RoleTaskPin {
  derivedRunPlan?: unknown;
  executionPath?: string | null;
  runListSnapshot?: readonly string[] | null;
  /** Callers that know a plan is required must not downgrade a missing pin to identity. */
  runListStrategy?: string;
}
export interface RoleBinding {
  role: StepRoleId;
  stepId: string | null;
  outputContract: StepOutputContractRef | null;
  state: 'active' | 'absent' | 'unselected';
}

/** The sole role resolution algorithm. It never consults a live definition or output shape. */
export function readStepRole<T>(
  task: RoleTaskPin,
  role: StepRoleId,
  read: (binding: RoleBinding) => T,
  /** Reuse only a plan already decoded for this task by the caller. */
  parsedPlan?: DerivedRunPlan,
): T {
  if (task.derivedRunPlan == null && task.runListStrategy !== 'derived') {
    return read({ role, stepId: role, outputContract: null, state: 'active' });
  }
  const plan = parsedPlan ?? parseDerivedRunPlan(task.derivedRunPlan);
  const path =
    task.executionPath == null ? null : executionPathSchema.safeParse(task.executionPath);
  if (path !== null && !path.success) throw new DerivedRunPlanError();
  const candidate = plan.candidates.find(
    (c) => c.executionPath === (path === null ? null : path.data),
  )!;
  if (
    task.runListSnapshot == null ||
    JSON.stringify(task.runListSnapshot) !== JSON.stringify(candidate.stepIds)
  )
    throw new DerivedRunPlanError();
  if (path === null) return read({ role, stepId: null, outputContract: null, state: 'unselected' });
  const producer =
    plan.version === 2
      ? plan.candidates.find((c) => c.executionPath === path.data)!.roleBindings[role]
      : undefined;
  return read(
    producer
      ? { role, stepId: producer.stepId, outputContract: producer.outputContract, state: 'active' }
      : {
          role,
          stepId: candidate.stepIds.includes(role) ? role : null,
          outputContract: null,
          state: candidate.stepIds.includes(role) ? 'active' : 'absent',
        },
  );
}

/** Additive DTO projection; call only after task ownership has been established. */
export function projectStepOutputRoles<T extends { stepId: string }>(
  task: RoleTaskPin,
  steps: readonly T[],
): (T & { outputRoles?: StepRoleId[] })[] {
  const bindings = Object.values(STEP_ROLES).map((role) =>
    readStepRole(task, role, (binding) => binding),
  );
  return steps.map((step) => {
    const outputRoles = bindings
      .filter((b) => b.state === 'active' && b.stepId === step.stepId)
      .map((b) => b.role);
    return outputRoles.length ? { ...step, outputRoles } : { ...step };
  });
}
