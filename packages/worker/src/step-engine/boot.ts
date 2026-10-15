import type { Database } from '@haive/database';
import {
  ensureModuleSchemas,
  publishWorkerBootReport,
  registerModuleSteps,
  type LoadedWorkerModule,
  type WorkerModuleEntry,
} from '../modules/loader.js';
import { deactivatedModuleIds } from '../modules/activation.js';
import { syncModuleIntent } from '../modules/intent.js';
import { getRedis } from '../redis.js';
import { assertCoreComposableCatalog } from './composable-core.js';
import { stepRegistry } from './registry.js';
import { syncStepCatalog } from './step-catalog.js';
import { syncTaskTypeDefinitions } from './task-type-seed.js';
import { registerAllSteps } from './steps/index.js';

let registered = false;
let moduleBoot: { loaded: LoadedWorkerModule[]; entries: readonly WorkerModuleEntry[] } | null =
  null;

export function registerStepsOnce(): void {
  if (registered) return;
  registerAllSteps(stepRegistry);
  registered = true;
}

async function registerModulesOnce() {
  if (moduleBoot) return moduleBoot;
  // Loaded at boot only: the generated file exists after codegen, not on every path that imports this.
  const { moduleRegistry } = await import('../modules.generated.js');
  const entries: readonly WorkerModuleEntry[] = moduleRegistry;
  moduleBoot = { loaded: registerModuleSteps(stepRegistry, entries), entries };
  return moduleBoot;
}

export async function bootStepEngine(db: Database): Promise<{
  loaded: LoadedWorkerModule[];
  entries: readonly WorkerModuleEntry[];
  deactivated: ReadonlySet<string>;
}> {
  registerStepsOnce();
  assertCoreComposableCatalog(stepRegistry);
  const { loaded, entries } = await registerModulesOnce();
  const composables = new Map(
    loaded.flatMap((m) => m.composable.map((c) => [c.stepId, c] as const)),
  );
  await syncStepCatalog(db, stepRegistry, composables);
  const deactivated = await deactivatedModuleIds(db);
  const schemas = await ensureModuleSchemas(db, loaded, entries, deactivated);
  // Before the seed: a module's task types read module-missing while its row is absent or missing.
  await syncModuleIntent(db, loaded);
  const taskTypes = await syncTaskTypeDefinitions(db, stepRegistry, loaded);
  await publishWorkerBootReport(getRedis(), loaded, schemas, taskTypes);
  return { loaded, entries, deactivated };
}
