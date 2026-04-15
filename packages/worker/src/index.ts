import { logger } from '@haive/shared';
import { bootstrap } from './bootstrap.js';
import {
  closeCliExecQueue,
  scheduleCliVersionRefresh,
  startCliExecWorker,
} from './queues/cli-exec-queue.js';
import { startRepoWorker } from './queues/repo-queue.js';
import { closeTaskQueue, startTaskWorker } from './queues/task-queue.js';
import { closeRedis } from './redis.js';

async function main(): Promise<void> {
  const { repoStoragePath } = await bootstrap();

  const repoWorker = startRepoWorker(repoStoragePath);
  const taskWorker = startTaskWorker();
  const cliExecWorker = startCliExecWorker();
  await scheduleCliVersionRefresh().catch((err) => {
    logger.warn({ err }, 'failed to schedule cli version refresh');
  });
  logger.info('haive-worker ready');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down');
    await Promise.allSettled([
      repoWorker.close(),
      taskWorker.close(),
      cliExecWorker.close(),
      closeTaskQueue(),
      closeCliExecQueue(),
    ]);
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker bootstrap failed');
  process.exit(1);
});
