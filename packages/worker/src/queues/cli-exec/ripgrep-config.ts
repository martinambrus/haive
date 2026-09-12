import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { WORKER_REPO_STORAGE_ROOT } from './resolvers.js';

/** The file `01_5-ripgrep-config` writes, at the repo root. */
const RIPGREP_CONFIG_FILE = '.ripgreprc';

/** The worker-side path of the tree the sandbox will bind, from the mount alone.
 *
 *  The two branches mirror `resolveInvocationWorkerRoot`: a volume-backed repo is the
 *  storage root joined to the mount's own subpath, and a bind-mounted local repo is its
 *  source directory. Deriving it from the MOUNT rather than from the repository row is
 *  what keeps the file that gets stat-ed and the file the container sees from drifting —
 *  and it needs no database on a path that runs for every invocation. */
export function workerRootForMount(repoMount: DockerVolumeMount): string | null {
  if (repoMount.subpath) return posix.join(WORKER_REPO_STORAGE_ROOT, repoMount.subpath);
  return repoMount.source || null;
}

/**
 * Point ripgrep at the project's generated config, when there is one.
 *
 * `01_5-ripgrep-config` scans the tree and writes a `.ripgreprc` extending ripgrep's
 * built-in types with the extensions the project actually uses — on a Drupal 7 repo that
 * is `--type-add=php:*.inc` and friends, covering 1,398 files the built-in `php` type does
 * not match. Writing it was the whole step; nothing ever read it.
 *
 * ripgrep does NOT pick a `.ripgreprc` up from the working directory. It reads a config
 * ONLY from `RIPGREP_CONFIG_PATH`, and nothing in the worker or the sandbox image set that
 * — VERIFIED on rg 14.1.0: with the file in the cwd and the variable unset, `rg -t php`
 * matched nothing in a `.inc` file; with the variable pointing at that same file it
 * matched. So every type-scoped search — `rg -t php`, or the Grep tool's `type` parameter,
 * which is the likelier route — silently read a fraction of the codebase and returned a
 * confident "no matches" for the rest.
 *
 * Conditional, and that is not defensiveness: pointed at a file that does not exist,
 * ripgrep writes `failed to read the file specified in RIPGREP_CONFIG_PATH` to stderr on
 * EVERY invocation (126 bytes, measured), which would reach the agent as noise on every
 * repo with no generated config — and an agent that reads that as a failure is worse off
 * than one that never had the config at all.
 *
 * The path is stat-ed as the WORKER sees it and exported as the CONTAINER sees it: two
 * strings for one file, and only the first can be checked from here.
 */
export async function resolveRipgrepConfigEnv(
  repoMount: DockerVolumeMount | null,
  containerWorkdir: string = SANDBOX_WORKDIR,
): Promise<Record<string, string>> {
  if (!repoMount) return {};
  const workerRoot = workerRootForMount(repoMount);
  if (!workerRoot) return {};

  const found = await stat(posix.join(workerRoot, RIPGREP_CONFIG_FILE)).catch(() => null);
  if (!found?.isFile()) return {};

  return {
    RIPGREP_CONFIG_PATH: posix.join(repoMount.target || containerWorkdir, RIPGREP_CONFIG_FILE),
  };
}
