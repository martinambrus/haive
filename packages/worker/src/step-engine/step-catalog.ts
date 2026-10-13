import { notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { parseStepId, type ComposableStepEntry } from '@haive/shared/modularity';
import type { StepRegistry } from './registry.js';
import { CORE_COMPOSABLE_STEPS } from './composable-core.js';
import { dispatchesAnyCli, dispatchesCli } from './steps/index.js';

export async function syncStepCatalog(
  db: Database,
  registry: StepRegistry,
  moduleComposables: ReadonlyMap<string, ComposableStepEntry> = new Map(),
): Promise<void> {
  const now = new Date();
  const defs = registry.all();
  const coreComposables = new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e] as const));
  const liveIds = defs.map((d) => d.metadata.id);

  await db.transaction(async (tx) => {
    for (const def of defs) {
      const meta = def.metadata;
      const parsed = parseStepId(meta.id);
      const composables = parsed?.kind === 'module' ? moduleComposables : coreComposables;
      const composableRow = {
        composable: composables.has(meta.id),
        entry: composables.get(meta.id) ?? null,
      };
      const row = {
        source: parsed?.kind === 'module' ? `module:${parsed.moduleId}` : 'core',
        title: meta.title,
        workflowType: meta.workflowType,
        dispatchesCli: dispatchesAnyCli(def),
        dispatchesStepCli: dispatchesCli(def),
        stepIndex: meta.index,
        allowSkip: meta.allowSkip === true,
        providerSensitive: meta.providerSensitive === true,
        cliRoles: meta.cliRoles ?? null,
        updatedAt: now,
        ...composableRow,
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
