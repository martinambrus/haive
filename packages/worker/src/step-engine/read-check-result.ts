import {
  parseDataEdgePlan,
  selectDataEdgeCandidate,
  resolveDataInput,
  DataEdgePlanError,
} from '@haive/shared/data-edge-plan';
import type { RoleTaskPin } from '@haive/shared/step-outputs';
import {
  CHECK_RESULT_ROLES,
  STEP_ROLE_REGISTRY,
  type CheckResultRole,
  type RoleOutput,
} from '@haive/shared/step-outputs';
import { legacyRoleOutput, type RoleRead } from './read-role.js';
/** Explicit host adapter: historical built-in rows keep tolerant field fallbacks.
 * Alternate producers must be ready and valid; never borrow partial invalid fields. */
export function checkResultOutput<R extends CheckResultRole>(
  read: RoleRead<R>,
): Partial<RoleOutput<R>> {
  if (!read.producer) return {};
  if (read.producer.stepId === STEP_ROLE_REGISTRY[read.role].legacyStepId)
    return legacyRoleOutput(read);
  const data = read.state === 'ready' ? read.data : { resultStatus: 'incomplete' as const };
  if (
    data.resultStatus === 'passed' ||
    data.resultStatus === 'failed' ||
    (data.resultStatus === 'skipped' && read.role === CHECK_RESULT_ROLES.testManagement) ||
    (read.role === CHECK_RESULT_ROLES.adversarialQa &&
      read.state === 'ready' &&
      ['clean', 'findings'].includes(data.resultStatus)) ||
    (read.role === CHECK_RESULT_ROLES.browser &&
      read.state === 'ready' &&
      data.resultStatus === 'manual')
  )
    return data as Partial<RoleOutput<R>>;
  if (read.role === CHECK_RESULT_ROLES.browser)
    return {
      ...data,
      ran: true,
      method: 'mcp',
      skipped: false,
      passed: false,
      verificationIncomplete: true,
    } as Partial<RoleOutput<R>>;
  if (read.role === CHECK_RESULT_ROLES.adversarialQa)
    return { ...data, ran: true, level: 'poc', qaIncomplete: true } as Partial<RoleOutput<R>>;
  if (read.role === CHECK_RESULT_ROLES.validation)
    return {
      ...data,
      verdict: 'UNPARSEABLE',
      summary: 'Validation did not complete; inspect the producer result.',
      changedFilesCoverage: { listed: 0, total: 0, scanFailed: true },
    } as Partial<RoleOutput<R>>;
  if (read.role === CHECK_RESULT_ROLES.verify)
    return { ...data, passed: false } as Partial<RoleOutput<R>>;
  return { ...data, action: 'incomplete', testsPassed: null } as Partial<RoleOutput<R>>;
}
/** Absence is disclosed by existing optional sections. A selected but unavailable
 * producer is incomplete evidence and must not recommend approval. */
export function checkResultHoldApprove(read: RoleRead<CheckResultRole>): boolean {
  if (!read.producer || read.producer.stepId === STEP_ROLE_REGISTRY[read.role].legacyStepId)
    return false;
  if (read.state !== 'ready') return true;
  const status = read.data.resultStatus;
  return (
    status !== 'passed' &&
    !(
      read.role === CHECK_RESULT_ROLES.adversarialQa &&
      (status === 'clean' || status === 'findings')
    ) &&
    !(read.role === CHECK_RESULT_ROLES.testManagement && status === 'skipped')
  );
}

/** Historical reporting mines every round of the learning consumer's one pinned
 * producer, retaining physical event provenance and its historical round order. */
export function checkResultHistoryProducer(
  task: RoleTaskPin,
  role: CheckResultRole,
): string | null {
  const canonical = STEP_ROLE_REGISTRY[role].legacyStepId;
  if (task.dataEdgePlan == null) return canonical;
  const plan = parseDataEdgePlan(task.dataEdgePlan);
  const candidate = selectDataEdgeCandidate({ ...task, dataEdgePlan: task.dataEdgePlan }, plan);
  if (plan.selection === 'derived' && task.executionPath == null) return null;
  const input = candidate.nodes
    .find((n) => n.id === '11-phase-8-learning')
    ?.inputs.find((i) => i.role === role);
  if (!input) return canonical; // A valid older pin predates this input.
  const resolved = resolveDataInput(
    { ...task, dataEdgePlan: task.dataEdgePlan },
    '11-phase-8-learning',
    input.id,
    plan,
  );
  if (resolved.state !== 'active') return null;
  const contract = STEP_ROLE_REGISTRY[role].contract;
  if (
    resolved.declaration.role !== role ||
    resolved.declaration.contract.id !== contract.id ||
    resolved.declaration.contract.version !== contract.version
  )
    throw new DataEdgePlanError('history contract unavailable');
  return resolved.binding.producerStepId;
}
