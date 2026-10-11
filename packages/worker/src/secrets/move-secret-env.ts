import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, secretsService, splitSecretLikeEnv, upsertProviderSecret } from '@haive/shared';

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

/** Store each key as an encrypted secret; an existing secret of the same name wins. */
async function copyKeys(
  tx: Tx,
  providerId: string,
  keys: Record<string, string>,
  masterKek: string,
): Promise<void> {
  for (const [name, value] of Object.entries(keys)) {
    await upsertProviderSecret(tx, { providerId, name, value, masterKek, onExisting: 'keep' });
  }
}

/** Boot half: copy secret-looking envVars keys into encrypted secrets, leaving envVars as they
 *  are, so the release before this one still finds them after a rollback. */
export async function copySecretLikeProviderEnv(db: Database): Promise<void> {
  let masterKek: string | undefined;
  await forEachLegacyProvider(db, 'copy', async (tx, providerId, envVars) => {
    masterKek ??= await secretsService.getMasterKek();
    await copyKeys(tx, providerId, splitSecretLikeEnv(envVars).secrets, masterKek);
  });
}

/** Committed-upgrade half: copy whatever the boot half did not, then drop the envVars copies, in
 *  one transaction per provider, so success means no secret is left in plain envVars. */
export async function dropCopiedSecretLikeProviderEnv(db: Database): Promise<void> {
  let masterKek: string | undefined;
  const failed = await forEachLegacyProvider(db, 'drop', async (tx, providerId, envVars) => {
    masterKek ??= await secretsService.getMasterKek();
    const split = splitSecretLikeEnv(envVars);
    await copyKeys(tx, providerId, split.secrets, masterKek);
    await tx
      .update(schema.cliProviders)
      .set({ envVars: split.envVars })
      .where(eq(schema.cliProviders.id, providerId));
  });
  // Not retried at boot, so the updater must not commit while a copy remains.
  if (failed > 0) throw new Error(`${failed} provider(s) still hold a secret in plain envVars`);
}
