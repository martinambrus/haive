import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { QUEUE_NAMES, REPO_JOB_NAMES, logger, type RepoJobPayload } from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import {
  handleClone,
  handleCopyLocal,
  handleExtract,
  handleInit,
  handleScan,
} from '../repo/clone.js';

export function startRepoWorker(repoStorageRoot: string): Worker {
  const worker = new Worker<RepoJobPayload>(
    QUEUE_NAMES.REPO,
    async (job: Job<RepoJobPayload>) => {
      const db = getDb();
      const payload = job.data;
      try {
        if (job.name === REPO_JOB_NAMES.CLONE) {
          await handleClone(payload, db, repoStorageRoot);
        } else if (job.name === REPO_JOB_NAMES.SCAN) {
          await handleScan(payload, db);
        } else if (job.name === REPO_JOB_NAMES.EXTRACT) {
          await handleExtract(payload, db, repoStorageRoot);
        } else if (job.name === REPO_JOB_NAMES.COPY) {
          await handleCopyLocal(payload, db, repoStorageRoot);
        } else if (job.name === REPO_JOB_NAMES.INIT) {
          await handleInit(payload, db, repoStorageRoot);
        } else {
          throw new Error(`Unknown repo job: ${job.name}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { repositoryId: payload.repositoryId, jobName: job.name, err },
          'Repo job failed',
        );
        await db
          .update(schema.repositories)
          .set({
            status: 'error',
            statusMessage: message,
            updatedAt: new Date(),
          })
          .where(eq(schema.repositories.id, payload.repositoryId));
        throw err;
      }
    },
    {
      connection: getBullRedis(),
      concurrency: 5,
      // Clone, copy and extract all run unbounded — `gitClone` has no timeout and `copyTree` is
      // bounded only by repository size, which is why each takes a renewable root claim. The
      // default 30s lock expires whenever the renewal timer cannot run (event-loop starvation, a
      // Redis hiccup, a tsx-watch restart), and BullMQ then redelivers the job to a second
      // processor WHILE the first is still inside `rm -rf` + `cp -a` on the same root. The claim
      // refuses that second runner, whose catch writes `error` while the first is still working,
      // and the first then overwrites it with `ready` — so the short lock is a correctness
      // problem here, not only a liveness one.
      lockDuration: 30 * 60 * 1000,
      // Default 1 makes the SECOND stall of a job terminal, and terminal here means the deferred
      // failure is raised on the next pickup BEFORE the processor runs — so the catch that writes
      // `status: 'error'` never executes and the repository strands at `cloning` for good. Two
      // restarts inside one clone is ordinary (a crash loop, an OOM cycle, a deploy). The boot
      // reconciler in `data-migrations.ts` is the backstop for the strand this still leaves.
      maxStalledCount: 10,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Repo job completed');
  });
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, name: job?.name, err }, 'Repo job failed');
  });

  return worker;
}
