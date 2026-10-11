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

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Each provider whose envVars hold a secret-looking key, worked under its row lock in its own
 *  transaction; one that fails is logged and the rest still run. Returns how many failed. */
async function forEachLegacyProvider(
  db: Database,
  phase: string,
  work: (tx: Tx, providerId: string, envVars: Record<string, string>) => Promise<void>,
): Promise<number> {
  let failed = 0;
  const providers = await db.query.cliProviders.findMany({
    columns: { id: true, envVars: true },
  });
  for (const provider of providers) {
    if (Object.keys(splitSecretLikeEnv(provider.envVars ?? {}).secrets).length === 0) continue;
    try {
      await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ envVars: schema.cliProviders.envVars })
          .from(schema.cliProviders)
          .where(eq(schema.cliProviders.id, provider.id))
          .for('update');
        if (locked) await work(tx, provider.id, locked.envVars ?? {});
      });
    } catch (err) {
      failed += 1;
      log.error({ err, providerId: provider.id, phase }, 'provider env secret migration failed');
    }
  }
  return failed;
}

/** Boot half: copy secret-looking envVars keys into encrypted secrets, leaving envVars as they
 *  are, so the release before this one still finds them after a rollback. An existing secret wins. */
export async function copySecretLikeProviderEnv(db: Database): Promise<void> {
  let masterKek: string | undefined;
  await forEachLegacyProvider(db, 'copy', async (tx, providerId, envVars) => {
    masterKek ??= await secretsService.getMasterKek();
    for (const [name, value] of Object.entries(splitSecretLikeEnv(envVars).secrets)) {
      await tx
        .insert(schema.cliProviderSecrets)
        .values({
          providerId,
          secretName: name,
          ...envelopeEncrypt(value, masterKek),
          fingerprint: computeKeyFingerprint(value),
        })
        .onConflictDoUpdate({
          target: [schema.cliProviderSecrets.providerId, schema.cliProviderSecrets.secretName],
          set: { secretName: name },
        });
    }
  });
}

/** Committed-upgrade half: drop the envVars copy of each secret-looking key that now has a secret.
 *  A key whose copy into secrets never landed stays where it is. */
export async function dropCopiedSecretLikeProviderEnv(db: Database): Promise<void> {
  const failed = await forEachLegacyProvider(db, 'drop', async (tx, providerId, envVars) => {
    const held = await tx.query.cliProviderSecrets.findMany({
      where: eq(schema.cliProviderSecrets.providerId, providerId),
      columns: { secretName: true },
    });
    const heldNames = new Set(held.map((row) => row.secretName));
    const secretLike = splitSecretLikeEnv(envVars).secrets;
    const kept = Object.fromEntries(
      Object.entries(envVars).filter(([name]) => !(name in secretLike && heldNames.has(name))),
    );
    if (Object.keys(kept).length === Object.keys(envVars).length) return;
    await tx
      .update(schema.cliProviders)
      .set({ envVars: kept })
      .where(eq(schema.cliProviders.id, providerId));
  });
  // Not retried at boot, so the updater must not commit while a copy remains.
  if (failed > 0) throw new Error(`${failed} provider(s) still hold a secret in plain envVars`);
}
