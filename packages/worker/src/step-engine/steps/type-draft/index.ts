import type { StepRegistry } from '../../registry.js';
import { typeDraftStep } from './01-type-draft.js';

export function registerTypeDraftSteps(registry: StepRegistry): void {
  registry.register(typeDraftStep);
}
