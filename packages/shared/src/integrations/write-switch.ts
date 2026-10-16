import { eq } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import type { IntegrationBinding } from './tools.js';

/** A write operation is open when the task owner's switch for the provider is on. */
export async function writeAllowedBy(
  db: Database | DbTx,
  ownerId: string,
  connections: ReadonlyMap<string, unknown>,
): Promise<(binding: IntegrationBinding) => boolean> {
  const rows = await db
    .select({
      providerId: schema.integrationUserSettings.providerId,
      writeEnabled: schema.integrationUserSettings.writeEnabled,
    })
    .from(schema.integrationUserSettings)
    .where(eq(schema.integrationUserSettings.userId, ownerId));
  const switches = new Map(rows.map((row) => [row.providerId, row.writeEnabled]));
  return (binding) =>
    switches.get(binding.providerId) === true && connections.has(binding.connectionId);
}
