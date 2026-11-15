import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { DataEdgePlanError, selectDataEdgeCandidate } from '@haive/shared/data-edge-plan';
import { isQuotableRole, STEP_ROLE_REGISTRY, type StepRoleId } from '@haive/shared/step-outputs';
import { parsePromptTemplate, type PromptStepEntry } from '@haive/shared/modularity';
import type { StepContext } from './step-definition.js';
import { readDataRole, type RoleRead } from './read-role.js';

type WithoutLegacy<R> = R extends unknown ? Omit<R, 'iterations' | 'legacyOutput'> : never;
export type PromptRoleRead = WithoutLegacy<RoleRead<StepRoleId>>;

export async function loadPromptRoleInputs(
  ctx: StepContext,
  stepId: string,
  entry: PromptStepEntry,
): Promise<Record<string, PromptRoleRead>> {
  const tokens = parsePromptTemplate(entry.template);
  const named = tokens.ok ? tokens.tokens.flatMap((t) => (t.kind === 'role' ? [t.id] : [])) : [];
  if (named.length === 0 && !entry.consumesRoles?.length) return {};
  ctx.throwIfCancelled();
  const task = await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
  const pinned =
    task?.dataEdgePlan != null
      ? selectDataEdgeCandidate(task).nodes.find((n) => n.id === stepId)
      : undefined;
  const inputs = pinned?.inputs.map((i) => ({ ...i, input: i.id })) ?? entry.consumesRoles ?? [];
  const names = new Set([...named, ...inputs.filter((i) => !i.optional).map((i) => i.input)]);
  const out: Record<string, PromptRoleRead> = Object.create(null);
  for (const name of names) {
    const input = inputs.find((i) => i.input === name);
    if (!input || !isQuotableRole(input.role))
      throw new DataEdgePlanError(
        `${name}: role is undeclared or has no agent-only quote projection`,
      );
    const registered = STEP_ROLE_REGISTRY[input.role];
    if (
      input.contract.id !== registered.contract.id ||
      input.contract.version !== registered.contract.version
    )
      throw new DataEdgePlanError(`${name}: pinned contract unavailable`);
    const read = await readDataRole(ctx, input.role, ctx.round, name);
    if (!input.optional && read.state !== 'ready')
      throw new DataEdgePlanError(`${name}: required input ${read.state}`);
    if ('iterations' in read) {
      const { iterations: _iterations, legacyOutput: _legacy, ...view } = read;
      out[name] = view;
    } else out[name] = read;
  }
  ctx.throwIfCancelled();
  return out;
}
