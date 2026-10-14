import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { parseStepId } from '@haive/shared/modularity';

export class ModuleDeactivatedError extends Error {
  readonly moduleId: string;
  readonly stepId: string;
  constructor(moduleId: string, stepId: string) {
    super(
      `Module ${moduleId} is deactivated, so step ${stepId} cannot run. ` +
        `Reactivate the module (Admin > Modules), then Retry the step.`,
    );
    this.name = 'ModuleDeactivatedError';
    this.moduleId = moduleId;
    this.stepId = stepId;
  }
}

export async function assertModuleActive(db: Database, stepId: string): Promise<void> {
  const parsed = parseStepId(stepId);
  if (parsed?.kind !== 'module') return;
  const [row] = await db
    .select({ deactivatedAt: schema.modules.deactivatedAt })
    .from(schema.modules)
    .where(eq(schema.modules.moduleId, parsed.moduleId))
    .limit(1);
  if (row?.deactivatedAt) throw new ModuleDeactivatedError(parsed.moduleId, stepId);
}
