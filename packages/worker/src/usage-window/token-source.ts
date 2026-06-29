import type { CliProviderName } from '@haive/shared';
import {
  cliAuthProviderVolumeName,
  cliAuthVolumeName,
  computeKeyFingerprint,
  envelopeEncrypt,
  secretsService,
} from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { resolveProviderSecrets } from '../secrets/provider-secrets.js';
import { defaultDockerRunner, type DockerRunner } from '../sandbox/docker-runner.js';

const HELPER_IMAGE = process.env.SANDBOX_IMAGE ?? 'haive-cli-sandbox:latest';
const READ_TIMEOUT_MS = 15_000;

/** Read a decrypted cli_provider_secret by name. Returns null when absent. */
export async function readProviderSecretToken(
  db: Database,
  providerId: string,
  secretName: string,
): Promise<string | null> {
  const secrets = await resolveProviderSecrets(db, providerId);
  return secrets[secretName] ?? null;
}

/** Upsert a cli_provider_secret (envelope-encrypted). The usage poller calls this to
 *  persist a refreshed/rotated OAuth token. Mirrors the api login-banner writer; safe
 *  to call concurrently only from the singleton poller (no cross-process refresh race). */
export async function writeProviderSecret(
  db: Database,
  providerId: string,
  secretName: string,
  value: string,
): Promise<void> {
  const masterKek = await secretsService.getMasterKek();
  const env = envelopeEncrypt(value, masterKek);
  const fingerprint = computeKeyFingerprint(value);
  await db
    .insert(schema.cliProviderSecrets)
    .values({
      providerId,
      secretName,
      encryptedValue: env.encryptedValue,
      encryptedDek: env.encryptedDek,
      fingerprint,
    })
    .onConflictDoUpdate({
      target: [schema.cliProviderSecrets.providerId, schema.cliProviderSecrets.secretName],
      set: {
        encryptedValue: env.encryptedValue,
        encryptedDek: env.encryptedDek,
        fingerprint,
        updatedAt: new Date(),
      },
    });
}

export interface AuthVolumeCtx {
  userId: string;
  providerId: string;
  providerName: CliProviderName;
  isolateAuth: boolean;
}

/** Read a file from a provider's PERSISTENT user auth volume via a short-lived
 *  helper container. The poller runs between tasks (no task container exists), so
 *  it mounts the user volume read-only and cats the file. Returns the raw file
 *  contents, or null when the volume or file is absent. */
export async function readAuthVolumeFile(
  ctx: AuthVolumeCtx,
  authPathIdx: number,
  relPath: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<string | null> {
  const vol = ctx.isolateAuth
    ? cliAuthProviderVolumeName(ctx.providerId, ctx.providerName, authPathIdx)
    : cliAuthVolumeName(ctx.userId, ctx.providerName, authPathIdx);
  if (!(await runner.volumeExists(vol))) return null;
  // relPath is a fixed constant from the provider registry, but strip quotes
  // defensively since it's interpolated into a shell command.
  const safeRel = relPath.replace(/["'`$]/g, '');
  const result = await runner.run({
    image: HELPER_IMAGE,
    entrypoint: '',
    user: 'root',
    cmd: ['sh', '-c', `cat "/vol/${safeRel}" 2>/dev/null || true`],
    mounts: [{ source: vol, target: '/vol', readOnly: true }],
    timeoutMs: READ_TIMEOUT_MS,
  });
  const out = (result.stdout ?? '').trim();
  return out.length > 0 ? out : null;
}
