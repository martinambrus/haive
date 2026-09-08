import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

const exec = promisify(execFile);

/**
 * Commits that reached this repository without Haive making them.
 *
 * A repository is not only edited by Haive. A teammate pushes, the user commits from
 * their own editor, the plan-mirror PULL job merges origin into the checkout. Two layers
 * already saw that and one of them only by accident: `00a-sync-base` fetches and
 * fast-forwards the base before the branch is cut, and `02-pre-rag-sync` re-collects
 * EVERY file and dedupes on `chunk_hash`, so it never asks what changed and therefore
 * cannot miss anything. Everything derived from the code was scoped to the current task —
 * the KB prompt to `filesTouched`, the plan reconcile to this branch's merge-base diff.
 *
 * This module answers the one question none of them asked: what landed since we last
 * looked. It is deterministic, shells out to git only, and is the whole of the
 * detection — both catch-up steps read it and neither re-derives any of it.
 */

/** Per-invocation caps. Both are REPORTED rather than applied silently: a capped list a
 *  reader believes is complete is how a reviewer once approved 100 of 150 files as though
 *  it had seen them all (`changedFilesBlock`'s coverage rule). */
export const MAX_EXTERNAL_COMMITS = 200;
export const MAX_EXTERNAL_PATHS = 200;

/** Which watermark a caller is asking about. The two advance independently because the
 *  two catch-up steps are independently skippable, declinable and failable. */
export type DriftKind = 'kb' | 'plan';

export interface ExternalCommit {
  sha: string;
  subject: string;
}

export interface ExternalDrift {
  repositoryId: string | null;
  /** The commit this task branched from — the point drift is measured UP TO, and the
   *  value a step stamps once it has reviewed through it. Null when the range could not
   *  be resolved at all, which is the only state that means "this step cannot run". */
  branchPoint: string | null;
  /** The watermark drift was measured FROM. Null on a repository never tracked. */
  since: string | null;
  /** No watermark existed (or the stored one is no longer in this repository's history).
   *  Nothing is reviewed; the branch point is stamped so tracking starts here. */
  firstRun: boolean;
  commits: ExternalCommit[];
  /** Repo-relative paths those commits touched. Derived from the surviving commits only,
   *  so a range that also contains Haive's own commits does not over-report their files. */
  changedPaths: string[];
  /** Commits/paths dropped by the caps above (0 when nothing was dropped). */
  commitsOmitted: number;
  pathsOmitted: number;
  /** Why there is nothing to review, for the step's own output. Null when there is. */
  reason: string | null;
}

const NOTHING: ExternalDrift = {
  repositoryId: null,
  branchPoint: null,
  since: null,
  firstRun: false,
  commits: [],
  changedPaths: [],
  commitsOmitted: 0,
  pathsOmitted: 0,
  reason: 'no repository',
};

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.toString();
  } catch {
    return null;
  }
}

/**
 * The commit this task's work forks from.
 *
 * The merge-base, NOT `HEAD`, for the same reason `resolveDiffBase` picks it in
 * `_impl-changes.ts`: the two execution paths commit differently and only the fork point
 * covers both. Here it matters in the other direction too — anything this task itself
 * committed is beyond the fork point and must never be presented as somebody else's work.
 *
 * Falls back to `HEAD` when the base branch is unknown or gone. A repository whose HEAD
 * does not resolve has no range at all and the caller skips.
 */
export async function resolveBranchPoint(
  worktreePath: string,
  baseBranch: string | null,
): Promise<string | null> {
  if (baseBranch) {
    const out = await git(worktreePath, ['merge-base', 'HEAD', baseBranch]);
    const sha = out?.trim();
    if (sha) return sha;
  }
  const head = await git(worktreePath, ['rev-parse', 'HEAD']);
  return head?.trim() || null;
}

/**
 * Every commit sha Haive itself put on this repository.
 *
 * The watermark advances only as far as a step actually REVIEWED, so a task's own commits
 * land inside the NEXT task's range whenever this task's catch-up did not reach a decision
 * (it errored, the switch was off, the run was abandoned and a later one merged anyway).
 * Presenting Haive's own work back to the user as external drift would be a lie, so it is
 * subtracted.
 *
 * Two sources, because a squash changes the answer. `tasks.commit_sha` is the commit
 * 10-gate-3-commit wrote on the feature branch, which survives an ordinary merge; when
 * 12-worktree-cleanup collapses the branch instead, those commits are unreachable from the
 * base tip and a NEW sha appears there, recorded in `task_steps.merge_resolve_state`.
 * Reading only the first would leave every squashed task looking external.
 *
 * Two sources and not three because `--no-merges` on the range covers the last shape:
 * cleanup's own MERGE commit has a sha nothing here records, and dropping merges removes
 * it while leaving the feature commits beneath it — which `tasks.commit_sha` then catches.
 * So all three cleanup outcomes are covered: merge by the log flag, squash by the jsonb
 * sha, fast-forward by the task sha.
 *
 * Keyed on recorded shas and never on the committer name, which is user-configurable and
 * therefore ephemeral — matching an identity string would break the moment someone sets
 * their own `git config user.name`.
 */
async function haiveOwnShas(db: Database, repositoryId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const rows = await db
    .select({ sha: schema.tasks.commitSha })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.repositoryId, repositoryId), isNotNull(schema.tasks.commitSha)));
  for (const r of rows) if (r.sha) out.add(r.sha.trim());

  const squashed = await db
    .select({
      sha: sql<string | null>`${schema.taskSteps.mergeResolveState} ->> 'squashCommitSha'`,
    })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        isNotNull(schema.taskSteps.mergeResolveState),
      ),
    );
  for (const r of squashed) if (r.sha) out.add(r.sha.trim());
  return out;
}

/**
 * Parse `git log --format=%x00%H%x1f%s --name-only`.
 *
 * One git call rather than a `log` plus a `diff`, so each commit keeps its OWN paths and
 * an excluded commit's files can be dropped precisely. A range-wide `git diff` would
 * attribute Haive's files to the external set, and over-reporting scope is not free here:
 * every path becomes something an agent is told to go and read.
 */
export function parseCommitLog(stdout: string): { commit: ExternalCommit; paths: string[] }[] {
  const out: { commit: ExternalCommit; paths: string[] }[] = [];
  for (const record of stdout.split('\0')) {
    const trimmed = record.replace(/^\n+/, '');
    if (trimmed.length === 0) continue;
    const [header, ...rest] = trimmed.split('\n');
    const sep = header?.indexOf('\x1f') ?? -1;
    if (!header || sep < 0) continue;
    out.push({
      commit: { sha: header.slice(0, sep), subject: header.slice(sep + 1) },
      paths: rest.map((l) => l.trim()).filter((l) => l.length > 0),
    });
  }
  return out;
}

/**
 * What landed on this repository since the given watermark was stamped.
 *
 * Never throws: every failure degrades to a drift with a `reason` and no commits, because
 * a catch-up that cannot measure must not block the task it is riding.
 */
export async function resolveExternalDrift(
  ctx: StepContext,
  kind: DriftKind,
): Promise<ExternalDrift> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { repositoryId: true, worktreePath: true },
  });
  if (!task?.repositoryId) return NOTHING;
  const repositoryId = task.repositoryId;

  const repo = await ctx.db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { branch: true, kbSyncedCommit: true, planSyncedCommit: true },
  });
  const empty = (reason: string): ExternalDrift => ({
    ...NOTHING,
    repositoryId,
    reason,
  });

  // 01-worktree-setup's own output carries the base branch; `tasks.worktree_path` is the
  // durable half and survives a Retry that nulls step output.
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const wt = prev?.output as { worktreePath?: string; baseBranch?: string } | null;
  const worktreePath = wt?.worktreePath ?? task.worktreePath ?? ctx.workspacePath;
  const baseBranch = wt?.baseBranch ?? repo?.branch ?? null;

  const branchPoint = await resolveBranchPoint(worktreePath, baseBranch);
  if (!branchPoint) return empty('this repository has no resolvable git history');

  const since = (kind === 'kb' ? repo?.kbSyncedCommit : repo?.planSyncedCommit) ?? null;

  // A watermark that is no longer in this repository's history — a force-push, a rewritten
  // branch, a repository re-imported under the same row — cannot bound a range. Treated as
  // a first run rather than an error: stamping the branch point restarts tracking, where
  // failing would leave the repository permanently unable to catch up.
  const known = since ? await git(worktreePath, ['cat-file', '-e', `${since}^{commit}`]) : null;
  if (!since || known === null) {
    return {
      ...NOTHING,
      repositoryId,
      branchPoint,
      since: null,
      firstRun: true,
      reason: since ? 'the recorded watermark is no longer in this history' : null,
    };
  }
  if (since === branchPoint) return { ...empty('no new commits'), branchPoint, since };

  const stdout = await git(worktreePath, [
    'log',
    '--format=%x00%H%x1f%s',
    '--name-only',
    '--no-merges',
    `${since}..${branchPoint}`,
  ]);
  if (stdout === null) {
    return { ...empty('the commit range could not be read'), branchPoint, since };
  }

  const own = await haiveOwnShas(ctx.db, repositoryId);
  const external = parseCommitLog(stdout).filter((c) => !own.has(c.commit.sha));
  if (external.length === 0) {
    return { ...empty('every commit in this range was made by Haive'), branchPoint, since };
  }

  const kept = external.slice(0, MAX_EXTERNAL_COMMITS);
  const paths = [...new Set(kept.flatMap((c) => c.paths))];
  return {
    repositoryId,
    branchPoint,
    since,
    firstRun: false,
    commits: kept.map((c) => c.commit),
    changedPaths: paths.slice(0, MAX_EXTERNAL_PATHS),
    commitsOmitted: external.length - kept.length,
    pathsOmitted: Math.max(0, paths.length - MAX_EXTERNAL_PATHS),
    reason: null,
  };
}

/** Record that a catch-up step has reviewed this repository through `sha`. */
export async function stampExternalWatermark(
  db: Database,
  repositoryId: string,
  kind: DriftKind,
  sha: string,
): Promise<void> {
  await db
    .update(schema.repositories)
    .set({
      ...(kind === 'kb' ? { kbSyncedCommit: sha } : { planSyncedCommit: sha }),
      updatedAt: new Date(),
    })
    .where(eq(schema.repositories.id, repositoryId));
}

/** The commit list as prompt lines, with the omission stated the way `changedFilesBlock`
 *  states its own — a reader who is not told about a cap will assume there was none. */
export function externalCommitBlock(drift: ExternalDrift): string {
  const lines = drift.commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.subject}`);
  if (drift.commitsOmitted > 0) {
    lines.push(
      `- (+${drift.commitsOmitted} further commit(s) not listed — say so in your report ` +
        `rather than implying you saw the whole range)`,
    );
  }
  return lines.join('\n');
}
