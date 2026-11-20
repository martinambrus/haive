import { randomUUID } from 'node:crypto';
import { and, eq, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { resolveCliAuthUserVolumeName } from './cli-providers/auth-volume.js';
import { lockLoginSet } from './cli-providers/login-set.js';
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

/** The rows that share one login: the row itself when isolated, else same user, CLI, auth mode. */
export function cliAuthSetWhere(provider: CliAuthProvider): SQL {
  return provider.isolateAuth
    ? eq(schema.cliProviders.id, provider.id)
    : and(
        eq(schema.cliProviders.userId, provider.userId),
        eq(schema.cliProviders.name, provider.name),
        eq(schema.cliProviders.authMode, provider.authMode),
        eq(schema.cliProviders.isolateAuth, false),
      )!;
}

/** A volume login changes the credential of every row sharing that volume. Call while
 * holding its auth lock. Token refresh and abandoned login do not count as a new login.
 * The set is locked first, in id order, so the update never holds one row while it waits for
 * a lower id that the image job, which locks provider rows without the auth lock, holds. */
export async function advanceVolumeLoginGeneration(
  db: Database,
  provider: CliAuthProvider,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLoginSet(tx, provider);
    await tx
      .update(schema.cliProviders)
      .set({ authGeneration: randomUUID() })
      .where(cliAuthSetWhere(provider));
  });
}
