import { CORE_INTEGRATION_CATEGORY_SPECS } from '../modularity/contracts.js';
import type { IntegrationCategorySpec } from '../modularity/integrations.js';

export function listIntegrationCategories(): readonly IntegrationCategorySpec[] {
  return CORE_INTEGRATION_CATEGORY_SPECS;
}
