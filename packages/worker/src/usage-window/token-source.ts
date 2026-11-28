import { SANDBOX_CORE_IMAGE } from '../sandbox/image-composer.js';
import type { AuthMode, CliProviderName } from '@haive/shared';
import { resolveCliAuthUserVolumeName } from '@haive/shared';
import type { Database } from '@haive/database';
import { readProviderSecret } from '../secrets/provider-secrets.js';
import { defaultDockerRunner, type DockerRunner } from '../sandbox/docker-runner.js';
import { shellQuote } from '../sandbox/shell-quote.js';

const HELPER_IMAGE = process.env.SANDBOX_IMAGE ?? SANDBOX_CORE_IMAGE;
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 15_000;
/** A successfully started read helper found no file. Other non-zero exits are failures. */
export const VOLUME_FILE_ABSENT_EXIT = 4;
/** A helper proved the named credential is a directory, FIFO, link or other non-file. */
export const VOLUME_FILE_NON_REGULAR_EXIT = 5;
export class NonRegularVolumeFileError extends Error {
  readonly code = 'AUTH_FILE_NOT_REGULAR';
  constructor(
    readonly volume: string,
    readonly relPath: string,
  ) {
    super('auth credential is not a regular file');
  }
}

/** Read a decrypted cli_provider_secret by name. Returns null when absent. */
export async function readProviderSecretToken(
  db: Database,
  providerId: string,
  secretName: string,
): Promise<string | null> {
  return readProviderSecret(db, providerId, secretName);
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
 *  what "the credential file" is. Sync-back opts into throwOnFailure so a failed or
 *  timed-out helper retains the task copy; poller callers keep best-effort null. */
export async function readVolumeFile(
  vol: string,
  relPath: string,
  runner: DockerRunner = defaultDockerRunner,
  options: { throwOnFailure?: boolean } = {},
): Promise<string | null> {
  if (!(await runner.volumeExists(vol, { throwOnFailure: options.throwOnFailure }))) return null;
  // relPath is a fixed constant from the provider registry, but strip quotes
  // defensively since it's interpolated into a shell command.
  const safeRel = relPath.replace(/["'`$]/g, '');
  const result = await runner.run({
    image: HELPER_IMAGE,
    entrypoint: '',
    user: 'root',
    cmd: [
      'sh',
      '-c',
      `if [ -L "/vol/${safeRel}" ] || { [ -e "/vol/${safeRel}" ] && [ ! -f "/vol/${safeRel}" ]; }; then exit ${VOLUME_FILE_NON_REGULAR_EXIT}; fi; cat "/vol/${safeRel}" 2>/dev/null || { [ ! -e "/vol/${safeRel}" ] && exit ${VOLUME_FILE_ABSENT_EXIT}; exit 1; }`,
    ],
    mounts: [{ source: vol, target: '/vol', readOnly: true }],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (result.exitCode === VOLUME_FILE_NON_REGULAR_EXIT && !result.timedOut) {
    if (options.throwOnFailure) throw new NonRegularVolumeFileError(vol, relPath);
    return null;
  }
  if (result.exitCode === VOLUME_FILE_ABSENT_EXIT && !result.timedOut) return null;
  if (result.exitCode !== 0 || result.timedOut) {
    if (options.throwOnFailure) throw new Error('auth file read helper failed');
    return null;
  }
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
