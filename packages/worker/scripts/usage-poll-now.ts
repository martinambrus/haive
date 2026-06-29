/** Enqueue a one-off usage-poll tick for manual verification (the worker processor
 *  runs runUsagePollTick for any job on the queue, fetching every connected provider).
 *  Run: docker exec haive-worker pnpm --filter @haive/worker exec tsx scripts/usage-poll-now.ts */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES } from '@haive/shared';

async function main(): Promise<void> {
  const connection = new IORedis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    maxRetriesPerRequest: null,
  });
  const q = new Queue(QUEUE_NAMES.USAGE_POLL, { connection });
  const job = await q.add('manual-poll', {}, { removeOnComplete: true });
  console.log('enqueued usage-poll job', job.id);
  await q.close();
  await connection.quit();
  process.exit(0);
}

void main();
