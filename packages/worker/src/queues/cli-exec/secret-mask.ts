import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { glob } from 'tinyglobby';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  computeEffectiveSecretGlobs,
  SECRET_MASK_LIMIT,
} from '@haive/shared';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import { WORKTREE_SUBDIR } from '../../repo/worktree-paths.js';
import { HOST_REPO_ROOT, WORKER_REPO_STORAGE_ROOT } from './resolvers.js';
import { log } from './_shared.js';

const execFileAsync = promisify(execFile);

/**
 * Empty read-only file masks for a task's secret files, to bind-mount over the
 * matching paths inside the cli-exec sandbox so the AI CLI agent reads nothing
 * instead of the real contents (CLI-agnostic read-block).
 *
 * Scope is Tier 1 — UNTRACKED files only. A tracked (committed) secret is left
 * alone: masking its worktree copy would surface as a diff and `git show` would
 * still leak it, so committed-secret handling is deliberately out of scope.
 *
 * The repo volume is shared with the app runtime (app-runner / ddev mount the
 * same `haive_repos` subpath WITHOUT these masks), so the running app still sees
 * the real files — only the agent's view is masked.
 */
export async function resolveSecretMasks(
  db: Database,
  taskId: string,
): Promise<SandboxExtraFile[]> {
  // Global kill-switch: lets ops disable masking everywhere without per-repo
  // edits or a redeploy. Default true.
  const globallyEnabled = await configService.getBoolean(CONFIG_KEYS.SECRET_MASK_ENABLED, true);
  if (!globallyEnabled) return [];

  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, repositoryId: true },
  });
  if (!task?.repositoryId) return [];

  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: {
      storagePath: true,
      localPath: true,
      secretMaskEnabled: true,
      secretMaskAllow: true,
      secretMaskDenyExtend: true,
    },
  });
  if (!repo || !repo.secretMaskEnabled) return [];

  // Worker-visible repo root (the same tree mounted at SANDBOX_WORKDIR): the
  // /host-fs bind for local-path repos, else the named-volume subpath the worker
  // sees under WORKER_REPO_STORAGE_ROOT (mirrors resolveTaskRepoMount).
  const storagePath = repo.storagePath ?? repo.localPath;
  if (!storagePath) return [];
  const workerRoot = storagePath.startsWith(HOST_REPO_ROOT + '/')
    ? storagePath
    : posix.join(WORKER_REPO_STORAGE_ROOT, `${task.userId}/${task.repositoryId}`);

  return computeSecretMasks(workerRoot, {
    allow: repo.secretMaskAllow,
    denyExtend: repo.secretMaskDenyExtend,
  });
}

/**
 * Pure filesystem core (no DB/config): glob `workerRoot` for the effective
 * secret deny-list, drop carve-outs (handled via the ignore set) and tracked
 * files, cap the count, and return empty-content masks targeted at
 * `containerWorkdir`. Exposed for unit testing against a fixture tree.
 */
export async function computeSecretMasks(
  workerRoot: string,
  opts: { allow?: string[] | null; denyExtend?: string[] | null },
  containerWorkdir: string = SANDBOX_WORKDIR,
): Promise<SandboxExtraFile[]> {
  const { deny, ignore } = computeEffectiveSecretGlobs(opts);

  let matches: string[];
  try {
    matches = await glob(deny, {
      cwd: workerRoot,
      dot: true,
      ignore,
      onlyFiles: true,
      expandDirectories: false,
      followSymbolicLinks: false,
    });
  } catch (err) {
    log.warn({ err, workerRoot }, 'secret-mask glob failed; applying no masks');
    return [];
  }
  if (matches.length === 0) return [];

  // Tier 1: mask untracked files only.
  let rels = await filterUntracked(workerRoot, matches);
  if (rels.length === 0) return [];

  if (rels.length > SECRET_MASK_LIMIT) {
    log.warn(
      { matched: rels.length, limit: SECRET_MASK_LIMIT },
      'secret-mask matches exceed limit; masking the first N and dropping the rest',
    );
    rels = rels.slice(0, SECRET_MASK_LIMIT);
  }

  log.info({ masked: rels.length }, 'secret-mask: hiding files from CLI agent');
  return rels.map((rel) => ({ containerPath: posix.join(containerWorkdir, rel), content: '' }));
}

const WORKTREE_PREFIX = `${WORKTREE_SUBDIR}/`;

/** Split `.haive/worktrees/<name>/<rest>` into the worktree name and the path
 *  relative to that worktree. Null for anything outside a linked worktree. */
function splitWorktreeRel(rel: string): { name: string; rel: string } | null {
  if (!rel.startsWith(WORKTREE_PREFIX)) return null;
  const rest = rel.slice(WORKTREE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { name: rest.slice(0, slash), rel: rest.slice(slash + 1) };
}

/** Drop tracked (committed) paths — Tier 1 masks untracked files only.
 *
 *  `git ls-files` reports paths relative to the tree it is run in, so the repo root's
 *  listing never contains `.haive/worktrees/<name>/x`. Classifying those as untracked
 *  masked committed files inside the worktree — where the agent actually works —
 *  while the identical parent copy stayed readable at the repo root: no protection,
 *  and an empty file under any sandbox build that reads it. Ask each linked worktree
 *  about its own paths (its branch may track a different set).
 *
 *  Not a git work tree / git unavailable -> treat everything as untracked (mask more,
 *  never less). */
async function filterUntracked(workerRoot: string, matches: string[]): Promise<string[]> {
  const rootTracked = await listTrackedFiles(workerRoot);
  const worktreeTracked = new Map<string, Set<string> | null>();

  const kept: string[] = [];
  for (const rel of matches) {
    const wt = splitWorktreeRel(rel);
    if (!wt) {
      if (!rootTracked?.has(rel)) kept.push(rel);
      continue;
    }
    if (!worktreeTracked.has(wt.name)) {
      worktreeTracked.set(
        wt.name,
        await listTrackedFiles(posix.join(workerRoot, WORKTREE_SUBDIR, wt.name)),
      );
    }
    if (!worktreeTracked.get(wt.name)?.has(wt.rel)) kept.push(rel);
  }
  return kept;
}

/** Tracked paths (relative to repoRoot) per `git ls-files -z`, or null when the
 *  directory is not a git work tree / git is unavailable. */
async function listTrackedFiles(repoRoot: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'ls-files', '-z'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const set = new Set<string>();
    for (const p of stdout.split('\0')) if (p) set.add(p);
    return set;
  } catch {
    return null;
  }
}
