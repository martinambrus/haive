import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
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
 * Secret masking could not be applied faithfully, and we cannot prove it was off.
 *
 * Fail closed: never run a CLI agent against a repo whose secrets we know we failed
 * to hide — nor against one we cannot resolve well enough to know. Callers let this
 * propagate — handleCliExecJob records it on the invocation (exit -1) and fails the
 * step, so the user sees why and can Retry after adjusting the allow globs. Disabling
 * masking (per repo, or the global kill-switch) skips the scan entirely and never
 * raises this.
 */
export class SecretMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretMaskError';
  }
}

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
  // No task row: we cannot resolve what would be mounted, so we cannot claim there is
  // nothing to hide. A repo-less task is different — resolveTaskRepoMount returns null
  // on the same condition, so no repo tree reaches the sandbox and there is genuinely
  // nothing to mask.
  if (!task) throw new SecretMaskError(`secret-mask: task ${taskId} not found`);
  if (!task.repositoryId) return [];

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
  // The row is what tells us whether masking is on for this repo and which globs
  // apply. Without it, "no masks" would be a guess dressed up as a decision — the FK
  // is ON DELETE SET NULL, so a live repositoryId pointing at nothing is a torn state,
  // not a repo-less task.
  if (!repo) {
    throw new SecretMaskError(
      `secret-mask: repository ${task.repositoryId} for task ${taskId} not found`,
    );
  }
  if (!repo.secretMaskEnabled) return [];

  // Worker-visible repo root (the same tree mounted at SANDBOX_WORKDIR), mirroring
  // resolveTaskRepoMount: only a /host-fs path (local-path repo) is used verbatim.
  // Every other repo — including one whose storage_path was never written — is mounted
  // from the named-volume subpath under WORKER_REPO_STORAGE_ROOT, so the tree reaches
  // the sandbox either way and must be scanned either way. Bailing on a null path here
  // left that tree mounted and unmasked.
  const storagePath = repo.storagePath ?? repo.localPath;
  const workerRoot = storagePath?.startsWith(HOST_REPO_ROOT + '/')
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
 * files, and return empty-content masks targeted at `containerWorkdir`. Exposed for
 * unit testing against a fixture tree.
 *
 * Throws {@link SecretMaskError} rather than masking a partial set: an unreadable
 * root, a scan that fails, or a match count over SECRET_MASK_LIMIT all mean some
 * secrets would stay readable.
 */
export async function computeSecretMasks(
  workerRoot: string,
  opts: { allow?: string[] | null; denyExtend?: string[] | null },
  containerWorkdir: string = SANDBOX_WORKDIR,
): Promise<SandboxExtraFile[]> {
  const { deny, ignore } = computeEffectiveSecretGlobs(opts);

  // Glob answers "no matches" for a root that does not exist, which is byte-identical
  // to "this repo holds no secrets". The sandbox mount does not go through this path —
  // resolveTaskRepoMount binds the volume subpath or the host dir regardless — so a
  // workerRoot that points nowhere (REPO_STORAGE_ROOT / HOST_REPO_ROOT misconfigured,
  // the volume unmounted, a repo whose files were never written) would mount the real
  // tree and mask nothing, silently and for every repo. Assert the tree exists before
  // trusting the scan that reads it.
  const rootStat = await stat(workerRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new SecretMaskError(
      `secret-mask root ${workerRoot} is not a readable directory, so a scan of it would ` +
        'report no secrets whether or not the repository has any. Refusing the invocation ' +
        'instead of running the agent unmasked. Either the repository was never cloned to ' +
        "that path, or the worker's REPO_STORAGE_ROOT / HOST_REPO_ROOT mounts are wrong — " +
        'the two are indistinguishable from here, and one of them leaks.',
    );
  }

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
    // The root exists (asserted above), so a throw here is a real I/O or permission
    // fault. Returning no masks would hand the agent every secret the scan was meant
    // to hide, with only a log line to show for it.
    throw new SecretMaskError(
      `secret-mask scan of ${workerRoot} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (matches.length === 0) return [];

  // Tier 1: mask untracked files only. Sorted so the set is reproducible run to run.
  const rels = (await filterUntracked(workerRoot, matches)).sort();
  if (rels.length === 0) return [];

  // Masking an arbitrary subset leaves the remainder readable, which is the one
  // outcome the deny-list exists to prevent. Refuse the invocation instead: the cap is
  // pathological (real repos match single digits), and both escape hatches — the
  // repo's secret_mask_allow globs and the masking toggles — are user-reachable.
  if (rels.length > SECRET_MASK_LIMIT) {
    throw new SecretMaskError(
      `secret-mask matched ${rels.length} untracked secret files, over the ${SECRET_MASK_LIMIT} cap ` +
        `(largest: ${summarizeByDir(rels)}). Masking only some would leave the rest readable by the ` +
        'agent. Narrow the set with the repository\'s "Secret mask allow" globs on the tooling ' +
        'settings page, or turn secret masking off for this repository to run unmasked.',
    );
  }

  log.info({ masked: rels.length }, 'secret-mask: hiding files from CLI agent');
  return rels.map((rel) => ({ containerPath: posix.join(containerWorkdir, rel), content: '' }));
}

/** `dir (n), dir (n), …` for the heaviest directories — the actionable part of an
 *  overflow error, since the fix is an allow glob over one of them. */
function summarizeByDir(rels: string[], top = 3): string {
  const counts = new Map<string, number>();
  for (const rel of rels) {
    const slash = rel.lastIndexOf('/');
    const dir = slash === -1 ? '.' : rel.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([dir, n]) => `${dir} (${n})`)
    .join(', ');
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
