import { readdir, readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { resolveInvocationWorkerRoot } from './resolvers.js';
import { log } from './_shared.js';

/**
 * Read-only masks over the `#ddev-generated` files inside the cli-exec sandbox.
 *
 * DDEV owns these files and regenerates them on every start — unless the marker is
 * removed, which permanently freezes the file. An agent that "customized"
 * `.ddev/apache/apache-site.conf` by stripping the marker and dropping DDEV's
 * `Alias "/phpstatus" "/var/www/phpstatus.php"` blocks broke the ddev-webserver
 * healthcheck (`curl --fail -s 127.0.0.1/phpstatus` for any `*-fpm` webserver type), so
 * the web container never went healthy and EVERY later `ddev start` failed at its
 * readiness timeout — six opaque minutes per attempt, on a config the agent could no
 * longer be asked to fix because DDEV would never overwrite it again (task aba4d722).
 *
 * Rides the same mechanism as {@link worktreeGitfileMask}: sandbox-runner writes each
 * entry's content to the wrappers volume and bind-mounts it READ-ONLY at containerPath.
 * The difference is the payload — the file's REAL bytes, so the agent still reads exactly
 * what is on disk and only writing is refused (and the file cannot be unlinked and
 * replaced, because the mount is busy). Paired with DDEV_GENERATED_BOUNDARY_PROMPT, which
 * tells the agent to put custom rules in a SIBLING `.conf` instead — the pattern that
 * works, and the one the sibling clone of this very repo used successfully.
 *
 * An integrity control, not a secrecy one, so like the gitfile mask it is never gated by
 * SECRET_MASK_ENABLED. Unlike secret masking it fails OPEN: a partial mask still protects
 * the files it covers, and the pre-flight healthcheck guard
 * (sandbox/ddev-healthcheck-guard.ts) catches a broken config before the boot regardless.
 * Failing an invocation because `.ddev/` was briefly unreadable would trade a real outage
 * for a hypothetical one.
 */

/** Subtrees DDEV rewrites on every start, or that hold snapshots/build state rather than
 *  authored configuration. Masking them protects nothing and multiplies the mount count. */
const SKIP_DIRS = new Set([
  '.webimageBuild',
  '.dbimageBuild',
  '.homeadditions',
  '.global_commands',
  'db_snapshots',
]);

/** Marker-carrying files that nothing loads: documentation and the `.example` templates
 *  DDEV ships beside each real config. Excluding them is what keeps this to ~14 mounts on
 *  a real project instead of ~44 — see the README/`*.example` pairs throughout `.ddev/`. */
function isInertDoc(name: string): boolean {
  return name.startsWith('README') || name.endsWith('.example');
}

/** Bytes to read when looking for the marker. DDEV writes it in the first few lines; a
 *  cap keeps a stray large file in `.ddev/` from being slurped whole just to be rejected. */
const MARKER_PROBE_BYTES = 4096;
const DDEV_GENERATED_MARKER = '#ddev-generated';
/** Never mask a file bigger than this — a generated DDEV config is a few KB, and the
 *  content is copied into the wrappers volume on every invocation. */
const MAX_MASK_FILE_BYTES = 256 * 1024;
/** Backstop on the mount count. A normal project lands around 14; anything near this is a
 *  tree we do not understand, and a hundred extra bind mounts per invocation is its own
 *  failure mode. */
const MAX_MASKS = 120;

/**
 * Masks for the DDEV-generated files under the tree this invocation mounts.
 *
 * Returns `[]` — never throws — when the task has no repository, `.ddev/` is absent, or
 * the scan fails. See the fail-open reasoning above.
 */
export async function resolveDdevGeneratedMasks(
  db: Database,
  taskId: string,
  repoMount?: DockerVolumeMount | null,
): Promise<SandboxExtraFile[]> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { userId: true, repositoryId: true },
    });
    if (!task?.repositoryId) return [];

    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { storagePath: true, localPath: true },
    });
    if (!repo) return [];

    const workerRoot = resolveInvocationWorkerRoot({
      repoMountSubpath: repoMount?.subpath,
      storagePath: repo.storagePath ?? repo.localPath,
      userId: task.userId,
      repositoryId: task.repositoryId,
    });
    return await computeDdevGeneratedMasks(workerRoot, repoMount?.target ?? SANDBOX_WORKDIR);
  } catch (err) {
    log.warn({ err, taskId }, 'ddev-generated mask scan failed; continuing without it');
    return [];
  }
}

/**
 * Pure filesystem core (no DB): scan `<workerRoot>/.ddev` and return read-only masks,
 * carrying each file's real bytes, targeted at `<containerWorkdir>/.ddev/...`.
 *
 * Exposed for unit testing against a fixture tree.
 */
export async function computeDdevGeneratedMasks(
  workerRoot: string,
  containerWorkdir: string = SANDBOX_WORKDIR,
): Promise<SandboxExtraFile[]> {
  const ddevRoot = posix.join(workerRoot, '.ddev');
  const rootStat = await stat(ddevRoot).catch(() => null);
  if (!rootStat?.isDirectory()) return [];

  const masks: SandboxExtraFile[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (masks.length >= MAX_MASKS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (masks.length >= MAX_MASKS) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(posix.join(dir, entry.name), childRel);
        continue;
      }
      // Symlinks are skipped rather than followed: masking through one would bind a file
      // outside the tree we were asked to scan.
      if (!entry.isFile()) continue;
      if (isInertDoc(entry.name)) continue;

      const abs = posix.join(dir, entry.name);
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile() || info.size > MAX_MASK_FILE_BYTES) continue;

      const content = await readFile(abs, 'utf8').catch(() => null);
      if (content === null) continue;
      if (!content.slice(0, MARKER_PROBE_BYTES).includes(DDEV_GENERATED_MARKER)) continue;

      masks.push({
        containerPath: posix.join(containerWorkdir, '.ddev', childRel),
        content,
      });
    }
  };
  await walk(ddevRoot, '');

  if (masks.length >= MAX_MASKS) {
    log.warn({ workerRoot, count: masks.length }, 'ddev-generated mask hit its cap');
  }
  return masks;
}
