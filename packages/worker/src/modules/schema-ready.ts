// Boot skipped or outran these modules' schema ensures, or a teardown hook began on them,
// and no ensure of theirs has succeeded since.
const unready = new Set<string>();

export function markModuleSchemaUnready(moduleId: string): void {
  unready.add(moduleId);
}

export function markModuleSchemaReady(moduleId: string): void {
  unready.delete(moduleId);
}

export const moduleSchemaUnready = (moduleId: string): boolean => unready.has(moduleId);
