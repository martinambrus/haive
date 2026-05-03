import { logger } from '@haive/shared';
import { bootstrap } from './bootstrap.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { scheduleBundleGitSyncTick, startBundleWorker } from './queues/bundle-queue.js';
import {
  closeCliExecQueue,
  scheduleCliVersionRefresh,
  startCliExecWorker,
} from './queues/cli-exec-queue.js';
import { startRepoWorker } from './queues/repo-queue.js';
import { closeTaskQueue, startTaskWorker } from './queues/task-queue.js';
import { closeRedis } from './redis.js';
import { reapAllCliSandboxes } from './sandbox/cli-container-reaper.js';
import { TerminalSessionReaper } from './sandbox/terminal-session-reaper.js';
import { TerminalSessionManager } from './terminal/terminal-session-manager.js';

async function main(): Promise<void> {
  const { repoStoragePath, bundleStoragePath } = await bootstrap();
  // Reap any cli sandbox containers left behind by a prior worker that died
  // mid-job (tsx watch restart, SIGKILL, OOM). BullMQ will redeliver the
  // job to this worker once its lock expires; we want a clean slate to
  // re-spawn fresh containers without name/state collisions.
  await reapAllCliSandboxes('worker boot').catch((err) => {
    logger.warn({ err }, 'cli sandbox reap on boot failed');
  });

  const repoWorker = startRepoWorker(repoStoragePath);
  const bundleWorker = startBundleWorker(bundleStoragePath);
  const taskWorker = startTaskWorker();
  const cliExecWorker = startCliExecWorker();
  await scheduleCliVersionRefresh().catch((err) => {
    logger.warn({ err }, 'failed to schedule cli version refresh');
  });
  await scheduleBundleGitSyncTick().catch((err) => {
    logger.warn({ err }, 'failed to schedule bundle git-sync tick');
  });

  // Terminal subsystem: session manager subscribes to terminal:request and
  // owns per-WS PTY exec. Reaper sweeps every 30s for refcount==0 entries
  // older than the grace window. Both are no-ops until an open arrives.
  const terminalManager = new TerminalSessionManager({ db: getDb(), redis: getRedis() });
  await terminalManager.start();
  const terminalReaper = new TerminalSessionReaper({ redis: getRedis() });
  terminalReaper.start();

  logger.info('haive-worker ready');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down');
    // Force-close BullMQ workers without waiting for in-flight jobs (CLI execs
    // can run for minutes; Docker SIGTERM grace is ~10s). Jobs released back
    // to the queue will be redelivered once the lock expires; the next
    // worker pid reaps orphan containers on boot.
    terminalReaper.stop();
    await terminalManager.stop().catch((err) => {
      logger.warn({ err }, 'terminal manager stop failed');
    });
    await Promise.allSettled([
      repoWorker.close(true),
      bundleWorker.close(true),
      taskWorker.close(true),
      cliExecWorker.close(true),
      closeTaskQueue(),
      closeCliExecQueue(),
    ]);
    await reapAllCliSandboxes(`worker ${signal}`).catch((err) => {
      logger.warn({ err }, 'cli sandbox reap on shutdown failed');
    });
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
