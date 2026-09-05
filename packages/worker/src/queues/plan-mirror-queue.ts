import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  PLAN_MIRROR_JOB_NAMES,
  QUEUE_NAMES,
  logger,
  type PlanMergeConflict,
  type PlanMirrorJobPayload,
  type PlanMirrorJobResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { resolveGitEnv } from '../secrets/user-git-identity.js';
import { detectOrigin, gitRun, pushBranch } from '../repo/git-push.js';
import {
  flushPlanMirrorForRepository,
  recordPlanMirrorError,
  reconcilePlanMirror,
} from '../plan/mirror.js';
import { commitPlanSnapshotFiles } from '../plan/snapshot-git.js';
import {
  abortMerge,
  commitMerge,
  divergence,
  ensurePlanMergeWorktree,
  fetchOrigin,
  landPlanMerge,
  mergeOriginInto,
  removePlanMergeWorktree,
} from '../plan/merge.js';

const SWEEP_EVERY_MS = 10_000;
const SWEEP_JOB_ID = 'plan-mirror-dirty-sweep';
const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

async function requireOwnedRepository(repositoryId: string, userId?: string) {
  const repo = await getDb().query.repositories.findFirst({
    where: userId
      ? and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId))
      : eq(schema.repositories.id, repositoryId),
    columns: {
      id: true,
      userId: true,
      credentialsSecretId: true,
    },
  });
  if (!repo) throw new Error('repository not found');
  return repo;
}

async function resultFor(
  repositoryId: string,
  files: string[],
  extra: Pick<
    PlanMirrorJobResult,
    'committed' | 'commitSha' | 'pushed' | 'branch' | 'pulled' | 'conflict'
  >,
): Promise<PlanMirrorJobResult> {
  const state = await getDb().query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, repositoryId),
  });
  return {
    repositoryId,
    revision: state?.revision ?? 0,
    writtenRevision: state?.writtenRevision ?? 0,
    files,
    ...extra,
  };
}

async function refresh(repositoryId: string, userId?: string): Promise<PlanMirrorJobResult> {
  await requireOwnedRepository(repositoryId, userId);
  try {
    const { files } = await flushPlanMirrorForRepository(getDb(), repositoryId);
    return resultFor(repositoryId, files, {
      committed: false,
      commitSha: null,
      pushed: false,
      branch: null,
    });
  } catch (err) {
    await recordPlanMirrorError(getDb(), repositoryId, err).catch(() => undefined);
    throw err;
  }
}

/** Explicit save has a stronger contract than an asynchronous refresh: do not
 *  let a mutation racing the file write produce a knowingly old commit. The
 *  conditional writtenRevision update in writePlanMirror exposes that race;
 *  retry a bounded number of times until the two revisions meet. */
async function flushCurrentPlanMirror(
  repositoryId: string,
): Promise<{ files: string[]; repoPath: string }> {
  let last: { files: string[]; repoPath: string } | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await flushPlanMirrorForRepository(getDb(), repositoryId);
    const state = await getDb().query.planMirrorState.findFirst({
      where: eq(schema.planMirrorState.repositoryId, repositoryId),
      columns: { revision: true, writtenRevision: true },
    });
    if (state && state.revision === state.writtenRevision) return last;
  }
  throw new Error('the plan changed repeatedly while its snapshot was being saved; try again');
}

/**
 * Bring `origin/<branch>` into the checkout, or report why it cannot be done here.
 *
 * One path for both directions. Save used never to fetch at all and Pull was
 * `--ff-only`, so a remote with any commit of its own stopped both — including the
 * ordinary case of a GitHub repository created with a README, which shares no
 * history with a blank Haive one at all.
 *
 * The merge happens in a scratch worktree and the branch only ever FAST-FORWARDS
 * onto the result, so a failure at any point leaves the checkout exactly where it
 * was. On a conflict this aborts and removes the worktree rather than leaving a live
 * merge behind: the resolution conversation is a task, it builds its own worktree,
 * and two owners for one mid-merge tree is how a half-resolved state outlives the
 * thing that made it.
 */
async function integrateOrigin(args: {
  repoPath: string;
  branch: string;
  userId: string;
  credentialId?: string | null;
  identity: Record<string, string>;
}): Promise<{ landed: boolean; previousCommit: string | null; conflict?: PlanMergeConflict }> {
  const db = getDb();
  const head = await gitRun(args.repoPath, ['rev-parse', 'HEAD']);
  const previousCommit = head.code === 0 ? head.stdout.trim() : null;

  await fetchOrigin({
    repoPath: args.repoPath,
    branch: args.branch,
    db,
    userId: args.userId,
    ...(args.credentialId ? { credentialId: args.credentialId } : {}),
  });
  const gap = await divergence(args.repoPath, args.branch);
  if (gap.behind === 0) return { landed: false, previousCommit };

  const worktree = await ensurePlanMergeWorktree(args.repoPath);
  try {
    const attempt = await mergeOriginInto(worktree, args.branch, gap.unrelated, args.identity);
    if (!attempt.clean) {
      await abortMerge(worktree);
      return {
        landed: false,
        previousCommit,
        conflict: {
          paths: attempt.conflicts,
          unrelated: attempt.unrelated,
          autoResolved: attempt.autoResolved,
        },
      };
    }
    const sha = await commitMerge(worktree, `Merge origin/${args.branch}`, args.identity);
    if (!sha) throw new Error('the merge produced no commit to fast-forward onto');
    await landPlanMerge(args.repoPath, sha);
    return { landed: true, previousCommit };
  } finally {
    await removePlanMergeWorktree(args.repoPath);
  }
}

async function save(payload: PlanMirrorJobPayload): Promise<PlanMirrorJobResult> {
  if (!payload.repositoryId || !payload.userId) throw new Error('repositoryId and userId required');
  const repo = await requireOwnedRepository(payload.repositoryId, payload.userId);
  let files: string[] = [];
  let repoPath = '';
  try {
    ({ files, repoPath } = await flushCurrentPlanMirror(repo.id));
    if (files.length === 0) throw new Error('the repository has no plan snapshot to save');

    const inside = await gitRun(repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      throw new Error('repository snapshot cannot be committed because this is not a Git checkout');
    }

    const resolved = await resolveGitEnv(getDb(), {
      userId: payload.userId,
      repositoryId: repo.id,
    });
    const identity = Object.keys(resolved).length > 0 ? resolved : FALLBACK_GIT_IDENTITY;
    const message = payload.commitMessage?.trim() || 'docs: save project plan';
    const { committed, commitSha } = await commitPlanSnapshotFiles({
      repoPath,
      message,
      identity,
    });

    const branchResult = await gitRun(repoPath, ['branch', '--show-current']);
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null;
    let pushed = false;
    if (payload.push) {
      if (!branch) throw new Error('cannot push a plan snapshot from a detached HEAD');
      if (!(await detectOrigin(repoPath))) {
        throw new Error('this repository has no origin remote to push to');
      }
      // Integrate BEFORE pushing rather than pushing and reading the rejection: a
      // push that fails prints a hint git is free to reword, and branching on that
      // text would break silently on a git upgrade. Ahead/behind counts say the same
      // thing structurally.
      const integrated = await integrateOrigin({
        repoPath,
        branch,
        userId: payload.userId,
        credentialId: repo.credentialsSecretId,
        identity,
      });
      if (integrated.conflict) {
        // Nothing was pushed and nothing was lost — the plan commit above stands and
        // the checkout never moved. The caller offers the resolution conversation.
        return resultFor(repo.id, files, {
          committed,
          commitSha,
          pushed: false,
          branch,
          conflict: integrated.conflict,
        });
      }
      if (integrated.landed) {
        // The merge brought in the other side's plan; fold it into the database and
        // rewrite the files, exactly as a pull does, so what is pushed is the union
        // rather than only this side.
        await reconcilePlanMirror(getDb(), repo.id, repoPath);
        await flushPlanMirrorForRepository(getDb(), repo.id);
        await commitPlanSnapshotFiles({ repoPath, message, identity });
      }
      const upstream = await gitRun(repoPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
      await pushBranch({
        cwd: repoPath,
        branch,
        setUpstream: upstream.code !== 0,
        ...(repo.credentialsSecretId ? { credentialId: repo.credentialsSecretId } : {}),
        db: getDb(),
        userId: payload.userId,
      });
      pushed = true;
    }

    return resultFor(repo.id, files, { committed, commitSha, pushed, branch });
  } catch (err) {
    await recordPlanMirrorError(getDb(), repo.id, err).catch(() => undefined);
    throw err;
  }
}

/** Task states that hold the checkout. A pull under a live worktree is how a
 *  running step loses its tree, so it is refused rather than risked. `created` is
 *  absent deliberately: a task that was never enqueued holds nothing. */
const IN_FLIGHT_TASK_STATES = [
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
] as const;

/**
 * The only direction that reads the repository INTO the database.
 *
 * Fast-forward ONLY. A diverged branch is a real merge, with conflicts a person
 * has to resolve in a checkout; doing it here would either lose one side or
 * leave a half-merged tree that every later step then runs against. Refusing and
 * saying why is the honest option.
 */
async function pull(payload: PlanMirrorJobPayload): Promise<PlanMirrorJobResult> {
  if (!payload.repositoryId || !payload.userId) throw new Error('repositoryId and userId required');
  const db = getDb();
  const repo = await requireOwnedRepository(payload.repositoryId, payload.userId);

  const row = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repo.id),
    columns: { storagePath: true, localPath: true, branch: true },
  });
  const repoPath = row?.storagePath ?? row?.localPath ?? null;
  if (!repoPath) throw new Error('repository has no resolvable filesystem path');

  const busy = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repo.id),
        inArray(schema.tasks.status, [...IN_FLIGHT_TASK_STATES]),
      ),
    )
    .limit(1);
  if (busy.length > 0) {
    throw new Error('this repository has a task in flight; finish or cancel it before pulling');
  }

  try {
    const inside = await gitRun(repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      throw new Error('this repository is not a Git checkout, so there is nothing to pull');
    }
    if (!(await detectOrigin(repoPath))) {
      throw new Error('this repository has no origin remote to pull from');
    }
    const branchResult = await gitRun(repoPath, ['branch', '--show-current']);
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : '';
    if (!branch) throw new Error('cannot pull onto a detached HEAD');
    // Untracked files are fine — the sandbox leaves plenty. A MODIFIED tracked
    // file is what a fast-forward would refuse to touch, and the message it gives
    // is worse than this one.
    const dirty = await gitRun(repoPath, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
      throw new Error('this checkout has uncommitted changes; commit or discard them first');
    }

    const resolvedIdentity = await resolveGitEnv(db, {
      userId: payload.userId,
      repositoryId: repo.id,
    });
    const identity =
      Object.keys(resolvedIdentity).length > 0 ? resolvedIdentity : FALLBACK_GIT_IDENTITY;
    // A real merge, not --ff-only. Refusing a diverged branch was defensible while
    // nothing could resolve one; it also meant a plan could never reach a repository
    // that had a README before Haive did.
    const integrated = await integrateOrigin({
      repoPath,
      branch,
      userId: payload.userId,
      credentialId: repo.credentialsSecretId,
      identity,
    });
    const previousCommit = integrated.previousCommit;
    if (integrated.conflict) {
      return resultFor(repo.id, [], {
        committed: false,
        commitSha: previousCommit,
        pushed: false,
        branch,
        conflict: integrated.conflict,
      });
    }
    const after = await gitRun(repoPath, ['rev-parse', 'HEAD']);
    const currentCommit = after.code === 0 ? after.stdout.trim() : null;

    const outcome = await reconcilePlanMirror(db, repo.id, repoPath);
    // Files are rewritten from the database afterwards, not trusted as pulled:
    // the reconcile KEEPS local-only nodes, so the checkout's plan.json is now
    // missing rows the plan has.
    const files = outcome.skipped ? [] : (await flushPlanMirrorForRepository(db, repo.id)).files;

    return resultFor(repo.id, files, {
      committed: false,
      commitSha: currentCommit,
      pushed: false,
      branch,
      pulled: {
        ...outcome,
        previousCommit,
        fastForwarded: previousCommit !== currentCommit,
      },
    });
  } catch (err) {
    await recordPlanMirrorError(db, repo.id, err).catch(() => undefined);
    throw err;
  }
}

export async function sweepDirtyPlanMirrors(): Promise<number> {
  const dirty = await getDb()
    .select({ repositoryId: schema.planMirrorState.repositoryId })
    .from(schema.planMirrorState)
    .where(lt(schema.planMirrorState.writtenRevision, schema.planMirrorState.revision))
    .limit(25);
  let flushed = 0;
  for (const row of dirty) {
    try {
      await refresh(row.repositoryId);
      flushed++;
    } catch (err) {
      logger.warn({ err, repositoryId: row.repositoryId }, 'dirty plan mirror refresh failed');
    }
  }
  return flushed;
}

export async function schedulePlanMirrorSweep(): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.PLAN_MIRROR, { connection: getBullRedis() });
  await queue.upsertJobScheduler(
    SWEEP_JOB_ID,
    { every: SWEEP_EVERY_MS },
    {
      name: PLAN_MIRROR_JOB_NAMES.SWEEP,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: 10 },
    },
  );
  await queue.close();
}

export function startPlanMirrorWorker(): Worker<
  PlanMirrorJobPayload,
  PlanMirrorJobResult | number
> {
  const worker = new Worker<PlanMirrorJobPayload, PlanMirrorJobResult | number>(
    QUEUE_NAMES.PLAN_MIRROR,
    async (job: Job<PlanMirrorJobPayload>) => {
      switch (job.name) {
        case PLAN_MIRROR_JOB_NAMES.REFRESH:
          if (!job.data.repositoryId) throw new Error('repositoryId required');
          return refresh(job.data.repositoryId, job.data.userId);
        case PLAN_MIRROR_JOB_NAMES.SAVE:
          return save(job.data);
        case PLAN_MIRROR_JOB_NAMES.PULL:
          return pull(job.data);
        case PLAN_MIRROR_JOB_NAMES.SWEEP:
          return sweepDirtyPlanMirrors();
        default:
          throw new Error(`unknown plan-mirror job: ${job.name}`);
      }
    },
    { connection: getBullRedis(), concurrency: 2 },
  );
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, name: job?.name, err }, 'plan mirror job failed');
  });
  return worker;
}
