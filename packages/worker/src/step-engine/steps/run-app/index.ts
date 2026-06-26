import type { StepRegistry } from '../../registry.js';
import { chooseViewStep } from './98-choose-view.js';
import { runAppReadyStep } from './99-run-app-ready.js';

/** run_app task steps. The env + runtime steps a run_app task uses are reused
 *  BY ID from the workflow / env-replicate sets (assembled in buildRunAppRunList,
 *  task-queue.ts); the run_app-native steps are the viewing-mode gate and the
 *  terminal hold/Finish gate. */
export function registerRunAppSteps(registry: StepRegistry): void {
  registry.register(chooseViewStep);
  registry.register(runAppReadyStep);
}
