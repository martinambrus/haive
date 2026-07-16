import { logger, configService, CONFIG_KEYS } from '@haive/shared';
import { bootstrap } from './bootstrap.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { scheduleBundleGitSyncTick, startBundleWorker } from './queues/bundle-queue.js';
import { scheduleGlobalKbPurge, startGlobalKbSyncWorker } from './queues/global-kb-sync-queue.js';
import { startRuntimeEnsureWorker } from './queues/runtime-ensure-queue.js';
import { startIdeEnsureWorker } from './queues/ide-ensure-queue.js';
import { startDdevControlWorker } from './queues/ddev-control-queue.js';
import { scheduleUsagePollTick, startUsagePollWorker } from './queues/usage-poll-queue.js';
import { closePrPollQueue, schedulePrPollTick, startPrPollWorker } from './queues/pr-poll-queue.js';
import {
  closeCliExecQueue,
  scheduleCliVersionRefresh,
  startCliExecWorker,
} from './queues/cli-exec-queue.js';
import { startRepoWorker } from './queues/repo-queue.js';
import {
  backfillMissingRunSeq,
  closeTaskQueue,
  reconcileEmbedModelResidency,
  reconcileOrphanedSteps,
  startTaskWorker,
} from './queues/task-queue.js';
import { closeRedis } from './redis.js';
import { reapAllCliSandboxes } from './sandbox/cli-container-reaper.js';
import { reapOrphanedTaskAuthVolumes } from './sandbox/auth-volume-reaper.js';
import { reapOrphanEnvTemplates } from './sandbox/env-template-reaper.js';
import { reapStaleComposedImages } from './sandbox/composed-image-reaper.js';
import { ensureOllamaModels } from './sandbox/ollama-provision.js';
import { ensureDdevCa, ensureDdevRegistryCache } from './sandbox/ddev-runner.js';
import { TerminalSessionReaper } from './sandbox/terminal-session-reaper.js';
import { IdeSessionReaper } from './sandbox/ide-session-reaper.js';
import { RuntimeRunnerReaper } from './sandbox/runtime-runner-reaper.js';
import { startRuntimeLimitsWatch } from './sandbox/runtime-admission.js';
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
  // Reap env templates that never reached 'ready' and have no live task — leftovers
  // from a task that ended before its image built (or a crash mid-build). The 'ready'
  // dockerfile-hash reuse cache is left intact (only repo-delete GCs that).
  await reapOrphanEnvTemplates(getDb()).catch((err) => {
    logger.warn({ err }, 'orphan env-template reap on boot failed');
  });
  // Evict stale composed sandbox images (haive-sandbox:<hash>) — hash-cached for
  // cross-task reuse but never previously reaped, so they leaked one per build.
  // Age-gated + skips images backing a running container; an evicted tag a live
  // task still needs just rebuilds on next use. Runs after the container reap
  // above so nothing composed is mid-use here.
  await reapStaleComposedImages().catch((err) => {
    logger.warn({ err }, 'stale composed-image reap on boot failed');
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
  // Serves the ddev-control MCP: runs ddev status/logs/restart inside the task's runner
  // when its AI CLI calls the tool (docker access is worker-only).
  const ddevControlWorker = startDdevControlWorker();
  // Gentle background poller: reads each logged-in provider's subscription
  // usage-window endpoint (~5 min) so the task header can show 5h/weekly meters.
  const usagePollWorker = startUsagePollWorker();
  // Watches every waiting_pr task's forge PR (~3 min); on merge auto-finalizes the
  // 13-pr-wait step (auto mode) or surfaces the state for a manual Finalize.
  const prPollWorker = startPrPollWorker();
  // Recover steps a prior worker orphaned mid-step (their sandboxes were reaped
  // above): resume waiting_cli steps and re-drive running steps whose advance-step
  // job died mid-execution, so neither hangs after a restart/crash/power loss.
  await reconcileOrphanedSteps(getDb()).catch((err) => {
    logger.warn({ err }, 'orphaned-step reconciliation on boot failed');
  });
  // Backfill run_seq (the run-order display key) on step rows created before it was
  // stamped, so already-in-flight task lists sort correctly without needing a re-advance.
  await backfillMissingRunSeq(getDb()).catch((err) => {
    logger.warn({ err }, 'run_seq backfill on boot failed');
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
  await scheduleUsagePollTick().catch((err) => {
    logger.warn({ err }, 'failed to schedule usage-window poll tick');
  });
  await schedulePrPollTick().catch((err) => {
    logger.warn({ err }, 'failed to schedule pull-request poll tick');
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
  // Pre-warm the shared DDEV registry pull-through cache so a repo's DDEV base images
  // are pulled from Docker Hub once and served locally to every later task (the
  // per-task runner's nested image store is dropped at teardown). Flag-gated +
  // non-blocking; a DDEV task racing a cold boot just pulls direct that one run.
  void (async () => {
    if (await configService.getBoolean(CONFIG_KEYS.DDEV_REGISTRY_CACHE_ENABLED, true)) {
      await ensureDdevRegistryCache();
    }
  })().catch((err) => {
    logger.warn({ err }, 'ddev registry cache provisioning on boot failed');
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
  // Reclaim leaked DDEV/app runtime runners: a failed task keeps its runner for retry
  // and the boot reaper preserves runners, so an abandoned/crashed one otherwise lives
  // forever. Keys on task status + container age; never touches a live task's runner.
  const runtimeRunnerReaper = new RuntimeRunnerReaper({ db: getDb() });
  runtimeRunnerReaper.start();
  // Live-retune the runtime admission gate when the resource-limit config changes.
  const stopRuntimeLimitsWatch = startRuntimeLimitsWatch();

  logger.info('haive-worker ready');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down');
    // Force-close BullMQ workers without waiting for in-flight jobs (CLI execs
    // can run for minutes; Docker SIGTERM grace is ~10s). Jobs released back
    // to the queue will be redelivered once the lock expires; the next
    // worker pid reaps orphan containers on boot.
    terminalReaper.stop();
    ideReaper.stop();
    runtimeRunnerReaper.stop();
    stopRuntimeLimitsWatch();
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
      ddevControlWorker.close(true),
      usagePollWorker.close(true),
      prPollWorker.close(true),
      closeTaskQueue(),
      closeCliExecQueue(),
      closePrPollQueue(),
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

// A stray fire-and-forget rejection (e.g. a void'd cosmetic progress heartbeat losing
// its postgres lookup on a transient DNS blip) must NOT kill the worker: in dev it runs
// under `tsx watch`, which does not restart on a crash, so one unhandled rejection
// freezes every task until a source edit. Log it and keep the queues running; real bugs
// still surface loudly.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection (worker kept alive)');
});

main().catch((err) => {
  logger.error({ err }, 'worker bootstrap failed');
  process.exit(1);
});
