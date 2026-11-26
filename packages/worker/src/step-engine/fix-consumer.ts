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
import { fixConsumerCapability } from './fix-consumer-capability.js';

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

/** Historical readers predate execution pins: absent or malformed pins retain their
 * old 07 projection. This is never a routing/admission fallback; those fail closed. */
export function historicalFixTargetStepId(contract: unknown): string {
  try {
    return pinnedFixTarget(contract)?.stepId ?? FIX_LOOP_TARGET_STEP_ID;
  } catch (err) {
    if (!(err instanceof ExecutionContractError)) throw err;
    return FIX_LOOP_TARGET_STEP_ID;
  }
}

export async function loadHistoricalFixTargetStepId(
  db: StepContext['db'],
  taskId: string,
): Promise<string> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { executionContract: true },
  });
  return historicalFixTargetStepId(task?.executionContract);
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
 *  must be a capable module step at the pinned version. This helper returns null for an
 *  unregistered target; deadTaskResolution's execution-contract fence runs first and refuses it
 *  before unresolved-step checks. A malformed contract throws, never read as no target. */
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
  const def = registry.get(target.stepId);
  if (!def) return null;
  if (def.fixConsumer !== undefined && def.agentMining !== undefined)
    return `the pinned fix target ${target.stepId} uses fan-out, which cannot capture repair evidence`;
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
    fixConsumerCapability(def)?.version === target.capabilityVersion
  );
}

/** A capable module executable selected by this task's immutable fix-target pin. */
export async function isPinnedFixConsumer(ctx: StepContext, def: StepDefinition): Promise<boolean> {
  if (def.fixConsumer === undefined) return false;
  const row = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { executionContract: true },
  });
  const target = pinnedFixTarget(row?.executionContract);
  return !!target && target.stepId === def.metadata.id && isCapableModuleStep(target, def);
}

export async function isPinnedFixRepair(ctx: StepContext, def: StepDefinition): Promise<boolean> {
  return (await isPinnedFixConsumer(ctx, def)) && (await isFixRound(ctx));
}

/** Whether a step runs: its own `shouldRun`, or the repair round of the fix target a task pinned.
 *  A pinned target's repair round is never suppressed by its own `shouldRun`; 07 guarantees this
 *  in its own `shouldRun`, a module step cannot. */
export async function stepRunDecision(ctx: StepContext, def: StepDefinition): Promise<boolean> {
  const own = def.shouldRun ? !!(await def.shouldRun(ctx)) : true;
  return own || (await isPinnedFixRepair(ctx, def));
}
