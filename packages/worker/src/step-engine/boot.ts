import type { Database } from '@haive/database';
import { stepRegistry } from './registry.js';
import { syncStepCatalog } from './step-catalog.js';
import { syncTaskTypeDefinitions } from './task-type-seed.js';
import { registerAllSteps } from './steps/index.js';

let registered = false;

export function registerStepsOnce(): void {
  if (registered) return;
  registerAllSteps(stepRegistry);
  registered = true;
}

export async function bootStepEngine(db: Database): Promise<void> {
  registerStepsOnce();
  await syncStepCatalog(db, stepRegistry);
  await syncTaskTypeDefinitions(db, stepRegistry);
}
