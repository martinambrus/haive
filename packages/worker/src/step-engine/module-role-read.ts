import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  DataEdgePlanError,
  parseDataEdgePlan,
  selectDataEdgeCandidate,
} from '@haive/shared/data-edge-plan';
import { STEP_ROLE_REGISTRY, SPEC_ROLES, type StepRoleId } from '@haive/shared/step-outputs';
import type { StepContext, ModuleRoleRead, StepDefinition } from '@haive/shared/step';
import { fencedAgentBlock } from '@haive/shared/step/prompts';
import { readDataRole } from './read-role.js';
import { stepRegistry } from './registry.js';

export async function loadModuleRoleOutput(
  ctx: StepContext,
  input: string,
): Promise<ModuleRoleRead> {
  const task = await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
  const consumer = await ctx.db.query.taskSteps.findFirst({
    where: eq(schema.taskSteps.id, ctx.taskStepId),
  });
  if (!consumer || consumer.taskId !== ctx.taskId || consumer.round !== ctx.round)
    throw new DataEdgePlanError('consumer row/round mismatch');
  let declaration;
  if (task?.dataEdgePlan != null) {
    const plan = parseDataEdgePlan(task.dataEdgePlan);
    const candidate = selectDataEdgeCandidate(task, plan);
    declaration = candidate.nodes
      .find((n) => n.id === consumer.stepId)
      ?.inputs.find((i) => i.id === input);
  }
  const live = stepRegistry.get(consumer.stepId)?.consumesRoles?.find((i) => i.input === input);
  const role = (declaration?.role ?? live?.role) as StepRoleId | undefined;
  const contract = declaration?.contract ?? live?.contract;
  if (!role || !Object.hasOwn(STEP_ROLE_REGISTRY, role) || !contract)
    throw new DataEdgePlanError(`${input}: undeclared input`);
  const entry = STEP_ROLE_REGISTRY[role];
  if (contract.id !== entry.contract.id || contract.version !== entry.contract.version)
    throw new DataEdgePlanError(`${input}: pinned contract unavailable`);
  const read = await readDataRole(ctx, role, ctx.round, input);
  if (!(declaration?.optional ?? live?.optional ?? true) && read.state !== 'ready')
    throw new DataEdgePlanError(`${input}: required input ${read.state}`);
  const common = { role: read.role, contract: read.contract, producer: read.producer };
  if (read.state === 'invalid') return { ...common, state: 'invalid', issuePaths: read.issuePaths };
  if (read.state !== 'ready') return { ...common, state: read.state };
  if (entry.authorship !== 'agent') {
    // Only registered host adapters may carry operator-authored data. Unknown authorship
    // never becomes generic quoted text, even if a module claims agentAuthoredOutput.
    if (!Object.values(SPEC_ROLES).includes(role as never))
      throw new DataEdgePlanError(`${input}: host adapter unavailable`);
    const { spec, ...attachments } = read.data as { spec: string; [key: string]: unknown };
    return {
      ...common,
      state: 'ready',
      data: {
        adapter: 'spec',
        assignment: spec,
        agentContext: fencedAgentBlock(JSON.stringify(attachments)),
      },
    };
  }
  return { ...common, state: 'ready', data: read.data };
}

/** Run before any module dispatch, including a resumed detect snapshot. */
export async function assertRequiredRoleInputs(
  ctx: StepContext,
  def: StepDefinition,
): Promise<void> {
  if (!def.metadata.id.startsWith('module.')) return;
  const task = await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
  const pinned =
    task?.dataEdgePlan != null
      ? selectDataEdgeCandidate(task).nodes.find((n) => n.id === def.metadata.id)
      : undefined;
  const required = pinned
    ? pinned.inputs.filter((i) => !i.optional).map((i) => i.id)
    : (def.consumesRoles ?? []).filter((i) => !i.optional).map((i) => i.input);
  for (const input of required) await ctx.host!.loadRoleOutput(input);
}
