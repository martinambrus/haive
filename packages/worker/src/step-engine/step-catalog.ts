import { notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { StepRegistry } from './registry.js';
import { dispatchesCli } from './steps/index.js';

export async function syncStepCatalog(db: Database, registry: StepRegistry): Promise<void> {
  const now = new Date();
  const defs = registry.all();
  const liveIds = defs.map((d) => d.metadata.id);

  await db.transaction(async (tx) => {
    for (const def of defs) {
      const meta = def.metadata;
      const row = {
        source: 'core',
        title: meta.title,
        workflowType: meta.workflowType,
        dispatchesCli: dispatchesCli(def),
        allowSkip: meta.allowSkip === true,
        providerSensitive: meta.providerSensitive === true,
        cliRoles: meta.cliRoles ?? null,
        updatedAt: now,
      };
      await tx
        .insert(schema.stepCatalog)
        .values({ stepId: meta.id, ...row })
        .onConflictDoUpdate({ target: schema.stepCatalog.stepId, set: row });
    }
    if (liveIds.length === 0) await tx.delete(schema.stepCatalog);
    else await tx.delete(schema.stepCatalog).where(notInArray(schema.stepCatalog.stepId, liveIds));
  });
}
