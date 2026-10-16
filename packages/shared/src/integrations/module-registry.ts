import { isNotNull } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { CORE_FORGE_PROVIDER_SPECS } from '../forge/provider-specs.js';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '../modularity/contracts.js';
import type {
  IntegrationCategorySpec,
  IntegrationProviderSpec,
} from '../modularity/integrations.js';
import type { ModuleManifest } from '../modularity/manifest.js';

export interface IntegrationModule {
  id: string;
  name: string;
  providers: readonly IntegrationProviderSpec[];
  categories: readonly IntegrationCategorySpec[];
}

let modules: readonly IntegrationModule[] = [];
let providers: readonly IntegrationProviderSpec[] = CORE_FORGE_PROVIDER_SPECS;
let categories: readonly IntegrationCategorySpec[] = CORE_INTEGRATION_CATEGORY_SPECS;

/** Replaces the modules whose providers and categories are listed after the core ones; a deactivated module stays registered. */
export function registerModuleIntegrations(
  loaded: readonly {
    readonly manifest: Pick<ModuleManifest, 'id' | 'name' | 'integrations' | 'categories'>;
  }[],
): void {
  modules = loaded.map(({ manifest }) => ({
    id: manifest.id,
    name: manifest.name,
    providers: manifest.integrations ?? [],
    categories: manifest.categories ?? [],
  }));
  providers = [...CORE_FORGE_PROVIDER_SPECS, ...modules.flatMap((module) => module.providers)];
  categories = [
    ...CORE_INTEGRATION_CATEGORY_SPECS,
    ...modules.flatMap((module) => module.categories),
  ];
}

export const listIntegrationModules = (): readonly IntegrationModule[] => modules;
export const registeredProviders = (): readonly IntegrationProviderSpec[] => providers;
export const registeredCategories = (): readonly IntegrationCategorySpec[] => categories;

/** The modules deactivated now, read at each call; nothing is read while no module is registered. */
export async function loadDeactivatedModuleIds(db: Database | DbTx): Promise<ReadonlySet<string>> {
  if (modules.length === 0) return new Set();
  const rows = await db
    .select({ moduleId: schema.modules.moduleId })
    .from(schema.modules)
    .where(isNotNull(schema.modules.deactivatedAt));
  return new Set(rows.map((row) => row.moduleId));
}
