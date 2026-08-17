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

/** Idempotent: upsertJobScheduler keys on GIT_SYNC_JOB_ID, so a restart UPDATES the one
 *  scheduler rather than adding a duplicate. The jitter stays — a ±2h spread is worth
 *  keeping on a daily tick — because a scheduler is keyed by its id, not by a hash of its
 *  options.
 *
 *  Do NOT go back to `repeat: { every }`. That key WAS an options hash, so the jitter minted
 *  a fresh key on every restart and `jobId` never deduplicated them — 3308 accumulated on this
 *  queue and all kept firing. The one-time sweep that cleared them shipped in 38e13a2 and was
 *  removed with the bullmq 6 bump, which deletes getRepeatableJobs/removeRepeatableByKey. */
export async function scheduleBundleGitSyncTick(): Promise<void> {
  const queue = getBundleQueueLocal();
  const jitter = Math.floor((Math.random() * 4 - 2) * 60 * 60 * 1000);
  await queue.upsertJobScheduler(
    GIT_SYNC_JOB_ID,
    { every: GIT_SYNC_BASE_INTERVAL_MS + jitter },
    {
      name: BUNDLE_JOB_NAMES.GIT_SYNC_TICK,
      data: {} as unknown as BundleJobPayload,
      opts: { removeOnComplete: true, removeOnFail: 10 },
    },
  );
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
