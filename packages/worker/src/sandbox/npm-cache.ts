import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@haive/shared';
import type { DockerVolumeMount } from './docker-runner.js';

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

/** Create the volume if it does not exist. `docker volume create` is idempotent, so this
 *  is safe to call repeatedly; the flag just avoids the process spawn after the first. */
export async function ensureNpmCacheVolume(): Promise<void> {
  if (ensured) return;
  try {
    await exec('docker', ['volume', 'create', NPM_CACHE_VOLUME], { timeout: 15_000 });
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
  await ensureNpmCacheVolume();
  const started = Date.now();
  try {
    await exec(
      'docker',
      [
        'run',
        '--rm',
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
