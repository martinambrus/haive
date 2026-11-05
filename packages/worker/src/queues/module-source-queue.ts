import { Queue, Worker } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  MODULE_SOURCE_JOB_NAMES,
  QUEUE_NAMES,
  logger,
  type ModuleSourcePayload,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { recoverModuleSourceFetches, runModuleSourceFetch } from '../modules/source-jobs.js';
import { safeProcessor } from './safe-processor.js';

const log = logger.child({ module: 'module-source' });

export function startModuleSourceWorker(): Worker<ModuleSourcePayload, void> {
  const worker = new Worker<ModuleSourcePayload, void>(
    QUEUE_NAMES.MODULE_SOURCE,
    safeProcessor(async (job) => {
      if (job.name !== MODULE_SOURCE_JOB_NAMES.FETCH)
        throw new Error(`Unknown module-source job: ${job.name}`);
      const { sourceId, requestedAt } = job.data;
      if (
        typeof sourceId !== 'string' ||
        typeof requestedAt !== 'string' ||
        !Number.isFinite(Date.parse(requestedAt))
      )
        throw new Error('Missing module source request identity');
      await runModuleSourceFetch(getDb(), sourceId, requestedAt);
    }),
    { connection: getBullRedis(), concurrency: 1, maxStalledCount: 0 },
  );
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, moduleId: job?.data?.moduleId, err }, 'module-source job failed');
    const { sourceId, requestedAt } = job?.data ?? {};
    if (
      typeof sourceId !== 'string' ||
      typeof requestedAt !== 'string' ||
      !Number.isFinite(Date.parse(requestedAt))
    )
      return;
    void getDb()
      .update(schema.moduleSources)
      .set({ fetchStatus: 'failed', lastError: 'Module fetch job ended; retry Fetch.' })
      .where(
        and(
          eq(schema.moduleSources.id, sourceId),
          inArray(schema.moduleSources.fetchStatus, ['queued', 'fetching']),
          eq(schema.moduleSources.updatedAt, new Date(requestedAt)),
        ),
      )
      .catch((error) => log.error({ err: error }, 'Could not record module fetch failure'));
  });
  if (process.env.HAIVE_PUBLISHED_INSTALL === 'true') {
    const queue = new Queue(QUEUE_NAMES.MODULE_SOURCE, { connection: getBullRedis() });
    let running = false;
    const recover = async () => {
      if (running) return;
      running = true;
      try {
        await recoverModuleSourceFetches(getDb(), queue);
      } catch (error) {
        log.warn({ err: error }, 'Could not recover module source fetches');
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void recover(), 10_000);
    timer.unref();
    worker.on('ready', () => void recover());
    worker.on('closed', () => {
      clearInterval(timer);
      void queue.close();
    });
  }
  return worker;
}
