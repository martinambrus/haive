import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  computeKeyFingerprint,
  envelopeEncrypt,
  logger,
  secretsService,
  splitSecretLikeEnv,
} from '@haive/shared';

const log = logger.child({ module: 'move-secret-env' });

/** Move secret-looking keys left in a provider's plain envVars into its encrypted secrets, one
 *  transaction per provider. An existing secret of the same name wins; only the copy is dropped. */
export async function moveSecretLikeProviderEnv(db: Database): Promise<void> {
  const providers = await db.query.cliProviders.findMany({
    columns: { id: true, envVars: true },
  });
  for (const provider of providers) {
    if (Object.keys(splitSecretLikeEnv(provider.envVars ?? {}).secrets).length === 0) continue;
    const masterKek = await secretsService.getMasterKek();
    await db.transaction(async (tx) => {
      // Re-read under a row lock, so a PATCH saved since the scan above is neither lost nor raced.
      const [locked] = await tx
        .select({ envVars: schema.cliProviders.envVars })
        .from(schema.cliProviders)
        .where(eq(schema.cliProviders.id, provider.id))
        .for('update');
      if (!locked) return;
      const { envVars, secrets } = splitSecretLikeEnv(locked.envVars ?? {});
      const names = Object.keys(secrets);
      if (names.length === 0) return;
      const held = await tx.query.cliProviderSecrets.findMany({
        where: eq(schema.cliProviderSecrets.providerId, provider.id),
        columns: { secretName: true },
      });
      const heldNames = new Set(held.map((row) => row.secretName));
      for (const name of names) {
        if (heldNames.has(name)) {
          log.warn(
            { providerId: provider.id, key: name },
            'dropped an envVars copy of a key that already has a secret',
          );
          continue;
        }
        const value = secrets[name]!;
        await tx.insert(schema.cliProviderSecrets).values({
          providerId: provider.id,
          secretName: name,
          ...envelopeEncrypt(value, masterKek),
          fingerprint: computeKeyFingerprint(value),
        });
      }
      await tx
        .update(schema.cliProviders)
        .set({ envVars })
        .where(eq(schema.cliProviders.id, provider.id));
    });
  }
}
