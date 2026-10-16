import { eq } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { parseProviderId } from '../modularity/contracts.js';
import type { IntegrationProviderSpec } from '../modularity/integrations.js';
import { loadDeactivatedModuleIds, registeredProviders } from './module-registry.js';

export type ProviderState =
  'enabled' | 'disabled' | 'module-deactivated' | 'module-missing' | 'unknown';

export function listIntegrationProviders(): readonly IntegrationProviderSpec[] {
  return registeredProviders();
}

export function getIntegrationProvider(providerId: string): IntegrationProviderSpec | undefined {
  return listIntegrationProviders().find((provider) => provider.id === providerId);
}

/** What a provider with no row is: on for a registered core provider only. */
export function defaultProviderEnabled(providerId: string): boolean {
  return (
    parseProviderId(providerId)?.kind === 'core' && getIntegrationProvider(providerId) !== undefined
  );
}

/** The admin's switch when there is a row for the provider, else its default. */
async function switchedOn(db: Database | DbTx, providerId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: schema.integrationProviderConfigs.enabled })
    .from(schema.integrationProviderConfigs)
    .where(eq(schema.integrationProviderConfigs.providerId, providerId));
  return row ? row.enabled : defaultProviderEnabled(providerId);
}

async function moduleDeactivated(db: Database | DbTx, providerId: string): Promise<boolean> {
  const parsed = parseProviderId(providerId);
  if (parsed?.kind !== 'module' || getIntegrationProvider(providerId) === undefined) return false;
  const [row] = await db
    .select({ deactivatedAt: schema.modules.deactivatedAt })
    .from(schema.modules)
    .where(eq(schema.modules.moduleId, parsed.moduleId));
  return row?.deactivatedAt != null;
}

export async function isProviderEnabled(db: Database | DbTx, providerId: string): Promise<boolean> {
  return (await switchedOn(db, providerId)) && !(await moduleDeactivated(db, providerId));
}

/** Why a provider is or is not usable now; the module's deactivation comes before the admin's switch. */
export async function providerState(
  db: Database | DbTx,
  providerId: string,
): Promise<ProviderState> {
  if (getIntegrationProvider(providerId) === undefined) {
    return parseProviderId(providerId)?.kind === 'module' ? 'module-missing' : 'unknown';
  }
  if (await moduleDeactivated(db, providerId)) return 'module-deactivated';
  return (await switchedOn(db, providerId)) ? 'enabled' : 'disabled';
}

/** The switch of every registered provider, as isProviderEnabled reads it, from two queries at most. */
export async function loadProviderEnablement(
  db: Database | DbTx,
): Promise<ReadonlyMap<string, boolean>> {
  const rows = await db
    .select({
      providerId: schema.integrationProviderConfigs.providerId,
      enabled: schema.integrationProviderConfigs.enabled,
    })
    .from(schema.integrationProviderConfigs);
  const configured = new Map(rows.map((row) => [row.providerId, row.enabled]));
  const deactivated = await loadDeactivatedModuleIds(db);
  return new Map(
    listIntegrationProviders().map((provider) => {
      const parsed = parseProviderId(provider.id);
      const off = parsed?.kind === 'module' && deactivated.has(parsed.moduleId);
      return [
        provider.id,
        !off && (configured.get(provider.id) ?? defaultProviderEnabled(provider.id)),
      ];
    }),
  );
}
