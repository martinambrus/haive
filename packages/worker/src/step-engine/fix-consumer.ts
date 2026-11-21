import {
  ExecutionContractError,
  FIX_LOOP_TARGET_STEP_ID,
  parseExecutionContract,
  parseStepId,
  pinnedTaskStepIds,
} from '@haive/shared/modularity';
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

/** Why this worker cannot run the fix target a task pinned, or null when it can or the task pins
 *  none. A target that is not on the task's pinned run list can never be routed. A registered one
 *  must be a capable module step at the pinned version. An unregistered one is left to the
 *  unresolved-step check, so a missing module keeps that path's wording. A malformed contract
 *  throws, it is never read as no target. */
export function unsupportedPinnedFixTarget(
  task: {
    executionContract?: unknown;
    runListSnapshot?: readonly string[] | null;
    derivedRunPlan?: unknown;
    executionPath?: string | null;
  },
  registry: Pick<StepRegistry, 'get'>,
): string | null {
  const target = pinnedFixTarget(task.executionContract);
  if (!target) return null;
  const runList = pinnedTaskStepIds(task);
  if (runList !== null && !runList.includes(target.stepId))
    return `the pinned fix target ${target.stepId} is not in the run list of this task`;
  if (!registry.get(target.stepId)) return null;
  return resolvePinnedFixConsumer(target, registry).ok
    ? null
    : `the pinned fix target ${target.stepId} is not a registered module step with fix consumer version ${target.capabilityVersion} on this worker`;
}

/** Advisory option list for a gate; the router still fails the task by name at Continue. */
export function fixRoundTargetDef(
  contract: unknown,
  registry: Pick<StepRegistry, 'get'>,
): StepDefinition | undefined {
  let pin: PinnedFixTarget | null;
  try {
    pin = pinnedFixTarget(contract);
  } catch (err) {
    if (err instanceof ExecutionContractError) return undefined;
    throw err;
  }
  if (!pin) return registry.get(FIX_LOOP_TARGET_STEP_ID);
  const resolved = resolvePinnedFixConsumer(pin, registry);
  return resolved.ok ? resolved.def : undefined;
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

/** Whether a step runs: its own `shouldRun`, or the repair round of the fix target a task pinned.
 *  A pinned target's repair round is never suppressed by its own `shouldRun`; 07 guarantees this
 *  in its own `shouldRun`, a module step cannot. */
export async function stepRunDecision(ctx: StepContext, def: StepDefinition): Promise<boolean> {
  return ((await def.shouldRun?.(ctx)) ?? true) || (await isPinnedFixRepair(ctx, def));
}
