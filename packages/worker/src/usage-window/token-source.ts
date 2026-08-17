import type { AuthMode, CliProviderName } from '@haive/shared';
import {
  computeKeyFingerprint,
  envelopeEncrypt,
  resolveCliAuthUserVolumeName,
  secretsService,
} from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { resolveProviderSecrets } from '../secrets/provider-secrets.js';
import { defaultDockerRunner, type DockerRunner } from '../sandbox/docker-runner.js';

const HELPER_IMAGE = process.env.SANDBOX_IMAGE ?? 'haive-cli-sandbox:latest';
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 15_000;

/** Shell-quote a value for the `sh -c` script the write helper runs. Local rather than
 *  imported from sandbox/task-auth-volume.ts, which already imports this module — sharing
 *  it the other way would close an import cycle. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
  authMode: AuthMode;
  isolateAuth: boolean;
}

/** Read a file out of ANY named volume via a short-lived helper container that mounts it
 *  read-only. Returns the raw contents, or null when the volume or the file is absent.
 *  Split out from readAuthVolumeFile so the task-end auth sync can read a per-TASK volume
 *  with the same code path the poller uses on the user volume — the two must agree on
 *  what "the credential file" is. */
export async function readVolumeFile(
  vol: string,
  relPath: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<string | null> {
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

/** Write a file into ANY named volume via a short-lived helper container, atomically and
 *  owned by the sandbox user (1000). Returns false when the volume is absent or the helper
 *  fails.
 *
 *  Temp-then-rename, mirroring copyAuthFileBack: the file this writes is a live login, and
 *  a CLI that reads it mid-write sees a truncated credential and signs itself out. The
 *  rename is the only state any reader observes.
 *
 *  Deliberately dumb about WHAT it writes — the caller owns the merge. Nothing here
 *  reconciles concurrent writers, so only the singleton usage poller may call it against a
 *  user auth volume. */
export async function writeVolumeFile(
  vol: string,
  relPath: string,
  content: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<boolean> {
  if (!(await runner.volumeExists(vol))) return false;
  // relPath is a fixed constant from the provider registry, but strip quotes defensively
  // since it's interpolated into a shell command.
  const safeRel = relPath.replace(/["'`$]/g, '');
  const target = `/vol/${safeRel}`;
  const tmp = `${target}.haive-tmp`;
  const script = [
    'set -e',
    `mkdir -p "$(dirname ${shellQuote(target)})"`,
    `printf '%s' ${shellQuote(content)} > ${shellQuote(tmp)}`,
    `chown 1000:1000 ${shellQuote(tmp)}`,
    `chmod 600 ${shellQuote(tmp)}`,
    `mv ${shellQuote(tmp)} ${shellQuote(target)}`,
  ].join('\n');

  const result = await runner.run({
    image: HELPER_IMAGE,
    entrypoint: '',
    user: 'root',
    cmd: ['sh', '-c', script],
    mounts: [{ source: vol, target: '/vol', readOnly: false }],
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  return result.exitCode === 0;
}

/** Read a file from a provider's PERSISTENT user auth volume. The poller runs between
 *  tasks (no task container exists), so it mounts the user volume read-only and cats the
 *  file. Returns the raw file contents, or null when the volume or file is absent. */
export async function readAuthVolumeFile(
  ctx: AuthVolumeCtx,
  authPathIdx: number,
  relPath: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<string | null> {
  const vol = resolveCliAuthUserVolumeName(ctx, authPathIdx);
  return readVolumeFile(vol, relPath, runner);
}
