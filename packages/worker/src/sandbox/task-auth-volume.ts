import { existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  CLI_PROVIDER_LIST,
  cliAuthTaskVolumeName,
  cliAuthVolumeName,
  getCliProviderMetadata,
  logger,
} from '@haive/shared';
import type { CliProviderName } from '@haive/shared';
import { defaultDockerRunner, type DockerRunner, type DockerVolumeMount } from './docker-runner.js';
import { expandTildeToSandbox } from './cli-auth-volume.js';

const log = logger.child({ module: 'task-auth-volume' });

const HELPER_IMAGE = process.env.SANDBOX_IMAGE ?? 'haive-cli-sandbox:latest';
const READY_MARKER = '.haive-ready';
const HELPER_TIMEOUT_MS = 60_000;

// Worker bind-mounts user HOME read-only at /host-fs. HOST_REPO_ROOT_REAL is
// the same directory as seen by the docker daemon (i.e. the absolute host path)
// — required when emitting bind mounts back out to per-task sandbox containers.
const HOST_FS_ROOT = process.env.HOST_REPO_ROOT ?? '/host-fs';
const HOST_REAL_ROOT = process.env.HOST_REPO_ROOT_REAL ?? process.env.HOME ?? '/';

function hostRelativeOfTilde(p: string): string | null {
  if (p === '~') return '';
  if (p.startsWith('~/')) return p.slice(2);
  return null;
}

export async function ensureTaskAuthVolumes(
  userId: string,
  providerName: CliProviderName,
  taskId: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  const meta = getCliProviderMetadata(providerName);
  for (let idx = 0; idx < meta.authConfigPaths.length; idx += 1) {
    const userVol = cliAuthVolumeName(userId, providerName, idx);
    const taskVol = cliAuthTaskVolumeName(taskId, providerName, idx);

    if (await runner.volumeExists(taskVol)) {
      if (await isTaskVolumeReady(taskVol, runner)) {
        continue;
      }
      log.warn({ taskVol }, 'task auth volume exists but not ready, recreating');
      const removed = await runner.volumeRemove(taskVol);
      if (!removed.ok) {
        throw new Error(
          `Failed to remove stale task auth volume ${taskVol}: ${removed.stderr || 'unknown error'}`,
        );
      }
    }

    const created = await runner.volumeCreate(taskVol);
    if (!created.ok) {
      throw new Error(
        `Failed to create task auth volume ${taskVol}: ${created.stderr || 'unknown error'}`,
      );
    }

    const userHasData = await runner.volumeExists(userVol);
    const mounts: DockerVolumeMount[] = [{ source: taskVol, target: '/dst', readOnly: false }];
    if (userHasData) {
      mounts.push({ source: userVol, target: '/src', readOnly: true });
    }

    // Docker creates the named-volume mountpoint owned by root. The CLI sandbox
    // runs as node (uid 1000), so we must chown the volume root (and any copied
    // contents) to 1000:1000 before the CLI can write into the mount.
    const copyScript = userHasData
      ? `cp -a /src/. /dst/ 2>/dev/null || true; chown -R 1000:1000 /dst; touch /dst/${READY_MARKER}`
      : `chown 1000:1000 /dst; touch /dst/${READY_MARKER}`;

    const result = await runner.run({
      image: HELPER_IMAGE,
      cmd: ['bash', '-c', copyScript],
      mounts,
      entrypoint: '',
      user: 'root',
      timeoutMs: HELPER_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      log.warn(
        { taskVol, userVol, exitCode: result.exitCode, stderr: result.stderr.slice(-500) },
        'task auth volume copy helper exited non-zero',
      );
      throw new Error(
        `Task auth volume copy failed for ${taskVol} (exit ${result.exitCode ?? 'unknown'})`,
      );
    }

    log.info({ taskVol, userVol, userHasData }, 'task auth volume ready');
  }
}

async function isTaskVolumeReady(taskVol: string, runner: DockerRunner): Promise<boolean> {
  // Verify both the readiness marker AND that the volume root is owned by the
  // sandbox user (1000). Early versions of ensureTaskAuthVolumes left the mount
  // root owned by root, which the CLI cannot write to. Treating those as stale
  // forces a recreate on first use.
  const result = await runner.run({
    image: HELPER_IMAGE,
    cmd: ['sh', '-c', `test -f /x/${READY_MARKER} && [ "$(stat -c %u /x)" = "1000" ]`],
    mounts: [{ source: taskVol, target: '/x', readOnly: true }],
    entrypoint: '',
    user: 'root',
    timeoutMs: 15_000,
  });
  return result.exitCode === 0;
}

/** True when at least one of the provider's per-path user auth volumes exists. */
export async function userAuthVolumeExists(
  userId: string,
  providerName: CliProviderName,
  runner: DockerRunner = defaultDockerRunner,
): Promise<boolean> {
  const meta = getCliProviderMetadata(providerName);
  for (let idx = 0; idx < meta.authConfigPaths.length; idx += 1) {
    const userVol = cliAuthVolumeName(userId, providerName, idx);
    if (await runner.volumeExists(userVol)) return true;
  }
  return false;
}

export function resolveTaskAuthMounts(
  providerName: CliProviderName,
  taskId: string,
): DockerVolumeMount[] {
  const meta = getCliProviderMetadata(providerName);
  return meta.authConfigPaths.map((raw, idx) => ({
    source: cliAuthTaskVolumeName(taskId, providerName, idx),
    target: expandTildeToSandbox(raw),
    readOnly: false,
  }));
}

/**
 * Build per-CLI bind mounts for user-level skills dirs, with a host-side
 * fallback chain. For each `userSkillsPaths` entry the canonical host path is
 * checked first; if absent and a `fallbackHost` is configured (e.g. codex
 * falling back to `~/.claude/skills`), the fallback is bound at the same
 * container path. Missing on both = no mount emitted, which is correct — the
 * container simply has no pre-existing user skills and onboarding will seed
 * the repo-level dir.
 *
 * Read-only is enforced: the task sandbox must never write back into the
 * user's host skills directory.
 */
export function resolveTaskSkillMounts(providerName: CliProviderName): DockerVolumeMount[] {
  const meta = getCliProviderMetadata(providerName);
  const mounts: DockerVolumeMount[] = [];
  for (const spec of meta.userSkillsPaths) {
    const primaryRel = hostRelativeOfTilde(spec.host);
    if (primaryRel !== null && existsSync(pathJoin(HOST_FS_ROOT, primaryRel))) {
      mounts.push({
        source: pathJoin(HOST_REAL_ROOT, primaryRel),
        target: spec.containerPath,
        readOnly: true,
      });
      continue;
    }
    if (!spec.fallbackHost) continue;
    const fallbackRel = hostRelativeOfTilde(spec.fallbackHost);
    if (fallbackRel !== null && existsSync(pathJoin(HOST_FS_ROOT, fallbackRel))) {
      mounts.push({
        source: pathJoin(HOST_REAL_ROOT, fallbackRel),
        target: spec.containerPath,
        readOnly: true,
      });
    }
  }
  return mounts;
}

export async function cleanupTaskAuthVolumes(
  taskId: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<{ removed: string[]; failed: { name: string; stderr: string }[] }> {
  const removed: string[] = [];
  const failed: { name: string; stderr: string }[] = [];
  for (const meta of CLI_PROVIDER_LIST) {
    for (let idx = 0; idx < meta.authConfigPaths.length; idx += 1) {
      const taskVol = cliAuthTaskVolumeName(taskId, meta.name, idx);
      if (!(await runner.volumeExists(taskVol))) continue;
      const result = await runner.volumeRemove(taskVol);
      if (result.ok) {
        removed.push(taskVol);
      } else {
        failed.push({ name: taskVol, stderr: result.stderr });
        log.warn({ taskVol, stderr: result.stderr }, 'task auth volume remove failed');
      }
    }
  }
  return { removed, failed };
}
