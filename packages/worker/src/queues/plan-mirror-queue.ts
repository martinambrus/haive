import { Queue, Worker, type Job } from 'bullmq';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema } from '@haive/database';
import {
  CHECKOUT_HOLDING_TASK_STATUSES,
  PLAN_MIRROR_JOB_NAMES,
  QUEUE_NAMES,
  logger,
  type PlanMergeConflict,
  type PlanMirrorJobPayload,
  type PlanMirrorJobResult,
} from '@haive/shared';
import { lockPlanMerge } from '@haive/shared/plan';
import type {
  ProjectStateResolvePayload,
  ProjectStateResolveResult,
} from '@haive/shared/project-state';
import { resolveProjectStateConflict } from '../project-state/resolve.js';
import { markProjectStatesDirtyAtBoot, sweepDirtyProjectStates } from '../project-state/refresh.js';
import {
  MOVE_ATTEMPTS,
  putBackProjections,
  recoverAfterMoveFailure,
  restoreKeptMetadata,
  restoreProjectionsInTx,
  resyncHaiveProjections,
  setAsideHaiveProjections,
  type CheckoutFence,
  type KeptFiles,
} from '../project-state/set-aside.js';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { resolveGitEnv } from '../secrets/user-git-identity.js';
import { detectOrigin, gitRun, pushBranch } from '../repo/git-push.js';
import { checkoutHoldingTasks } from '../repo/refresh.js';
import { handBackAfterMove } from '../step-engine/git-merge.js';
import {
  PlanMirrorHeldError,
  advancePlanBaseFromCommit,
  flushPlanMirrorForRepository,
  recordPlanMirrorError,
  reconcilePlanFromCheckout,
  seedPlanBaseFromCheckout,
  stampPlanMirrorHashesAtBoot,
} from '../plan/mirror.js';
import { commitPlanSnapshotFiles } from '../plan/snapshot-git.js';
import {
  abortMerge,
  commitMerge,
  divergence,
  ensurePlanMergeWorktree,
  PLAN_MERGE_LIVE_STATUSES,
  fetchOrigin,
  landPlanMerge,
  mergeOriginInto,
  removePlanMergeWorktree,
} from '../plan/merge.js';
import { moveAsideRecordedLeftovers } from '../plan/merge-baseline.js';
import { pruneJobSchedulers } from './job-scheduler-prune.js';

const SWEEP_EVERY_MS = 10_000;
const SWEEP_JOB_ID = 'plan-mirror-dirty-sweep';
const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};
const PULL_BUSY = 'this repository has a task in flight; finish or cancel it before pulling';
const SAVE_BUSY =
  'this repository has a task in flight; the plan commit stays local and nothing was pushed; finish or cancel it before saving and pushing';

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
    columns: { revision: true, writtenRevision: true },
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

async function currentBranch(repoPath: string): Promise<string | null> {
  const res = await gitRun(repoPath, ['branch', '--show-current']);
  if (res.code !== 0) {
    throw new Error(`git branch failed in ${repoPath}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim() || null;
}

export interface IntegrateOutcome {
  landed: boolean;
  previousCommit: string | null;
  conflict?: PlanMergeConflict;
  /** Tasks holding the checkout when it was to move; it did not. */
  held?: number;
  /** Why Haive's own files could not make way for the move; it did not happen. */
  refused?: string;
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
 *
 * Haive's own pending projection files are set aside before the branch moves: `kept` holds
 * them, and they are put back here unless the checkout moved, when the caller re-syncs.
 */
export async function integrateOrigin(args: {
  repositoryId: string;
  repoPath: string;
  branch: string;
  userId: string;
  credentialId?: string | null;
  identity: Record<string, string>;
  kept: KeptFiles;
}): Promise<IntegrateOutcome> {
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
  const putBack = () => putBackProjections(db, args.repositoryId, args.repoPath, args.kept);
  if (gap.behind === 0) {
    await putBack();
    return { landed: false, previousCommit };
  }

  const fence = (conn: Parameters<typeof checkoutHoldingTasks>[0]) =>
    checkoutHoldingTasks(conn, args.repositoryId);
  for (let attempt = 1; ; attempt++) {
    const aside = await setAsideHaiveProjections(db, args.repositoryId, args.repoPath, fence);
    if (aside.outcome === 'held' || aside.outcome === 'refused') {
      await putBack();
      return aside.outcome === 'held'
        ? { landed: false, previousCommit, held: aside.holding }
        : { landed: false, previousCommit, refused: aside.reason };
    }
    if (aside.outcome === 'set-aside') {
      for (const [file, was] of aside.kept) if (!args.kept.has(file)) args.kept.set(file, was);
    }

    // A file found rewritten ends the transaction unmoved and goes back to the set-aside.
    const moved = await db.transaction(async (tx) => {
      await lockPlanMerge(tx, args.repositoryId);
      // The api refuses a save while a conversation is open, but one can open after that check.
      const [open] = await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.repositoryId, args.repositoryId),
            eq(schema.tasks.type, 'plan_merge'),
            inArray(schema.tasks.status, [...PLAN_MERGE_LIVE_STATUSES]),
          ),
        )
        .limit(1);
      if (open) throw new Error('A merge conversation is open for this repository');
      return mergeInScratch(tx, args, gap, previousCommit, fence);
    });
    if (moved.retry && attempt < MOVE_ATTEMPTS) continue;
    const { retry, movedFrom, ...outcome } = moved;
    if (movedFrom !== undefined) await handBackAfterMove(args.repoPath, movedFrom);
    if (!outcome.landed) await putBack();
    return retry
      ? { ...outcome, refused: "Haive's project files kept changing under the move" }
      : outcome;
  }
}

async function mergeInScratch(
  tx: Parameters<typeof restoreProjectionsInTx>[0],
  args: Parameters<typeof integrateOrigin>[0],
  gap: Awaited<ReturnType<typeof divergence>>,
  previousCommit: string | null,
  fence: CheckoutFence,
): Promise<IntegrateOutcome & { retry?: true; movedFrom?: string }> {
  const db = getDb();
  const worktree = await ensurePlanMergeWorktree(args.repoPath);
  let removed = false;
  // An abandoned conversation's merge is discarded below, but not what its fixers left: a failure
  // to move that aside fails the save before anything removes the worktree.
  await moveAsideRecordedLeftovers(db, args.repositoryId, worktree, `origin/${args.branch}`);
  try {
    const attempt = await mergeOriginInto(worktree, args.branch, gap.unrelated, args.identity);
    if (!attempt.clean) {
      await abortMerge(worktree);
      return {
        landed: false,
        previousCommit,
        conflict: {
          paths: [...attempt.conflicts, ...attempt.undecodableShown],
          unrelated: attempt.unrelated,
          autoResolved: attempt.autoResolved,
        },
      };
    }
    const sha = await commitMerge(worktree, `Merge origin/${args.branch}`, args.identity);
    if (!sha) throw new Error('the merge produced no commit to fast-forward onto');
    // The fast-forward needs the commit, not the worktree: remove it before taking the creation lock.
    removed = true;
    await removePlanMergeWorktree(args.repoPath);
    // Every task's start and every revival take this lock, so none lands between the fence and the move.
    await lockRepositoryTasksKey(tx, args.repositoryId);
    const check = await restoreProjectionsInTx(tx, args.repositoryId, args.repoPath);
    if (check.outcome === 'retry') return { landed: false, previousCommit, retry: true };
    if (check.outcome === 'refused') {
      return { landed: false, previousCommit, refused: check.reason };
    }
    const holding = await fence(tx);
    if (holding > 0) return { landed: false, previousCommit, held: holding };
    const movedFrom = await landPlanMerge(args.repoPath, sha);
    return { landed: true, previousCommit, movedFrom };
  } finally {
    if (!removed) await removePlanMergeWorktree(args.repoPath);
  }
}

export async function save(payload: PlanMirrorJobPayload): Promise<PlanMirrorJobResult> {
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

    // The commit has landed: only a push needs the branch, so a failed read fails only a push.
    const branch = payload.push
      ? await currentBranch(repoPath)
      : await currentBranch(repoPath).catch(() => null);
    let pushed = false;
    if (payload.push) {
      if (!branch) throw new Error('cannot push a plan snapshot from a detached HEAD');
      if (!(await detectOrigin(repoPath))) {
        throw new Error('this repository has no origin remote to push to');
      }
      const kept: KeptFiles = new Map();
      const before = (await gitRun(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
      try {
        // Integrate BEFORE pushing rather than pushing and reading the rejection: a
        // push that fails prints a hint git is free to reword, and branching on that
        // text would break silently on a git upgrade. Ahead/behind counts say the same
        // thing structurally.
        const integrated = await integrateOrigin({
          repositoryId: repo.id,
          repoPath,
          branch,
          userId: payload.userId,
          credentialId: repo.credentialsSecretId,
          identity,
          kept,
        });
        if (integrated.held !== undefined) throw new Error(SAVE_BUSY);
        if (integrated.refused !== undefined) {
          throw new Error(
            `${integrated.refused}; the plan commit stays local and nothing was pushed`,
          );
        }
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
          await reconcilePlanFromCheckout(getDb(), repo.id, repoPath);
          await flushPlanMirrorForRepository(getDb(), repo.id);
          await commitPlanSnapshotFiles({ repoPath, message, identity });
          await resyncHaiveProjections(getDb(), repo.id, repoPath);
          await restoreKeptMetadata(repoPath, kept);
        }
      } catch (err) {
        return recoverAfterMoveFailure(getDb(), repo.id, repoPath, kept, before, err);
      }
      const upstream = await gitRun(repoPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
      const head = await gitRun(repoPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${branch}^{commit}`,
      ]);
      const pushedHead = head.code === 0 ? head.stdout.trim() : null;
      if (!pushedHead) {
        throw new Error(
          'could not read branch tip; the plan commit is saved locally, retry the push',
        );
      }
      await pushBranch({
        sha: pushedHead,
        cwd: repoPath,
        branch,
        setUpstream: upstream.code !== 0,
        ...(repo.credentialsSecretId ? { credentialId: repo.credentialsSecretId } : {}),
        db: getDb(),
        userId: payload.userId,
      });
      pushed = true;
      await advancePlanBaseFromCommit(getDb(), repo.id, repoPath, pushedHead, branch);
    }

    return resultFor(repo.id, files, { committed, commitSha, pushed, branch });
  } catch (err) {
    await recordPlanMirrorError(getDb(), repo.id, err).catch(() => undefined);
    throw err;
  }
}

/**
 * The only direction that reads the repository INTO the database.
 *
 * The checkout only fast-forwards, onto a merge made in a scratch worktree.
 * A diverged branch is a real merge, with conflicts a person
 * has to resolve in a checkout; doing it here would either lose one side or
 * leave a half-merged tree that every later step then runs against. Refusing and
 * saying why is the honest option.
 */
export async function pull(payload: PlanMirrorJobPayload): Promise<PlanMirrorJobResult> {
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
        inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
        isNull(schema.tasks.deadAt),
      ),
    )
    .limit(1);
  if (busy.length > 0) {
    throw new Error(PULL_BUSY);
  }

  try {
    const inside = await gitRun(repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      throw new Error('this repository is not a Git checkout, so there is nothing to pull');
    }
    if (!(await detectOrigin(repoPath))) {
      throw new Error('this repository has no origin remote to pull from');
    }
    const branch = await currentBranch(repoPath);
    if (!branch) throw new Error('cannot pull onto a detached HEAD');
    // The set-aside replaces plan.json, which a row stamped before 0196 takes its base from.
    await seedPlanBaseFromCheckout(db, repo.id, repoPath);
    const kept: KeptFiles = new Map();
    const before = (await gitRun(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    // Before the dirty check below, which would refuse a file Haive wrote.
    const aside = await setAsideHaiveProjections(db, repo.id, repoPath, (conn) =>
      checkoutHoldingTasks(conn, repo.id),
    );
    if (aside.outcome === 'held') throw new Error(PULL_BUSY);
    if (aside.outcome === 'refused') {
      throw new Error(`${aside.reason}; nothing was pulled and the checkout was not moved`);
    }
    if (aside.outcome === 'set-aside') for (const [file, was] of aside.kept) kept.set(file, was);

    try {
      // Untracked files are fine — the sandbox leaves plenty. A MODIFIED tracked
      // file is what a fast-forward would refuse to touch, and the message it gives
      // is worse than this one.
      const dirty = await gitRun(repoPath, [
        '--no-optional-locks',
        'status',
        '--porcelain',
        '--untracked-files=no',
      ]);
      if (dirty.code !== 0) {
        throw new Error(
          `git status failed in ${repoPath}: ${dirty.stderr.trim() || dirty.stdout.trim()}`,
        );
      }
      if (dirty.stdout.trim().length > 0) {
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
        repositoryId: repo.id,
        repoPath,
        branch,
        userId: payload.userId,
        credentialId: repo.credentialsSecretId,
        identity,
        kept,
      });
      if (integrated.held !== undefined) throw new Error(PULL_BUSY);
      if (integrated.refused !== undefined) {
        throw new Error(`${integrated.refused}; nothing was pulled and the checkout was not moved`);
      }
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

      const outcome = await reconcilePlanFromCheckout(db, repo.id, repoPath);
      // Files are rewritten from the database afterwards, not trusted as pulled:
      // the reconcile keeps local-only nodes and local values under a question, so the
      // checkout's plan.json no longer says everything the plan does.
      const files = outcome.skipped ? [] : (await flushPlanMirrorForRepository(db, repo.id)).files;
      if (integrated.landed) {
        await resyncHaiveProjections(db, repo.id, repoPath);
        await restoreKeptMetadata(repoPath, kept);
      }

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
      return recoverAfterMoveFailure(db, repo.id, repoPath, kept, before, err);
    }
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
    .orderBy(asc(schema.planMirrorState.updatedAt))
    .limit(25);
  let flushed = 0;
  for (const row of dirty) {
    try {
      await refresh(row.repositoryId);
      flushed++;
    } catch (err) {
      if (err instanceof PlanMirrorHeldError) {
        logger.debug({ repositoryId: row.repositoryId }, 'dirty plan mirror held');
      } else {
        logger.warn({ err, repositoryId: row.repositoryId }, 'dirty plan mirror refresh failed');
      }
      // A row that cannot be written goes to the back, so stuck rows cannot starve the batch.
      await getDb()
        .update(schema.planMirrorState)
        .set({ updatedAt: new Date() })
        .where(eq(schema.planMirrorState.repositoryId, row.repositoryId))
        .catch(() => undefined);
    }
  }
  return flushed;
}

async function sweepAll(): Promise<number> {
  let swept = 0;
  try {
    swept += await sweepDirtyPlanMirrors();
  } catch (err) {
    logger.warn({ err }, 'plan mirror sweep failed');
  }
  try {
    swept += await sweepDirtyProjectStates(getDb());
  } catch (err) {
    logger.warn({ err }, 'project state sweep failed');
  }
  return swept;
}

export async function schedulePlanMirrorSweep(): Promise<void> {
  await stampPlanMirrorHashesAtBoot(getDb()).catch((err) => {
    logger.warn({ err }, 'plan mirror hashes not stamped at boot');
  });
  await markProjectStatesDirtyAtBoot(getDb()).catch((err) => {
    logger.warn({ err }, 'project states not marked dirty at boot');
  });
  const queue = new Queue(QUEUE_NAMES.PLAN_MIRROR, { connection: getBullRedis() });
  try {
    await queue.upsertJobScheduler(
      SWEEP_JOB_ID,
      { every: SWEEP_EVERY_MS },
      {
        name: PLAN_MIRROR_JOB_NAMES.SWEEP,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 10 },
      },
    );
    await pruneJobSchedulers(queue, [SWEEP_JOB_ID]);
  } finally {
    await queue.close().catch(() => {});
  }
}

export function startPlanMirrorWorker(): Worker<
  PlanMirrorJobPayload | ProjectStateResolvePayload,
  PlanMirrorJobResult | ProjectStateResolveResult | number
> {
  const worker = new Worker<
    PlanMirrorJobPayload | ProjectStateResolvePayload,
    PlanMirrorJobResult | ProjectStateResolveResult | number
  >(
    QUEUE_NAMES.PLAN_MIRROR,
    async (job: Job<PlanMirrorJobPayload | ProjectStateResolvePayload>) => {
      if (job.name === PLAN_MIRROR_JOB_NAMES.RESOLVE_PROJECT_STATE) {
        return resolveProjectStateConflict(getDb(), job.data as ProjectStateResolvePayload);
      }
      const data = job.data as PlanMirrorJobPayload;
      switch (job.name) {
        case PLAN_MIRROR_JOB_NAMES.REFRESH:
          if (!data.repositoryId) throw new Error('repositoryId required');
          return refresh(data.repositoryId, data.userId);
        case PLAN_MIRROR_JOB_NAMES.SAVE:
          return save(data);
        case PLAN_MIRROR_JOB_NAMES.PULL:
          return pull(data);
        case PLAN_MIRROR_JOB_NAMES.SWEEP:
          return sweepAll();
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
