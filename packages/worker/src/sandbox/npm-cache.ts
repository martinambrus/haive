import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@haive/shared';
import type { DockerVolumeMount } from './docker-runner.js';
import { SANDBOX_GID, SANDBOX_UID } from './sandbox-identity.js';

const exec = promisify(execFile);
const log = logger.child({ module: 'npm-cache' });

/** Shared npm cache for per-invocation sandboxes.
 *
 *  A cli-exec sandbox is `--rm`, so anything `npx` downloads dies with it and the next
 *  invocation pays the full fetch again. That is not merely slow — it silently broke
 *  browser verification: chrome-devtools-mcp is launched as `npx -y chrome-devtools-mcp@X`,
 *  a cold fetch MEASURED at 111-146s, while the agent gave up looking for its tools at
 *  ~50s and fell back to static analysis while reporting a pass (task de2b313d).
 *
 *  Deliberately a CACHE, not a baked-in version: the chrome-devtools-mcp version is chosen
 *  per repository (`repositories.chrome_devtools_mcp_version`), so pinning one into the
 *  image would take that choice away. Caching keeps every version selectable and makes
 *  each one fast after its first fetch — MEASURED 146s cold, 4s warm. */
export const NPM_CACHE_VOLUME = 'haive_npm_cache';

/** Where the volume is mounted inside a sandbox. Not under the sandbox user's home: the
 *  auth-volume machinery already owns paths there, and a bind over part of it is
 *  destructive (see mergeCliMcpIntoTaskVolume). */
export const NPM_CACHE_DIR = '/haive-npm-cache';

/** npm reads this env var for its cache location; `npx` inherits it. */
export const NPM_CACHE_ENV = { npm_config_cache: NPM_CACHE_DIR } as const;

export function npmCacheMount(): DockerVolumeMount {
  return { source: NPM_CACHE_VOLUME, target: NPM_CACHE_DIR };
}

let ensured = false;

/** Marker recording that the volume has been chowned to the sandbox identity. Keyed on the
 *  uid so changing SANDBOX_UID re-runs the alignment instead of trusting a stale marker. */
const OWNERSHIP_MARKER = `${NPM_CACHE_DIR}/.haive-cache-owner-${SANDBOX_UID}`;

/**
 * Give the cache to the uid that actually consumes it.
 *
 * Docker creates a named volume's root as root:root 755, and this volume was previously
 * also POPULATED as root, because the warm run below carried no `--user`. The cli-exec
 * sandbox runs as `node` (SANDBOX_USER, uid 1000, see sandbox-runner), so every `npx` in
 * a real invocation hit `npm error code EACCES` opening `_cacache/tmp` and exited 1.
 *
 * That is not a slow path, it is a dead one: the MCP server never starts, and the CLI
 * reports it as `"status":"failed"` while the two bind-mounted `node` servers next to it
 * connect fine. MEASURED in a live 07 invocation: chrome-devtools failed, filesystem
 * failed (also npx), git pending (uvx), haive-rag and ddev-control connected. The shared
 * cache was introduced to make the browser MCP load in time; unowned, it stopped it
 * loading at all, which is why the original symptom looked unchanged.
 *
 * Runs as root (no `--user`) because chown is what we are here to do, and is skipped after
 * the first success via a marker file, so this costs one container per volume rather than
 * one per worker boot. Best-effort like everything else here: a failure leaves the old
 * behaviour rather than failing the invocation.
 */
async function alignNpmCacheOwnership(image: string): Promise<void> {
  try {
    await exec(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${NPM_CACHE_VOLUME}:${NPM_CACHE_DIR}`,
        '--entrypoint',
        'sh',
        image,
        '-c',
        `test -f ${OWNERSHIP_MARKER} || { chown -R ${SANDBOX_UID}:${SANDBOX_GID} ${NPM_CACHE_DIR} && touch ${OWNERSHIP_MARKER}; }`,
      ],
      { timeout: 120_000 },
    );
  } catch (err) {
    log.warn({ err }, 'could not align npm cache ownership; npx may fail as the sandbox user');
  }
}

/** Create the volume if it does not exist. `docker volume create` is idempotent, so this
 *  is safe to call repeatedly; the flag just avoids the process spawn after the first. */
export async function ensureNpmCacheVolume(image: string): Promise<void> {
  if (ensured) return;
  try {
    await exec('docker', ['volume', 'create', NPM_CACHE_VOLUME], { timeout: 15_000 });
    await alignNpmCacheOwnership(image);
    ensured = true;
  } catch (err) {
    // Not fatal: without the volume the mount below fails and npx falls back to an
    // in-container cache — the old behaviour, slow but working.
    log.warn({ err }, 'could not ensure the shared npm cache volume');
  }
}

/** Populate the shared cache with `pkgSpec` so the sandbox's own `npx` resolves it from
 *  disk instead of the network.
 *
 *  Runs unconditionally rather than tracking what is already cached: warm is ~4s, and a
 *  cache-state check would be a second source of truth to get wrong. The first fetch of
 *  any given version pays the full cost once, then every later invocation is fast.
 *
 *  Best-effort by design. A failure here must never fail the invocation: the agent can
 *  still run, and the MCP server may still start (just slowly) exactly as it did before
 *  this existed. Returns whether the warm succeeded, for logging only. */
export async function warmNpmPackage(
  image: string,
  pkgSpec: string,
  timeoutMs = 240_000,
): Promise<boolean> {
  await ensureNpmCacheVolume(image);
  const started = Date.now();
  try {
    await exec(
      'docker',
      [
        'run',
        '--rm',
        // Warm as the identity that will READ this cache. Without it the warm ran as root
        // and left every entry root-owned, which is what made the sandbox's own npx fail.
        '--user',
        `${SANDBOX_UID}:${SANDBOX_GID}`,
        '-v',
        `${NPM_CACHE_VOLUME}:${NPM_CACHE_DIR}`,
        '-e',
        `npm_config_cache=${NPM_CACHE_DIR}`,
        '--entrypoint',
        'npx',
        image,
        '-y',
        pkgSpec,
        '--version',
      ],
      { timeout: timeoutMs },
    );
    log.info({ pkgSpec, ms: Date.now() - started }, 'npm cache warmed');
    return true;
  } catch (err) {
    log.warn(
      { err, pkgSpec, ms: Date.now() - started },
      'npm cache warm failed; the sandbox will fetch on demand',
    );
    return false;
  }
}
