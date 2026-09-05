import { access } from 'node:fs/promises';
import { HAIVE_DATA_FILES } from '@haive/shared';
import { buildCredentialHelper, gitRun, scrubSecret } from '../repo/git-push.js';
import { ensureSandboxWritableTree } from '../repo/worktree-permissions.js';
import { WORKTREE_SUBDIR } from '../repo/worktree-paths.js';
import { PLAN_SNAPSHOT_GIT_PATHS } from './snapshot-git.js';
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

async function pathExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
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
export async function ensurePlanMergeWorktree(repoPath: string): Promise<string> {
  const worktreePath = planMergeWorktreePath(repoPath);
  await gitRun(repoPath, ['worktree', 'prune']);
  const list = await gitRun(repoPath, ['worktree', 'list', '--porcelain']);
  const registered =
    list.code === 0 && list.stdout.split('\n').some((l) => l === `worktree ${worktreePath}`);
  if (!registered) {
    if (await pathExists(worktreePath)) {
      await gitRun(repoPath, ['worktree', 'remove', '--force', worktreePath]);
    }
    const add = await gitRun(repoPath, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
    if (add.code !== 0) {
      throw new Error(`git worktree add (plan merge) failed: ${add.stderr || add.stdout}`);
    }
  }
  await ensureSandboxWritableTree(worktreePath);
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
}): Promise<void> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  const argv: string[] = [];
  let secret: string | null = null;
  if (args.credentialId) {
    const helper = await buildCredentialHelper(args.db, args.credentialId, args.userId);
    secret = helper.secret;
    Object.assign(env, helper.env);
    argv.push(...helper.argv);
  }
  const res = await gitRun(args.repoPath, [...argv, 'fetch', 'origin', args.branch], env);
  if (res.code !== 0) {
    throw new Error(`git fetch failed: ${scrubSecret(res.stderr || res.stdout, secret)}`);
  }
}

/** How far apart the checkout and the fetched remote are.
 *
 *  Keyed on counts and on `merge-base`'s EXIT CODE, never on git's stderr. A push
 *  rejection prints a multi-line hint that git is free to reword at any release
 *  (`pushBranch` throws it verbatim), so branching on it would break silently on a
 *  git upgrade — and silently is the worst way for this to break, because the
 *  symptom would be a push that stops integrating. */
export async function divergence(
  repoPath: string,
  branch: string,
): Promise<{ ahead: number; behind: number; unrelated: boolean }> {
  const count = async (range: string): Promise<number> => {
    const res = await gitRun(repoPath, ['rev-list', '--count', range]);
    const n = Number.parseInt(res.stdout.trim(), 10);
    return res.code === 0 && Number.isFinite(n) ? n : 0;
  };
  const base = await gitRun(repoPath, ['merge-base', 'HEAD', `origin/${branch}`]);
  const unrelated = base.code !== 0;
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

/** Paths git reports as unmerged — the same call the task-side resolver makes. */
export async function conflictedPaths(worktreePath: string): Promise<string[]> {
  const res = await gitRun(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const PLAN_PATHS = new Set<string>(PLAN_SNAPSHOT_GIT_PATHS);

/**
 * Resolve a conflict in the plan mirror's OWN two files by taking the incoming side.
 *
 * Not a guess, and not a preference for the remote: `reconcilePlanMirror` reads
 * `.haive-data/plan.json` out of the checkout and merges it into the DATABASE
 * additively — keeping every local-only node — and the files are then rewritten from
 * the database. So the incoming side is what the real merge needs to see, and
 * whatever lands in the file here survives only until that rewrite. Asking a person
 * or an agent to hand-merge two thousand-node JSON documents would be work whose
 * result is discarded seconds later.
 *
 * `plan.md` has no reader at all — it is a rendering of the same data — so it takes
 * the incoming side purely to let the merge close.
 */
export async function autoResolvePlanFiles(worktreePath: string): Promise<string[]> {
  const resolved: string[] = [];
  for (const path of await conflictedPaths(worktreePath)) {
    if (!PLAN_PATHS.has(path)) continue;
    // --theirs on a conflicted path is the incoming side. An add/add where OUR side
    // is the only one present cannot be checked out that way, so a failure here
    // leaves the path conflicted for the caller to report rather than throwing.
    const take = await gitRun(worktreePath, ['checkout', '--theirs', '--', path]);
    if (take.code !== 0) continue;
    const add = await gitRun(worktreePath, ['add', '--', path]);
    if (add.code !== 0) continue;
    resolved.push(path);
  }
  return resolved;
}

export interface PlanMergeAttempt {
  /** Clean once no path is left unmerged — the plan files having been auto-resolved. */
  clean: boolean;
  /** Unmerged paths a person or an agent has to decide, plan files excluded. */
  conflicts: string[];
  /** Plan-mirror files resolved automatically, reported so the caller can say so. */
  autoResolved: string[];
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
  const args = ['merge', '--no-ff', '--no-edit'];
  if (unrelated) args.push('--allow-unrelated-histories');
  args.push(`origin/${branch}`);
  const merged = await gitRun(worktreePath, args, gitEnv);
  if (merged.code === 0) {
    return { clean: true, conflicts: [], autoResolved: [], unrelated };
  }
  // A non-zero exit means EITHER conflicts or a merge that never started (refused
  // unrelated histories, a dirty tree, a bad ref). MERGE_HEAD is what separates them,
  // and the difference is load-bearing: with no merge open there are no unmerged
  // paths, so judging by the conflict list alone reports a refusal as a CLEAN merge
  // and the caller goes on to land nothing. Caught by the unrelated-histories test.
  const open = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (open.code !== 0) {
    throw new Error(`git merge could not start: ${merged.stderr || merged.stdout}`);
  }
  const autoResolved = await autoResolvePlanFiles(worktreePath);
  const conflicts = await conflictedPaths(worktreePath);
  return { clean: conflicts.length === 0, conflicts, autoResolved, unrelated };
}

export async function abortMerge(worktreePath: string): Promise<void> {
  await gitRun(worktreePath, ['merge', '--abort']).catch(() => undefined);
}

/** Commit a merge whose conflicts are all resolved. Separate from
 *  `completeMergeHostSide` (which verifies an AGENT's edits) because the clean and
 *  auto-resolved paths have nothing to verify. */
export async function commitMerge(
  worktreePath: string,
  message: string,
  gitEnv: Record<string, string>,
): Promise<string | null> {
  const open = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (open.code === 0) {
    const commit = await gitRun(worktreePath, ['commit', '--no-edit', '-m', message], gitEnv);
    if (commit.code !== 0) {
      throw new Error(`git commit (plan merge) failed: ${commit.stderr || commit.stdout}`);
    }
  }
  const head = await gitRun(worktreePath, ['rev-parse', 'HEAD']);
  return head.code === 0 ? head.stdout.trim() : null;
}

/**
 * Move the real branch onto the merge result.
 *
 * `--ff-only`, and that is the whole safety argument: the merge commit carries the
 * checkout's own HEAD as its first parent, so a fast-forward is always possible and
 * always non-destructive. If it ever is not — someone committed to the checkout while
 * the conversation was open — git refuses and the caller reports it, rather than this
 * quietly resetting over their work.
 */
export async function landPlanMerge(repoPath: string, sha: string): Promise<void> {
  const res = await gitRun(repoPath, ['merge', '--ff-only', sha]);
  if (res.code !== 0) {
    throw new Error(
      'the checkout moved while the merge was open, so the result could not be ' +
        `fast-forwarded in: ${res.stderr || res.stdout}`,
    );
  }
}

/** Both mirror files, for a caller that wants to name them. */
export const PLAN_MIRROR_FILES = [HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown] as const;
