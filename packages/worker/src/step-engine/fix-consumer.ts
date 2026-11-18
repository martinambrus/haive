import { parseExecutionContract, parseStepId } from '@haive/shared/modularity';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext } from '@haive/shared/step';
import { isFixRound } from './steps/workflow/_fix-loop.js';
import type { StepDefinition } from './step-definition.js';
import type { StepRegistry } from './registry.js';

export interface PinnedFixTarget {
  stepId: string;
  capabilityVersion: 1;
}

/** The fix target a task's pinned execution contract names; null when it names none. A
 *  malformed contract throws, it is never read as no target. */
export function pinnedFixTarget(contract: unknown): PinnedFixTarget | null {
  if (contract === null || contract === undefined) return null;
  return parseExecutionContract(contract).fixTarget ?? null;
}

export function resolvePinnedFixConsumer(
  target: PinnedFixTarget,
  registry: Pick<StepRegistry, 'get'>,
): { ok: true; def: StepDefinition } | { ok: false } {
  const def = registry.get(target.stepId);
  if (!def || !isCapableModuleStep(target, def)) return { ok: false };
  return { ok: true, def };
}

/** A fan-out step (`agentMining`) is never capable: repair evidence is captured only on
 *  the LLM phase, so a fan-out repair would run without its before and after snapshots. */
function isCapableModuleStep(target: PinnedFixTarget, def: StepDefinition | undefined): boolean {
  return (
    parseStepId(target.stepId)?.kind === 'module' &&
    def?.fixConsumer?.version === target.capabilityVersion &&
    def.agentMining === undefined
  );
}

export async function isPinnedFixRepair(ctx: StepContext, def: StepDefinition): Promise<boolean> {
  if (def.fixConsumer === undefined) return false;
  const row = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { executionContract: true },
  });
  const target = pinnedFixTarget(row?.executionContract);
  if (!target || target.stepId !== def.metadata.id || !isCapableModuleStep(target, def))
    return false;
  return isFixRound(ctx);
}
