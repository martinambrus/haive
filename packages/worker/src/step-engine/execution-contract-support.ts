import {
  ExecutionContractError,
  executionContractPaths,
  parseExecutionContract,
} from '@haive/shared/modularity';
import type { RunListStrategy } from '@haive/shared/run-list';
import { registeredGuardPredicates } from './guard-predicates.js';
import { stepRegistry, type StepRegistry } from './registry.js';

export interface ExecutionContractScope {
  runListStrategy: RunListStrategy;
  runListSnapshot: readonly string[] | null | undefined;
  derivedRunPlan?: unknown;
}

/** Worker capability fence: a guarded pin runs only on a unique static snapshot whose
 * predicates this worker registers and whose spans do not start at the first step. A
 * custom fix target is refused. */
export function assertWorkerExecutionContractSupported(
  raw: unknown,
  scope: ExecutionContractScope,
  registry: StepRegistry = stepRegistry,
): void {
  if (raw == null) return;
  const contract = parseExecutionContract(raw);
  if (contract.fixTarget)
    throw new ExecutionContractError('a custom fix target is not yet supported by this worker');
  if (!contract.guardedSpans.length) return;
  const ids = scope.runListSnapshot;
  if (scope.runListStrategy !== 'static' || scope.derivedRunPlan != null)
    throw new ExecutionContractError('guarded spans need a static run list');
  if (!ids || new Set(ids).size !== ids.length)
    throw new ExecutionContractError('guarded spans need a unique pinned run list');
  executionContractPaths(ids, new Map(), contract, registeredGuardPredicates(registry));
  for (const span of contract.guardedSpans)
    if (ids.indexOf(span.firstStepId) < 1)
      throw new ExecutionContractError(`span-entry ${span.id}: first step must not lead the list`);
}
