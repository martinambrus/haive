import { HAIVE_DATA_FILES, logger } from '@haive/shared';
import { originGitRun, buildCredentialHelper, gitRun, scrubSecret } from '../repo/git-push.js';
import { lstatNoFollow, relUnder } from '@haive/shared/fs-safe';
import { ensureSandboxWritableTree } from '../repo/worktree-permissions.js';
import { WORKTREE_SUBDIR } from '../repo/worktree-paths.js';
import { isWorktreeRegistered } from '../repo/git-workspace.js';
import { abortMerge as abortGitMerge, openMerge, utf8Name } from '../step-engine/git-merge.js';
import { resolveHaiveProjectionConflicts } from './projection-merge.js';
import type { Database } from '@haive/database';

/**
 * Integrating a remote into a plan checkout.
 *
 * Until this existed both directions stopped at a diverged branch: `save()` never
 * fetched at all, and `pull()` was `git merge --ff-only` with a message telling the
 * user to reconcile the two checkouts in Git themselves. That was defensible while
 * there was no resolver, but it meant a plan could not reach a GitHub repository
 * created with a README — the ordinary way to create one — because a blank Haive
 * repo and a GitHub-initialised one share NO commit at all.
 *
 * Everything here is pure git: no task, no step row, no database except the one
 * credential lookup. That is deliberate — the mirror queue (a plain BullMQ job) and
 * the conflict-resolution step both drive it, and only one of them has a task.
 */

/** The scratch worktree every plan merge happens in.
 *
 *  NOT the main checkout. A conflicted merge can sit unresolved for as long as a
 *  person takes to answer, and the main checkout is mounted into agent sandboxes and
 *  read by every other plan operation — leaving it mid-merge would hand half-merged
 *  files to anything that looked. Here the checkout is untouched until the merge is
 *  resolved AND confirmed, and abandoning costs one `worktree remove`. */
const PLAN_MERGE_DIR = 'plan-merge';

export function planMergeWorktreePath(repoPath: string): string {
  return `${repoPath}/${WORKTREE_SUBDIR}/${PLAN_MERGE_DIR}`;
}

/**
 * The scratch worktree, checked out DETACHED at the current HEAD.
 *
 * Detached rather than on a branch for two reasons that both matter: the main
 * checkout already holds the branch and git refuses to check the same one out twice,
 * and — the load-bearing half — a merge made here has the main checkout's HEAD as
 * its FIRST PARENT, which is exactly the condition that lets `landPlanMerge`
 * fast-forward the real branch onto the result. The main branch therefore only ever
 * moves forward; it is never reset, rebased or force-updated.
 *
 * Mirrors `ensureBaseWorktree` in merge-resolver.ts — prune, ask git whether the path
 * is registered, remove a stale directory, then add.
 */
/** The task states a conversation is live in, the one list `findOpenPlanMerge` (api) reads too. */
export { PLAN_MERGE_LIVE_STATUSES } from '@haive/shared';

export async function ensurePlanMergeWorktree(repoPath: string): Promise<string> {
  const worktreePath = planMergeWorktreePath(repoPath);
  await gitRun(repoPath, ['worktree', 'prune']);
  if (!(await isWorktreeRegistered(repoPath, worktreePath))) {
    // Anchored on the repository root, with the worktree walked below it. A LINK planted at that
    // path still answers non-null and is still removed — a name taken is not free space, the same
    // reading `_kb-legacy` settled on — but it is no longer followed to decide that.
    if ((await lstatNoFollow(repoPath, `${WORKTREE_SUBDIR}/${PLAN_MERGE_DIR}`)) !== null) {
      await gitRun(repoPath, ['worktree', 'remove', '--force', worktreePath]);
    }
    const add = await gitRun(repoPath, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
    if (add.code !== 0) {
      throw new Error(`git worktree add (plan merge) failed: ${add.stderr || add.stdout}`);
    }
  }
  await ensureSandboxWritableTree(repoPath, relUnder(repoPath, worktreePath));
  return worktreePath;
}

export async function removePlanMergeWorktree(repoPath: string): Promise<void> {
  const worktreePath = planMergeWorktreePath(repoPath);
  await gitRun(repoPath, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
  await gitRun(repoPath, ['worktree', 'prune']).catch(() => undefined);
}

/** Authenticated `git fetch origin <branch>`. The credential helper is built per
 *  call and its secret scrubbed from any message, the same dance `pull()` already
 *  does. */
export async function fetchOrigin(args: {
  repoPath: string;
  branch: string;
  db: Database;
  userId: string;
  credentialId?: string | null;
  remoteUrl?: string | null;
}): Promise<void> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  const argv: string[] = [];
  let secret: string | null = null;
  if (args.credentialId) {
    const helper = await buildCredentialHelper(
      args.db,
      args.credentialId,
      args.userId,
      args.remoteUrl,
    );
    secret = helper.secret;
    Object.assign(env, helper.env);
    argv.push(...helper.argv);
  }
  const res = await originGitRun(
    args.repoPath,
    [...argv, 'fetch', '--end-of-options', 'origin', `refs/heads/${args.branch}`],
    env,
  );
  if (res.code !== 0) {
    throw new Error(`git fetch failed: ${scrubSecret(res.stderr || res.stdout, secret)}`);
  }
}

/** How far apart the checkout and the fetched remote are.
 *
 *  Keyed on counts and on exit codes, never on git's stderr. A push
 *  rejection prints a multi-line hint that git is free to reword at any release
 *  (`pushBranch` throws it verbatim), so branching on it would break silently on a
 *  git upgrade — and silently is the worst way for this to break, because the
 *  symptom would be a push that stops integrating. A missing `origin/<branch>` is the
 *  only failure read as "nothing to pull"; every other failed read throws. */
export async function divergence(
  repoPath: string,
  branch: string,
): Promise<{ ahead: number; behind: number; unrelated: boolean }> {
  const failed = (cmd: string, res: { stdout: string; stderr: string }): Error =>
    new Error(`git ${cmd} failed in ${repoPath}: ${res.stderr.trim() || res.stdout.trim()}`);
  const count = async (range: string): Promise<number> => {
    const res = await gitRun(repoPath, ['rev-list', '--count', range]);
    const n = Number.parseInt(res.stdout.trim(), 10);
    if (res.code !== 0 || !Number.isFinite(n)) throw failed('rev-list', res);
    return n;
  };
  const ref = await gitRun(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `origin/${branch}^{commit}`,
  ]);
  if (ref.code === 1) return { ahead: await count('HEAD'), behind: 0, unrelated: true };
  if (ref.code !== 0) throw failed('rev-parse', ref);
  const base = await gitRun(repoPath, ['merge-base', 'HEAD', `origin/${branch}`]);
  if (base.code !== 0 && base.code !== 1) throw failed('merge-base', base);
  const unrelated = base.code === 1;
  // With no common ancestor the two-dot ranges are meaningless (git errors), so the
  // whole of each side counts as unmerged. `behind > 0` is what callers branch on.
  if (unrelated) {
    return { ahead: await count('HEAD'), behind: await count(`origin/${branch}`), unrelated };
  }
  return {
    ahead: await count(`origin/${branch}..HEAD`),
    behind: await count(`HEAD..origin/${branch}`),
    unrelated,
  };
}

/** Unmerged paths judged on their bytes: a valid UTF-8 name is listed, any other only counted. */
export interface ConflictedPaths {
  paths: string[];
  undecodable: number;
  /** The undecodable names as a person can be shown them (U+FFFD for each bad byte), never acted on. */
  undecodableShown: string[];
}

export const conflictCount = (found: ConflictedPaths): number =>
  found.paths.length + found.undecodable;

/** Read with `-z` and as latin1, so each byte of a name stays one character until it is judged. */
export async function conflictedPaths(worktreePath: string): Promise<ConflictedPaths> {
  const res = await gitRun(
    worktreePath,
    ['diff', '--name-only', '--diff-filter=U', '-z'],
    undefined,
    { encoding: 'latin1' },
  );
  if (res.code !== 0) {
    throw new Error(
      `git diff --diff-filter=U failed in ${worktreePath}: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  const found: ConflictedPaths = { paths: [], undecodable: 0, undecodableShown: [] };
  for (const raw of new Set(res.stdout.split('\0').filter(Boolean))) {
    const name = utf8Name(raw);
    if (name === null) {
      found.undecodable += 1;
      found.undecodableShown.push(Buffer.from(raw, 'latin1').toString('utf8'));
    } else found.paths.push(name);
  }
  return found;
}

export interface PlanMergeAttempt {
  /** Clean once no path is left unmerged — the plan files having been auto-resolved. */
  clean: boolean;
  /** Unmerged paths a person or an agent has to decide, plan files excluded. */
  conflicts: string[];
  /** Further unmerged paths whose names are not UTF-8, so none can be listed. */
  undecodable: number;
  /** Those names for a person to read, not to act on. */
  undecodableShown: string[];
  /** Plan-mirror files resolved automatically, reported so the caller can say so. */
  autoResolved: string[];
  /** Plan-mirror files that fell back to the incoming side, or kept the side that was not deleted. */
  warnings: string[];
  unrelated: boolean;
}

/**
 * Merge `origin/<branch>` into the scratch worktree and report what is left.
 *
 * `--allow-unrelated-histories` only when there genuinely is no common ancestor,
 * decided by `merge-base`'s exit code rather than passed always: the flag exists to
 * stop an accidental merge of two unrelated projects, and a blanket pass would
 * disable that guard for every ordinary merge too.
 */
export async function mergeOriginInto(
  worktreePath: string,
  branch: string,
  unrelated: boolean,
  // A merge with nothing to resolve COMMITS, so it needs an identity just as much
  // as `commitMerge` does. Passing it only to the latter made every clean merge die
  // on "Committer identity unknown" — the container runs as root with no git config.
  gitEnv: Record<string, string>,
): Promise<PlanMergeAttempt> {
  const flags = ['--no-edit', ...(unrelated ? ['--allow-unrelated-histories'] : [])];
  const opened = await openMerge(worktreePath, `origin/${branch}`, flags, gitEnv);
  if (opened.kind === 'merged') {
    return {
      clean: true,
      conflicts: [],
      undecodable: 0,
      undecodableShown: [],
      autoResolved: [],
      warnings: [],
      unrelated,
    };
  }
  // A refusal opens no merge, so reading it off the conflict list would report it as clean.
  if (opened.kind === 'refused') {
    throw new Error(`git merge could not start: ${opened.detail}`);
  }
  const { resolved: autoResolved, warnings } = await resolveHaiveProjectionConflicts(worktreePath);
  if (warnings.length > 0)
    logger.warn({ worktreePath, warnings }, 'plan merge fell back on a file');
  const left = await conflictedPaths(worktreePath);
  return {
    clean: conflictCount(left) === 0,
    conflicts: left.paths,
    undecodable: left.undecodable,
    undecodableShown: left.undecodableShown,
    autoResolved,
    warnings,
    unrelated,
  };
}

export async function abortMerge(worktreePath: string): Promise<void> {
  await abortGitMerge(worktreePath).catch(() => undefined);
}

async function commitOf(worktreePath: string, spec: string): Promise<string | null> {
  const res = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', `${spec}^{commit}`]);
  if (res.code === 0) return res.stdout.trim();
  if (res.code === 1) return null;
  throw new Error(`git rev-parse failed: ${(res.stderr || res.stdout).trim()}`);
}

/** The merge commit HEAD is, while it has not landed on the branch; null when HEAD is no such merge.
 *  `head` is its first parent, which a reopened worktree stands on. */
export async function unlandedResolvedMerge(args: {
  repoPath: string;
  worktreePath: string;
  branch: string;
}): Promise<{ sha: string; head: string } | null> {
  const { repoPath, worktreePath, branch } = args;
  const sha = await commitOf(worktreePath, 'HEAD');
  if (sha === null || (await commitOf(worktreePath, `${sha}^2`)) === null) return null;
  const head = await commitOf(worktreePath, `${sha}^1`);
  if (head === null) return null;
  const landed = await gitRun(repoPath, [
    'merge-base',
    '--is-ancestor',
    sha,
    `refs/heads/${branch}`,
  ]);
  if (landed.code === 0) return null;
  if (landed.code === 1) return { sha, head };
  throw new Error(`git merge-base failed: ${(landed.stderr || landed.stdout).trim()}`);
}

/** Reopen the unlanded resolved merge `prior` at its conflicts, as git opens them, for the agent to
 *  resolve again under the new guidance. Only the scratch worktree is written. Nothing of the previous
 *  answer is copied back: its paths, modes and directory/file choices are git's to restore, not a
 *  per-file copy's. */
export async function reopenResolvedMerge(args: {
  worktreePath: string;
  branch: string;
  unrelated: boolean;
  gitEnv: Record<string, string>;
  prior: string;
}): Promise<PlanMergeAttempt> {
  const { worktreePath, branch, prior } = args;
  const reset = await gitRun(worktreePath, ['reset', '--hard', `${prior}^1`]);
  if (reset.code !== 0) {
    throw new Error(`git reset (plan merge) failed: ${reset.stderr || reset.stdout}`);
  }
  return mergeOriginInto(worktreePath, branch, args.unrelated, args.gitEnv);
}

/** Commit a merge whose conflicts are all resolved. Separate from
 *  `completeMergeHostSide` (which verifies an AGENT's edits) because the clean and
 *  auto-resolved paths have nothing to verify. */
export async function commitMerge(
  worktreePath: string,
  message: string,
  gitEnv: Record<string, string>,
): Promise<string> {
  const open = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (open.code !== 0 && open.code !== 1) {
    throw new Error(
      `git rev-parse MERGE_HEAD failed in ${worktreePath}: ${(open.stderr || open.stdout).trim()}`,
    );
  }
  if (open.code === 0) {
    const commit = await gitRun(worktreePath, ['commit', '--no-edit', '-m', message], gitEnv);
    if (commit.code !== 0) {
      throw new Error(`git commit (plan merge) failed: ${commit.stderr || commit.stdout}`);
    }
  }
  return headCommit(worktreePath);
}

/** HEAD's commit; a failed read throws, since an empty answer reads as a HEAD that moved. */
export async function headCommit(repoPath: string): Promise<string> {
  const res = await gitRun(repoPath, ['rev-parse', 'HEAD']);
  if (res.code !== 0 || !res.stdout.trim()) {
    throw new Error(
      `git rev-parse HEAD failed in ${repoPath}: ${res.code === 0 ? 'empty answer' : (res.stderr || res.stdout).trim()}`,
    );
  }
  return res.stdout.trim();
}

/**
 * Move the real branch onto the merge result.
 *
 * `--ff-only`, and that is the whole safety argument: the merge commit carries the
 * checkout's own HEAD as its first parent, so a fast-forward is always possible and
 * always non-destructive. If it ever is not — someone committed to the checkout while
 * the conversation was open — git refuses and the caller reports it, rather than this
 * quietly resetting over their work.
 *
 * Returns the HEAD it moved from; the caller hands the written files back (`handBackAfterMove`)
 * once it has let go of the task-creation lock.
 */
export async function landPlanMerge(repoPath: string, sha: string): Promise<string> {
  const before = await headCommit(repoPath);
  const res = await gitRun(repoPath, ['merge', '--ff-only', sha]);
  if (res.code !== 0) {
    const changed = await gitRun(repoPath, [
      '--no-optional-locks',
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=no',
    ]);
    const first = changed.code === 0 ? changed.stdout.split('\0')[0]!.slice(3) : '';
    throw new Error(
      `${first ? `the checkout has uncommitted changes (${first})` : 'the checkout moved while the merge was open'}, ` +
        `so the result could not be fast-forwarded in: ${res.stderr || res.stdout}`,
    );
  }
  return before;
}

/** Both mirror files, for a caller that wants to name them. */
export const PLAN_MIRROR_FILES = [HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown] as const;
