import { logger } from '@haive/shared';
import { bootstrap } from './bootstrap.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { scheduleBundleGitSyncTick, startBundleWorker } from './queues/bundle-queue.js';
import { scheduleGlobalKbPurge, startGlobalKbSyncWorker } from './queues/global-kb-sync-queue.js';
import { startRuntimeEnsureWorker } from './queues/runtime-ensure-queue.js';
import { startIdeEnsureWorker } from './queues/ide-ensure-queue.js';
import {
  closeCliExecQueue,
  scheduleCliVersionRefresh,
  startCliExecWorker,
} from './queues/cli-exec-queue.js';
import { startRepoWorker } from './queues/repo-queue.js';
import {
  closeTaskQueue,
  reconcileEmbedModelResidency,
  reconcileOrphanedCliSteps,
  startTaskWorker,
} from './queues/task-queue.js';
import { closeRedis } from './redis.js';
import { reapAllCliSandboxes } from './sandbox/cli-container-reaper.js';
import { reapOrphanedTaskAuthVolumes } from './sandbox/auth-volume-reaper.js';
import { ensureOllamaModels } from './sandbox/ollama-provision.js';
import { ensureDdevCa } from './sandbox/ddev-runner.js';
import { TerminalSessionReaper } from './sandbox/terminal-session-reaper.js';
import { IdeSessionReaper } from './sandbox/ide-session-reaper.js';
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
  // Reap per-task CLI auth volumes orphaned by a prior worker that died mid-teardown
  // (the leak cleanupTaskContainers can't recover after the fact). Keeps live tasks'
  // volumes + all per-user/per-provider auth volumes.
  await reapOrphanedTaskAuthVolumes(getDb()).catch((err) => {
    logger.warn({ err }, 'orphan auth-volume reap on boot failed');
  });

  const repoWorker = startRepoWorker(repoStoragePath);
  const bundleWorker = startBundleWorker(bundleStoragePath);
  const taskWorker = startTaskWorker();
  const cliExecWorker = await startCliExecWorker();
  const globalKbSyncWorker = startGlobalKbSyncWorker();
  // Serves the api's VNC "ensure runtime" requests: brings the task's app +
  // headed-browser desktop back up on demand (e.g. after a worker-boot reap).
  const runtimeEnsureWorker = startRuntimeEnsureWorker();
  // Serves the api's Editor-tab "ensure IDE" requests: lazily launches the task's
  // code-server container when the user opens the editor.
  const ideEnsureWorker = startIdeEnsureWorker();
  // Recover steps a prior worker orphaned mid-CLI (their sandboxes were reaped
  // above): fail or resume them so they never hang in waiting_cli after a restart.
  await reconcileOrphanedCliSteps(getDb()).catch((err) => {
    logger.warn({ err }, 'orphaned-cli-step reconciliation on boot failed');
  });
  // Recover embed-model unloads a prior worker missed (died mid terminal-transition
  // before sending keep_alive:0): evict any resident RAG model no live task needs.
  await reconcileEmbedModelResidency(getDb()).catch((err) => {
    logger.warn({ err }, 'embed-model residency reconciliation on boot failed');
  });
  await scheduleCliVersionRefresh().catch((err) => {
    logger.warn({ err }, 'failed to schedule cli version refresh');
  });
  await scheduleBundleGitSyncTick().catch((err) => {
    logger.warn({ err }, 'failed to schedule bundle git-sync tick');
  });
  await scheduleGlobalKbPurge().catch((err) => {
    logger.warn({ err }, 'failed to schedule global KB archive purge');
  });
  // Pre-pull declared local Ollama models so a fresh stack is usable without a
  // manual pull. Non-blocking: boot completes while large pulls run in the
  // background; per-model failures are logged, not fatal.
  void ensureOllamaModels(getDb()).catch((err) => {
    logger.warn({ err }, 'ollama model provisioning on boot failed');
  });
  // Generate the shared DDEV mkcert CA once (into its named volume) so direct
  // browser access can serve a trusted https://<name>.ddev.site. Non-blocking: a
  // DDEV task racing a fresh boot falls back to a throwaway CA for that one run.
  void ensureDdevCa().catch((err) => {
    logger.warn({ err }, 'shared DDEV CA generation on boot failed');
  });

  // Terminal subsystem: session manager subscribes to terminal:request and
  // owns per-WS PTY exec. Reaper sweeps every 30s for refcount==0 entries
  // older than the grace window. Both are no-ops until an open arrives.
  const terminalManager = new TerminalSessionManager({ db: getDb(), redis: getRedis() });
  await terminalManager.start();
  const terminalReaper = new TerminalSessionReaper({ redis: getRedis() });
  terminalReaper.start();
  // Lazy IDE: idle reaper grace-stops a code-server container 30 min after its
  // editor tab closes (refcount==0 + lastSeenAt stale). No-op until an open arrives.
  const ideReaper = new IdeSessionReaper({ redis: getRedis() });
  ideReaper.start();

  logger.info('haive-worker ready');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down');
    // Force-close BullMQ workers without waiting for in-flight jobs (CLI execs
    // can run for minutes; Docker SIGTERM grace is ~10s). Jobs released back
    // to the queue will be redelivered once the lock expires; the next
    // worker pid reaps orphan containers on boot.
    terminalReaper.stop();
    ideReaper.stop();
    await terminalManager.stop().catch((err) => {
      logger.warn({ err }, 'terminal manager stop failed');
    });
    await Promise.allSettled([
      repoWorker.close(true),
      bundleWorker.close(true),
      taskWorker.close(true),
      cliExecWorker.close(true),
      globalKbSyncWorker.close(true),
      runtimeEnsureWorker.close(true),
      ideEnsureWorker.close(true),
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
