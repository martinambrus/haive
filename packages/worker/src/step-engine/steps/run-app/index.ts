import type { StepRegistry } from '../../registry.js';
import { runAppReadyStep } from './99-run-app-ready.js';

/** run_app task steps. The env + runtime steps a run_app task uses are reused
 *  BY ID from the workflow / env-replicate sets (assembled in buildRunAppRunList,
 *  task-queue.ts); the only run_app-native step is the terminal hold/Finish gate. */
export function registerRunAppSteps(registry: StepRegistry): void {
  registry.register(runAppReadyStep);
}
