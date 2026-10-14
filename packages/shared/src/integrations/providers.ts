import { eq } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { CORE_FORGE_PROVIDER_SPECS } from '../forge/provider-specs.js';
import { parseProviderId } from '../modularity/contracts.js';
import type { IntegrationProviderSpec } from '../modularity/integrations.js';

export function listIntegrationProviders(): readonly IntegrationProviderSpec[] {
  return CORE_FORGE_PROVIDER_SPECS;
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
export async function isProviderEnabled(db: Database | DbTx, providerId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: schema.integrationProviderConfigs.enabled })
    .from(schema.integrationProviderConfigs)
    .where(eq(schema.integrationProviderConfigs.providerId, providerId));
  return row ? row.enabled : defaultProviderEnabled(providerId);
}

/** The switch of every registered provider, as isProviderEnabled reads it, from one query. */
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
  return new Map(
    listIntegrationProviders().map((provider) => [
      provider.id,
      configured.get(provider.id) ?? defaultProviderEnabled(provider.id),
    ]),
  );
}
