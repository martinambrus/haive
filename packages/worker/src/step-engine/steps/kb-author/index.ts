import type { StepRegistry } from '../../registry.js';
import { kbAuthorEnrichStep } from './01-enrich.js';

export function registerKbAuthorSteps(registry: StepRegistry): void {
  registry.register(kbAuthorEnrichStep);
}
