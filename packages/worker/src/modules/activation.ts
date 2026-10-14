import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { parseStepId } from '@haive/shared/modularity';

export async function moduleDeactivationMessage(
  db: Database,
  stepId: string,
): Promise<string | null> {
  const parsed = parseStepId(stepId);
  if (parsed?.kind !== 'module') return null;
  const [row] = await db
    .select({ deactivatedAt: schema.modules.deactivatedAt })
    .from(schema.modules)
    .where(eq(schema.modules.moduleId, parsed.moduleId))
    .limit(1);
  if (!row?.deactivatedAt) return null;
  return (
    `Module ${parsed.moduleId} is deactivated, so step ${stepId} cannot run. ` +
    `Reactivate the module (Admin > Modules), then Retry the step.`
  );
}
