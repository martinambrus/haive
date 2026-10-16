import type { IntegrationExecutor, ModuleIntegrationExecutors } from '@haive/shared/module-host';

let executors: ReadonlyMap<string, ReadonlyMap<string, IntegrationExecutor>> = new Map();

/** Replaces the executors of every module; a call with none clears them. */
export function setModuleExecutors(all: readonly (ModuleIntegrationExecutors | undefined)[]): void {
  executors = new Map(
    all.flatMap((byProvider) =>
      Object.entries(byProvider ?? {}).map(
        ([providerId, byOperation]) => [providerId, new Map(Object.entries(byOperation))] as const,
      ),
    ),
  );
}

export const moduleExecutorOf = (
  providerId: string,
  opId: string,
): IntegrationExecutor | undefined => executors.get(providerId)?.get(opId);
