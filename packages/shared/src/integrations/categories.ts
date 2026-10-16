import type { IntegrationCategorySpec } from '../modularity/integrations.js';
import { registeredCategories } from './module-registry.js';

export function listIntegrationCategories(): readonly IntegrationCategorySpec[] {
  return registeredCategories();
}
