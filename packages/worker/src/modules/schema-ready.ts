// Boot skipped or outran these modules' schema ensures, or a teardown hook began on them, and no
// ensure of theirs has succeeded since. 'failed' is an unready module whose attempts ran out.
const unready = new Map<string, 'pending' | 'failed'>();
const teardownsRunning = new Set<string>();

export function markModuleSchemaUnready(moduleId: string): void {
  unready.set(moduleId, 'pending');
}

export function markModuleSchemaFailed(moduleId: string): void {
  if (unready.has(moduleId)) unready.set(moduleId, 'failed');
}

export function markModuleSchemaReady(moduleId: string): void {
  unready.delete(moduleId);
}

export const moduleSchemaUnready = (moduleId: string): boolean => unready.has(moduleId);

export const moduleSchemaFailed = (moduleId: string): boolean => unready.get(moduleId) === 'failed';

export function markModuleTeardownRunning(moduleId: string): () => void {
  teardownsRunning.add(moduleId);
  return () => {
    teardownsRunning.delete(moduleId);
  };
}

export const moduleTeardownRunning = (moduleId: string): boolean => teardownsRunning.has(moduleId);
