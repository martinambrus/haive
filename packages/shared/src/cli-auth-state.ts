import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { resolveCliAuthUserVolumeName } from './cli-providers/auth-volume.js';
import type { AuthMode, CliProviderName } from './types/index.js';

export interface CliAuthProvider {
  id: string;
  userId: string;
  name: CliProviderName;
  authMode: AuthMode;
  isolateAuth: boolean;
}

/** Shared rows must serialize on the actual credential namespace, not their row ids. */
export function cliAuthScope(provider: CliAuthProvider): string {
  return resolveCliAuthUserVolumeName(
    {
      userId: provider.userId,
      providerId: provider.id,
      providerName: provider.name,
      authMode: provider.authMode,
      isolateAuth: provider.isolateAuth,
    },
    0,
  );
}

/** A volume login changes the credential of every row sharing that volume. Call while
 * holding its auth lock. Token refresh and abandoned login do not count as a new login. */
export async function advanceVolumeLoginGeneration(
  db: Database,
  provider: CliAuthProvider,
): Promise<void> {
  await db
    .update(schema.cliProviders)
    .set({ authGeneration: randomUUID() })
    .where(
      provider.isolateAuth
        ? eq(schema.cliProviders.id, provider.id)
        : and(
            eq(schema.cliProviders.userId, provider.userId),
            eq(schema.cliProviders.name, provider.name),
            eq(schema.cliProviders.authMode, provider.authMode),
            eq(schema.cliProviders.isolateAuth, false),
          ),
    );
}
