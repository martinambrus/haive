import type { Database } from '@haive/database';
import {
  ensureModuleSchemas,
  publishWorkerBootReport,
  registerModuleSteps,
  type LoadedWorkerModule,
  type WorkerModuleEntry,
} from '../modules/loader.js';
import { getRedis } from '../redis.js';
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

export async function bootStepEngine(
  db: Database,
): Promise<{ loaded: LoadedWorkerModule[]; entries: readonly WorkerModuleEntry[] }> {
  registerStepsOnce();
  const { loaded, entries } = await registerModulesOnce();
  const composables = new Map(
    loaded.flatMap((m) => m.composable.map((c) => [c.stepId, c] as const)),
  );
  await syncStepCatalog(db, stepRegistry, composables);
  await syncTaskTypeDefinitions(db, stepRegistry);
  const schemas = await ensureModuleSchemas(db, loaded, entries);
  await publishWorkerBootReport(getRedis(), loaded, schemas);
  return { loaded, entries };
}
