import { stepRegistry } from './registry.js';
import { registerAllSteps } from './steps/index.js';

let booted = false;

export function bootStepEngine(): void {
  if (booted) return;
  registerAllSteps(stepRegistry);
  booted = true;
}
