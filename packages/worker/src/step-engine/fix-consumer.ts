import { parseExecutionContract, parseStepId } from '@haive/shared/modularity';
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
  if (parseStepId(target.stepId)?.kind !== 'module') return { ok: false };
  const def = registry.get(target.stepId);
  if (!def?.fixConsumer || def.fixConsumer.version !== target.capabilityVersion)
    return { ok: false };
  return { ok: true, def };
}
