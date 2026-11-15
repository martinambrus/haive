import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared/logger';
import {
  resolveDataInput,
  parseDataEdgePlan,
  selectDataEdgeCandidate,
  DataEdgePlanError,
} from '@haive/shared/data-edge-plan';
import {
  STEP_ROLE_REGISTRY,
  SPEC_ROLES,
  projectRoleOutput,
  safeParseStepOutput,
  type SpecRoleId,
  type StepRoleId,
  type RoleOutput,
} from '@haive/shared/step-outputs';
import type { StepContext } from './step-definition.js';
import { loadPreviousStepOutput } from './steps/onboarding/_helpers.js';
import { promptRoleOutputValue } from './prompt-role-output.js';

type Producer<R extends StepRoleId> = {
  role: R;
  contract: (typeof STEP_ROLE_REGISTRY)[R]['contract'];
  producer: { rowId: string | null; stepId: string; round: number | null; status: string | null };
  iterations: unknown[];
  /** Declared fields from the SAME row, even for a reset or malformed historical output.
   * Only explicit host compatibility adapters use this; new consumers must require ready. */
  legacyOutput: Partial<RoleOutput<R>> | null;
};
export type RoleRead<R extends StepRoleId> =
  | {
      state: 'absent' | 'unselected';
      role: R;
      contract: (typeof STEP_ROLE_REGISTRY)[R]['contract'];
      producer: null;
    }
  | (Producer<R> & { state: 'not-ready' })
  | (Producer<R> & { state: 'invalid'; issuePaths: readonly string[] })
  | (Producer<R> & { state: 'ready'; data: RoleOutput<R> });

/** V3 reads the immutable consumer input at the current round ceiling. Without v3,
 * preserve canonical identity, tolerant historical output and the explicit ceiling. */
type ReadContext = Pick<StepContext, 'db' | 'taskId'> &
  Partial<Pick<StepContext, 'taskStepId' | 'round'>>;
export function readRole(
  ctx: ReadContext,
  input: 'draft',
  maxRound?: number,
): Promise<RoleRead<typeof SPEC_ROLES.draft>>;
export function readRole(
  ctx: ReadContext,
  input: 'checked',
  maxRound?: number,
): Promise<RoleRead<typeof SPEC_ROLES.checked>>;
export function readRole(
  ctx: ReadContext,
  input: 'resolved',
  maxRound?: number,
): Promise<RoleRead<typeof SPEC_ROLES.resolved>>;
export function readRole<R extends SpecRoleId>(
  ctx: ReadContext,
  input: R,
  maxRound?: number,
): Promise<RoleRead<R>>;
export async function readRole(
  ctx: ReadContext,
  input: SpecRoleId | keyof typeof SPEC_ROLES,
  maxRound?: number,
): Promise<RoleRead<SpecRoleId>> {
  return readDataRole(ctx, input, maxRound) as Promise<RoleRead<SpecRoleId>>;
}

/** Exact SDK input names can share a role without borrowing each other's binding. */
export async function readDataRole(
  ctx: ReadContext,
  input: StepRoleId | keyof typeof SPEC_ROLES,
  maxRound?: number,
  consumerInput?: string,
): Promise<RoleRead<StepRoleId>> {
  const namedInput = Object.hasOwn(SPEC_ROLES, input);
  const role = namedInput ? SPEC_ROLES[input as keyof typeof SPEC_ROLES] : (input as StepRoleId);
  const entry = STEP_ROLE_REGISTRY[role];
  if (!Object.hasOwn(STEP_ROLE_REGISTRY, role))
    throw new Error(`readRole cannot resolve unregistered role ${role}`);
  if ('hostPolicy' in entry && !consumerInput)
    throw new Error('readRole cannot resolve host-policy roles without per-input pins');
  const contract = entry.contract;
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { dataEdgePlan: true, executionPath: true, runListSnapshot: true },
  });
  let producerStepId: string = entry.legacyStepId;
  let ceiling = maxRound;
  let pinned = false;
  let required = false;
  let inputName: string = role;
  if (task?.dataEdgePlan != null) {
    const consumer =
      ctx.taskStepId &&
      (await ctx.db.query.taskSteps.findFirst({
        where: and(
          eq(schema.taskSteps.id, ctx.taskStepId),
          eq(schema.taskSteps.taskId, ctx.taskId),
        ),
        columns: { stepId: true, round: true },
      }));
    if (!consumer || ctx.round == null || consumer.round !== ctx.round)
      throw new DataEdgePlanError('consumer row/round mismatch');
    // Resolve the input name from the PIN, not today's declaration. The role overload is
    // retained for PR1 callers; host adapters use explicit per-input names.
    const plan = parseDataEdgePlan(task.dataEdgePlan);
    const candidate = selectDataEdgeCandidate(task, plan);
    if (plan.selection === 'derived' && task.executionPath == null)
      return { state: 'unselected', role, contract, producer: null };
    const node = candidate.nodes.find((n) => n.id === consumer.stepId);
    const inputs = node?.inputs.filter((i) => i.role === role) ?? [];
    if (!consumerInput && !namedInput && inputs.length > 1)
      throw new DataEdgePlanError('ambiguous consumer input');
    const portName = consumerInput ?? (namedInput ? input : inputs[0]?.id);
    const declaration = node?.inputs.find((i) => i.id === portName);
    if (!declaration) {
      // This input did not exist when the task was admitted. No binding is being
      // remapped: use exactly the no-v3 read, including its legacy round semantics.
      logger.debug(
        {
          taskId: ctx.taskId,
          consumer: consumer.stepId,
          input:
            consumerInput ??
            (namedInput
              ? input
              : (Object.keys(SPEC_ROLES).find(
                  (key) => SPEC_ROLES[key as keyof typeof SPEC_ROLES] === role,
                ) ?? role)),
        },
        'data input absent from v3 pin; reading canonically',
      );
    } else {
      pinned = true;
      inputName = declaration.id;
      const resolved = resolveDataInput(task, consumer.stepId, declaration.id, plan);
      if (resolved.state === 'unselected')
        return { state: 'unselected', role, contract, producer: null };
      if (
        resolved.declaration.role !== role ||
        resolved.declaration.contract.id !== contract.id ||
        resolved.declaration.contract.version !== contract.version
      )
        throw new DataEdgePlanError(
          `${consumer.stepId}.${declaration.id}: pinned contract unavailable`,
        );
      if (resolved.state === 'absent') return { state: 'absent', role, contract, producer: null };
      required = !resolved.declaration.optional;
      producerStepId = resolved.binding.producerStepId;
      ceiling = Math.min(maxRound ?? ctx.round, ctx.round);
    }
  }
  const row = await loadPreviousStepOutput(ctx.db, ctx.taskId, producerStepId, ceiling);
  if (required && (!row || row.status !== 'done'))
    throw new DataEdgePlanError(`${inputName}: required input not ready`);
  if (!row) return { state: 'absent', role, contract, producer: null };
  const output = row.stepId.startsWith('custom.')
    ? promptRoleOutputValue(row.output, role, contract)
    : row.output;
  const common = {
    role,
    contract,
    producer: { rowId: row.id, stepId: row.stepId, round: row.round, status: row.status },
    iterations: row.iterations,
    legacyOutput: pinned && row.status !== 'done' ? null : projectRoleOutput(role, output),
  };
  if (row.status !== 'done') return { ...common, state: 'not-ready' };
  const result = safeParseStepOutput(contract, output);
  if (!result.success) {
    if (required) throw new DataEdgePlanError(`${inputName}: required input invalid`);
    return { ...common, state: 'invalid', issuePaths: result.issuePaths };
  }
  return {
    ...common,
    state: 'ready',
    legacyOutput: projectRoleOutput(role, result.data),
    data: projectRoleOutput(role, result.data) as RoleOutput<StepRoleId>,
  };
}

/** PR1 host adapters preserve tolerant old-row reads, including absent spec fields and
 * non-done rows with retained output. Validation is diagnostic, never a new routing gate. */
export function legacyRoleOutput<R extends SpecRoleId>(read: RoleRead<R>): Partial<RoleOutput<R>> {
  return read.producer === null ? {} : (read.legacyOutput ?? {});
}
