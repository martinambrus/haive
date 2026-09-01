import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  PLAN_MIRROR_JOB_NAMES,
  QUEUE_NAMES,
  logger,
  type PlanMirrorJobPayload,
  type PlanMirrorJobResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { resolveGitEnv } from '../secrets/user-git-identity.js';
import { gitRun, pushBranch } from '../repo/git-push.js';
import { flushPlanMirrorForRepository, recordPlanMirrorError } from '../plan/mirror.js';
import { commitPlanSnapshotFiles } from '../plan/snapshot-git.js';

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
  extra: Pick<PlanMirrorJobResult, 'committed' | 'commitSha' | 'pushed' | 'branch'>,
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
