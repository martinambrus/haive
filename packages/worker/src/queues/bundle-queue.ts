import { Queue, Worker, type Job } from 'bullmq';
import { BUNDLE_JOB_NAMES, QUEUE_NAMES, logger, type BundleJobPayload } from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { handleIngestGit, handleIngestZip, handleResyncGit } from '../repo/bundle-ingest.js';
import { runBundleGitSyncTick } from '../repo/bundle-sync.js';

/** Daily tick interval, jittered by ±2h at schedule time so multiple worker
 *  pods don't pile up on the same boundary. */
const GIT_SYNC_BASE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GIT_SYNC_JOB_ID = 'bundle-git-sync-tick-repeatable';

let bundleQueueSingleton: Queue | null = null;

function getBundleQueueLocal(): Queue {
  if (!bundleQueueSingleton) {
    bundleQueueSingleton = new Queue(QUEUE_NAMES.BUNDLE, { connection: getBullRedis() });
  }
  return bundleQueueSingleton;
}

/** Idempotent: schedules the repeatable job once. Safe to call multiple
 *  times across worker restarts — BullMQ deduplicates by `jobId`. */
export async function scheduleBundleGitSyncTick(): Promise<void> {
  const queue = getBundleQueueLocal();
  const jitter = Math.floor((Math.random() * 4 - 2) * 60 * 60 * 1000);
  await queue.add(BUNDLE_JOB_NAMES.GIT_SYNC_TICK, {} as unknown as BundleJobPayload, {
    repeat: { every: GIT_SYNC_BASE_INTERVAL_MS + jitter },
    jobId: GIT_SYNC_JOB_ID,
    removeOnComplete: true,
    removeOnFail: 10,
  });
}

export function startBundleWorker(bundleStorageRoot: string): Worker {
  const worker = new Worker<BundleJobPayload>(
    QUEUE_NAMES.BUNDLE,
    async (job: Job<BundleJobPayload>) => {
      const db = getDb();
      const payload = job.data;
      switch (job.name) {
        case BUNDLE_JOB_NAMES.INGEST_ZIP:
          await handleIngestZip(payload, db, bundleStorageRoot);
          return;
        case BUNDLE_JOB_NAMES.INGEST_GIT:
          await handleIngestGit(payload, db, bundleStorageRoot);
          return;
        case BUNDLE_JOB_NAMES.RESYNC_GIT:
          await handleResyncGit(payload, db, bundleStorageRoot);
          return;
        case BUNDLE_JOB_NAMES.GIT_SYNC_TICK:
          await runBundleGitSyncTick(db);
          return;
        default:
          throw new Error(`Unknown bundle job: ${job.name}`);
      }
    },
    {
      connection: getBullRedis(),
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Bundle job completed');
  });
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, name: job?.name, err }, 'Bundle job failed');
  });

  return worker;
}
