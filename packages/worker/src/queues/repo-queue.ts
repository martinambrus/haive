import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { QUEUE_NAMES, REPO_JOB_NAMES, logger, type RepoJobPayload } from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { handleClone, handleExtract, handleScan } from '../repo/clone.js';

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
