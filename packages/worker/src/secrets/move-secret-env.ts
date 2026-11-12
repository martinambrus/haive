import { randomUUID } from 'node:crypto';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';
import { and, eq } from 'drizzle-orm';
import { schema, type CliAuthLock, type Database } from '@haive/database';
import { logger, secretsService, splitSecretLikeEnv, upsertProviderSecret } from '@haive/shared';
import { waitForCliAuthLock } from '../sandbox/cli-auth-lock.js';

const log = logger.child({ module: 'move-secret-env' });
const SECRET_ENV_AUTH_LOCK_WAIT_MS = 30_000;
const isAuthSecret = (name: string) =>
  name === 'CLAUDE_CODE_OAUTH_TOKEN' || name === CLAUDE_USAGE_OAUTH_SECRET;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Each provider whose envVars hold a secret-looking key, worked under its row lock in its own
 *  transaction; one that fails is logged and the rest still run. Returns how many failed. */
async function forEachLegacyProvider(
  db: Database,
  phase: string,
  lockWaitMs: number,
  work: (
    tx: Tx,
    providerId: string,
    envVars: Record<string, string>,
    assertHeld: () => Promise<void>,
  ) => Promise<void>,
): Promise<number> {
  let failed = 0;
  const providers = await db.query.cliProviders.findMany({
    columns: {
      id: true,
      envVars: true,
      userId: true,
      name: true,
      authMode: true,
      isolateAuth: true,
    },
  });
  for (const provider of providers) {
    if (Object.keys(splitSecretLikeEnv(provider.envVars ?? {}).secrets).length === 0) continue;
    const scope = cliAuthScope(provider);
    let release: CliAuthLock | null = null;
    try {
      if (Object.keys(splitSecretLikeEnv(provider.envVars ?? {}).secrets).some(isAuthSecret)) {
        release = await waitForCliAuthLock(db, scope, lockWaitMs);
        if (!release)
          throw new Error('CLI authentication is busy; provider secret migration was deferred');
      }
      await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            id: schema.cliProviders.id,
            envVars: schema.cliProviders.envVars,
            userId: schema.cliProviders.userId,
            name: schema.cliProviders.name,
            authMode: schema.cliProviders.authMode,
            isolateAuth: schema.cliProviders.isolateAuth,
          })
          .from(schema.cliProviders)
          .where(eq(schema.cliProviders.id, provider.id))
          .for('update');
        if (!locked) return;
        const secretNames = Object.keys(splitSecretLikeEnv(locked.envVars ?? {}).secrets);
        if (secretNames.length === 0) return;
        // Settings or secrets may have changed while the advisory lock was acquired.
        // Defer rather than write in another scope or wait while holding the row lock.
        if (
          (release && cliAuthScope(locked) !== scope) ||
          (!release && secretNames.some(isAuthSecret))
        )
          throw new Error(
            'CLI authentication settings changed; provider secret migration was deferred',
          );
        const assertHeld = async () => {
          await release?.assertHeld();
        };
        await work(tx, provider.id, locked.envVars ?? {}, assertHeld);
        await assertHeld();
      });
    } catch (err) {
      failed += 1;
      log.error({ err, providerId: provider.id, phase }, 'provider env secret migration failed');
    } finally {
      await release?.();
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
  assertHeld: () => Promise<void>,
): Promise<void> {
  for (const [name, value] of Object.entries(keys)) {
    const existing = isAuthSecret(name)
      ? await tx.query.cliProviderSecrets.findFirst({
          where: and(
            eq(schema.cliProviderSecrets.providerId, providerId),
            eq(schema.cliProviderSecrets.secretName, name),
          ),
          columns: { id: true },
        })
      : undefined;
    await assertHeld();
    await upsertProviderSecret(tx, { providerId, name, value, masterKek, onExisting: 'keep' });
    if (isAuthSecret(name) && !existing) {
      await tx
        .update(schema.cliProviders)
        .set({ authGeneration: randomUUID() })
        .where(eq(schema.cliProviders.id, providerId));
    }
  }
}

/** Boot half: copy secret-looking envVars keys into encrypted secrets, leaving envVars as they
 *  are, so the release before this one still finds them after a rollback. */
export async function copySecretLikeProviderEnv(db: Database): Promise<void> {
  let masterKek: string | undefined;
  // Convergent and retried next boot: a busy login must not delay worker startup.
  await forEachLegacyProvider(db, 'copy', 0, async (tx, providerId, envVars, assertHeld) => {
    masterKek ??= await secretsService.getMasterKek();
    await copyKeys(tx, providerId, splitSecretLikeEnv(envVars).secrets, masterKek, assertHeld);
  });
}

/** Committed-upgrade half: copy whatever the boot half did not, then drop the envVars copies, in
 *  one transaction per provider, so success means no secret is left in plain envVars. */
export async function dropCopiedSecretLikeProviderEnv(db: Database): Promise<void> {
  let masterKek: string | undefined;
  const failed = await forEachLegacyProvider(
    db,
    'drop',
    SECRET_ENV_AUTH_LOCK_WAIT_MS,
    async (tx, providerId, envVars, assertHeld) => {
      masterKek ??= await secretsService.getMasterKek();
      const split = splitSecretLikeEnv(envVars);
      await copyKeys(tx, providerId, split.secrets, masterKek, assertHeld);
      await tx
        .update(schema.cliProviders)
        .set({ envVars: split.envVars })
        .where(eq(schema.cliProviders.id, providerId));
    },
  );
  // Not retried at boot: a deferral fails runDestructiveDataMigrations, so retry the updater's
  // commit phase after contention/settings settle. The boot half only copies; it never drops.
  if (failed > 0) throw new Error(`${failed} provider(s) still hold a secret in plain envVars`);
}
