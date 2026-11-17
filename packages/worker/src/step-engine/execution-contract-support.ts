import { ExecutionContractError, parseExecutionContract } from '@haive/shared/modularity';

/** Worker-local capability fence. Deploy this worker before any API admission
 * activation; a newer shared/API policy cannot enable an unwired executor.
 * Keep this closed until the worker's guard and fix-target callers are wired. */
export function assertWorkerExecutionContractSupported(raw: unknown): void {
  if (raw == null) return;
  const contract = parseExecutionContract(raw);
  if (contract.guardedSpans.length || contract.fixTarget)
    throw new ExecutionContractError(
      'guarded spans or custom fix target not yet supported by this worker',
    );
}
