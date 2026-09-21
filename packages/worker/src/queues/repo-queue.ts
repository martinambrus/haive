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
      // Default 1 makes the SECOND stall of a job terminal, and terminal here means the deferred
      // failure is raised on the next pickup BEFORE the processor runs — so the catch that writes
      // `status: 'error'` never executes and the repository strands at `cloning` for good. Two
      // restarts inside one clone is ordinary (a crash loop, an OOM cycle, a deploy). The boot
      // reconciler in `data-migrations.ts` is the backstop for the strand this still leaves.
      maxStalledCount: 10,
      // `lockDuration` is deliberately LEFT at the 30s default, unlike task-queue and cli-exec.
      // Raising it here makes the common case worse: shutdown force-closes this worker, so an
      // ordinary deploy leaves the job `active` and BullMQ redelivers it only once the lock
      // expires — at 30 min that is half an hour of `cloning` on every restart, and the boot
      // reconciler sees the job in `active` and correctly declines to release the row. The long
      // lock's usual benefit does not apply either: what it buys elsewhere is protection from a
      // second processor running concurrently, and here `withRootClaim` already refuses that.
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
