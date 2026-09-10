import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { glob } from 'tinyglobby';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CONFIG_KEYS, computeEffectiveSecretGlobs, configService, logger } from '@haive/shared';
import { listTrackedFiles } from '../queues/cli-exec/secret-mask.js';
import { WORKTREE_SUBDIR } from './worktree-paths.js';

/**
 * Carry a repository's untracked RUNTIME files into a freshly created worktree.
 *
 * `git worktree add` materialises TRACKED files only, so anything gitignored — the `.env`
 * a test suite reads its credentials from, a `settings.local.php`, a service-account json —
 * exists at the repo root and nowhere in the worktree. The app runtime then boots against a
 * tree missing exactly the files it cannot start without. MEASURED on task ef954a3d: the
 * repo's real `test-playwright/.env` sat at the root while every spec in the worktree threw
 * at import for the env var it defines, so `playwright test --list` enumerated nothing and
 * two full rounds wrote tests that never ran.
 *
 * The set carried is exactly the set secret-masking hides at the repo root. That is not a
 * convenience: `computeSecretMasks` scans the whole repo storage root and the sandbox mounts
 * it at SANDBOX_WORKDIR, so the root copy is ALREADY inside the agent's sandbox (masked).
 * Copying it into the worktree adds one more masked path and changes what an agent can read
 * by nothing at all — which is the property that makes this safe, and the reason to reuse
 * the mask globs rather than invent a second list that could drift wider.
 *
 * Independent of `secret_mask_enabled` on purpose: this reuses the GLOBS, not the toggle. A
 * repo that runs unmasked still needs its `.env`, and that file is equally readable at the
 * root either way.
 */
export interface CarryUntrackedResult {
  /** Relative paths copied into the worktree. */
  copied: string[];
  /** Matched at the root but already present in the worktree, so left alone. */
  skippedExisting: number;
  /** Matched but could not be copied. Never fatal — see the throw policy below. */
  failed: number;
}

/**
 * Copy the repo root's untracked secret-shaped files into `worktreePath`.
 *
 * Best-effort throughout. A missing runtime file is the state this repository already ships,
 * so a scan or copy that fails must not newly fail worktree setup for every repo — it logs
 * and returns what it managed. That is the opposite policy to `computeSecretMasks`, which
 * fails closed because a partial MASK leaves secrets readable; a partial CARRY leaves a file
 * missing, which is the status quo rather than a leak.
 */
export async function carryUntrackedRuntimeFiles(
  repoRoot: string,
  worktreePath: string,
  opts: { allow?: string[] | null; denyExtend?: string[] | null } = {},
): Promise<CarryUntrackedResult> {
  const empty: CarryUntrackedResult = { copied: [], skippedExisting: 0, failed: 0 };
  const { deny, ignore } = computeEffectiveSecretGlobs(opts);

  let matches: string[];
  try {
    matches = await glob(deny, {
      cwd: repoRoot,
      dot: true,
      // A linked worktree lives UNDER the repo root and SECRET_SCAN_IGNORE_DIRS does not
      // exclude it, so without this the scan would find one worktree's files and copy them
      // into another — carrying a sibling task's branch state, not the repo's.
      ignore: [...ignore, `${WORKTREE_SUBDIR}/**`],
      onlyFiles: true,
      expandDirectories: false,
      followSymbolicLinks: false,
    });
  } catch (err) {
    logger.warn({ err, repoRoot }, 'carry-untracked: scan failed, worktree left as checked out');
    return empty;
  }
  if (matches.length === 0) return empty;

  // Tracked files are already in the worktree by definition, and copying the root's copy
  // over one the branch legitimately changed would silently revert it.
  const tracked = await listTrackedFiles(repoRoot);
  const untracked = matches.filter((rel) => !tracked?.has(rel)).sort();
  if (untracked.length === 0) return empty;

  const result: CarryUntrackedResult = { copied: [], skippedExisting: 0, failed: 0 };
  for (const rel of untracked) {
    const dest = join(worktreePath, rel);
    try {
      // Never overwrite. A file already present in the worktree was either checked out or
      // written there deliberately; the root's copy is not more authoritative than either.
      if (await stat(dest).catch(() => null)) {
        result.skippedExisting += 1;
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(repoRoot, rel), dest);
      result.copied.push(rel);
    } catch (err) {
      result.failed += 1;
      logger.warn({ err, rel, worktreePath }, 'carry-untracked: copy failed');
    }
  }

  if (result.copied.length > 0 || result.failed > 0) {
    logger.info(
      {
        worktreePath,
        copied: result.copied.length,
        skippedExisting: result.skippedExisting,
        failed: result.failed,
        // The NAMES, not the contents. These are the paths a "why can't the suite run"
        // question is answered with, and they are already visible in the repo listing.
        paths: result.copied.map((p) => posix.normalize(p)),
      },
      'carry-untracked: carried runtime files into worktree',
    );
  }
  return result;
}

/**
 * Resolve a task's repository and carry its untracked runtime files into `worktreePath`.
 *
 * The per-repo glob overrides are the same two columns secret-masking reads, so the carried
 * set and the masked set cannot drift. `secret_mask_enabled` is deliberately NOT consulted
 * (see the module note) — only the globs are shared, not the toggle.
 *
 * Every failure path returns rather than throws, including a task or repository row that
 * cannot be resolved. This runs inside worktree creation, which must keep working for a
 * repo-less task exactly as it did before this existed.
 */
export async function carryUntrackedForTask(
  db: Database,
  taskId: string,
  repoRoot: string,
  worktreePath: string,
): Promise<CarryUntrackedResult> {
  const empty: CarryUntrackedResult = { copied: [], skippedExisting: 0, failed: 0 };
  const enabled = await configService.getBoolean(
    CONFIG_KEYS.WORKTREE_CARRY_UNTRACKED_ENABLED,
    true,
  );
  if (!enabled) return empty;

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true },
    });
    if (!task?.repositoryId) return empty;
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { secretMaskAllow: true, secretMaskDenyExtend: true },
    });
    return await carryUntrackedRuntimeFiles(repoRoot, worktreePath, {
      allow: repo?.secretMaskAllow,
      denyExtend: repo?.secretMaskDenyExtend,
    });
  } catch (err) {
    logger.warn({ err, taskId, worktreePath }, 'carry-untracked: skipped');
    return empty;
  }
}
