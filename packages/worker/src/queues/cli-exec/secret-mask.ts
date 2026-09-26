import { execFile } from 'node:child_process';
import { lstatNoFollow } from '@haive/shared/fs-safe';
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
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { splitWorktreePath, WORKTREE_SUBDIR } from '../../repo/worktree-paths.js';
import { resolveInvocationWorkerRoot } from './resolvers.js';
import {
  secretMaskDeniesPath,
  secretMaskPolicy,
  type SecretMaskPolicy,
} from './secret-mask-policy.js';
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
  repoMount?: DockerVolumeMount | null,
): Promise<SandboxExtraFile[]> {
  // Global kill-switch: lets ops disable masking everywhere without per-repo
  // edits or a redeploy. Default true.
  const globallyEnabled = await configService.getBoolean(CONFIG_KEYS.SECRET_MASK_ENABLED, true);
  if (!globallyEnabled) return [];

  const target = await maskedRepository(db, taskId);
  if (!target) return [];
  const { task, repo } = target;
  if (!repo.secretMaskEnabled) return [];

  // Scan EXACTLY what is mounted, and mask at the mount target — so the masked set can
  // never drift from the mount. resolveInvocationWorkerRoot is the one definition of that
  // path, shared with the other sandbox masks. computeSecretMasks stats the root and fails
  // closed if it is unreadable — the sandbox binds the real tree regardless of what the
  // worker can see.
  const workerRoot = resolveInvocationWorkerRoot({
    repoMountSubpath: repoMount?.subpath,
    storagePath: repo.storagePath ?? repo.localPath,
    userId: task.userId,
    repositoryId: task.repositoryId,
  });

  return computeSecretMasks(
    workerRoot,
    { allow: repo.secretMaskAllow, denyExtend: repo.secretMaskDenyExtend },
    repoMount?.target ?? SANDBOX_WORKDIR,
  );
}

/** The task's repository row as masking reads it, or null for a task with no repository. */
async function maskedRepository(db: Database, taskId: string) {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, repositoryId: true },
  });
  // No task row: we cannot resolve what would be mounted, so we cannot claim there is
  // nothing to hide. A repo-less task is different — resolveTaskRepoMount returns null
  // on the same condition, so no repo tree reaches the sandbox and there is genuinely
  // nothing to mask.
  if (!task) throw new SecretMaskError(`secret-mask: task ${taskId} not found`);
  if (!task.repositoryId) return null;

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
  return { task: { userId: task.userId, repositoryId: task.repositoryId }, repo };
}

/** The globs the sandbox would mask a task's repository with, whether masking is on or off, for a
 *  writer that must keep those files out of what an agent could read later: with masking off the
 *  agent reads them anyway, so leaving them out costs nothing. Null for a task with no repository. */
export async function taskSecretMaskPolicy(
  db: Database,
  taskId: string,
): Promise<SecretMaskPolicy | null> {
  const target = await maskedRepository(db, taskId);
  return target
    ? secretMaskPolicy({
        allow: target.repo.secretMaskAllow,
        denyExtend: target.repo.secretMaskDenyExtend,
      })
    : null;
}

/**
 * Refuse the invocation when a persona body pasted at DISPATCH would be masked NOW.
 *
 * `buildCliSidePlan` records the repository-relative path of every body the prompt rewrite pasted
 * (`CliCommandSpec.pastedPersonaPaths`). A deny rule, a repository's `secret_mask_allow`, or the
 * masking switch itself can change while the job waits in the queue — and a body already in a prompt
 * cannot be retracted. So the policy is evaluated a second time here, before the CLI starts, and a
 * path it now denies fails the invocation loudly. A retry then rebuilds the prompt under the current
 * policy, which is the outcome that actually repairs it.
 *
 * It asks the POLICY, never the mask set. `computeSecretMasks` only mounts over files that still
 * exist, so a denied file DELETED after dispatch produces no mount at all while its bytes are already
 * in the prompt — and an absent mask is never evidence of an allowed path, the same reason masking
 * refuses to read an empty scan as a clean repository.
 *
 * Fails CLOSED, unlike the agent-definition mask beside it: a task or repository row that cannot be
 * resolved throws rather than waving the paths through. `SecretMaskError` is deliberate — it is the
 * path `handleCliExecJob` already records on the invocation (exit -1) and fails the step with, so
 * this needs no new failure plumbing.
 *
 * A no-op for every invocation that pasted nothing, which is all of them outside isolation: an empty
 * list returns before any query runs.
 */
export async function assertPastedPersonasStillAllowed(
  db: Database,
  taskId: string,
  repoMount: DockerVolumeMount | null | undefined,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;

  let globallyEnabled: boolean;
  try {
    globallyEnabled = await configService.getBoolean(CONFIG_KEYS.SECRET_MASK_ENABLED, true);
  } catch (err) {
    throw new SecretMaskError(
      `secret-mask: could not read the masking switch to recheck ${paths.length} pasted persona ` +
        `path(s): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Masking off means nothing is hidden from this run, so nothing pasted can be a leak.
  if (!globallyEnabled) return;

  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, repositoryId: true },
  });
  if (!task) {
    throw new SecretMaskError(`secret-mask: task ${taskId} not found for a pasted-persona recheck`);
  }
  // No repository means no tree was mounted and no persona could have come off one.
  if (!task.repositoryId) return;

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
  if (!repo) {
    throw new SecretMaskError(
      `secret-mask: repository ${task.repositoryId} for task ${taskId} not found for a ` +
        'pasted-persona recheck',
    );
  }
  if (!repo.secretMaskEnabled) return;

  const policy = secretMaskPolicy({
    allow: repo.secretMaskAllow,
    denyExtend: repo.secretMaskDenyExtend,
  });

  // The tracked set is resolved at most once, and only for a path the globs already deny: masking is
  // untracked-only, so git can rescue a denied path but never condemn an allowed one.
  let tracked: Set<string> | null | undefined;
  const denied: string[] = [];
  for (const rel of paths) {
    if (!secretMaskDeniesPath(policy, rel)) continue;
    if (tracked === undefined) {
      tracked = await listTrackedFiles(
        resolveInvocationWorkerRoot({
          repoMountSubpath: repoMount?.subpath,
          storagePath: repo.storagePath ?? repo.localPath,
          userId: task.userId,
          repositoryId: task.repositoryId,
        }),
      );
    }
    if (secretMaskDeniesPath({ ...policy, tracked }, rel)) denied.push(rel);
  }
  if (denied.length === 0) return;

  throw new SecretMaskError(
    `secret-mask: ${denied.length} agent definition(s) were pasted into this prompt at dispatch ` +
      `and the masking policy now hides them (${denied.join(', ')}). The prompt cannot be unsent, ` +
      'so the invocation is refused instead of run. Retry the step to rebuild the prompt under the ' +
      'current policy, or widen the repository\'s "Secret mask allow" globs.',
  );
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
  // SPLIT rather than anchored: `workerRoot` is a worktree as often as a repo root, and a worktree
  // sits under `.haive/`, which the sandbox mounts read-write — so its `.haive/worktrees/<dir>` tail
  // is walked a component at a time. A repo-root `workerRoot` IS the anchor, and an anchor may be
  // followed by design, so this neither refuses nor needs to refuse a linked storage root: that path
  // comes from the worker's own env, not from the tree. Lenient, because the guard below fails
  // CLOSED — an absent root and a refused component land in the same refusal.
  const split = splitWorktreePath(workerRoot);
  const rootInfo = split
    ? await lstatNoFollow(split.anchor, split.rel)
    : await lstatNoFollow(workerRoot, '');
  if (rootInfo?.kind !== 'directory') {
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
export async function listTrackedFiles(repoRoot: string): Promise<Set<string> | null> {
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
