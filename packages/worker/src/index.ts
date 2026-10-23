import { logger, configService, CONFIG_KEYS } from '@haive/shared';
import { bootstrap } from './bootstrap.js';
import { initBuildStamp } from './build-stamp.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { scheduleBundleGitSyncTick, startBundleWorker } from './queues/bundle-queue.js';
import {
  scheduleGlobalKbPurge,
  scheduleGlobalKbReconcile,
  startGlobalKbSyncWorker,
} from './queues/global-kb-sync-queue.js';
import { startRuntimeEnsureWorker } from './queues/runtime-ensure-queue.js';
import { startIdeEnsureWorker } from './queues/ide-ensure-queue.js';
import { startDdevControlWorker } from './queues/ddev-control-queue.js';
import { scheduleUsagePollTick, startUsagePollWorker } from './queues/usage-poll-queue.js';
import { closePrPollQueue, schedulePrPollTick, startPrPollWorker } from './queues/pr-poll-queue.js';
import {
  closeCliExecQueue,
  getCliExecQueue,
  scheduleCliVersionRefresh,
  startCliExecWorker,
} from './queues/cli-exec-queue.js';
import { cliExecJobRequeuedAtBoot, requeueOrphanedActiveJobs } from './queues/boot-requeue.js';
import { startRepoWorker } from './queues/repo-queue.js';
import {
  schedulePlanMirrorSweep,
  startPlanMirrorWorker,
  sweepDirtyPlanMirrors,
} from './queues/plan-mirror-queue.js';
import {
  backfillMissingRunSeq,
  closeTaskQueue,
  getTaskQueue,
  reconcileEmbedModelResidency,
  reconcileOrphanedSteps,
  startTaskWorker,
} from './queues/task-queue.js';
import { reconcileDeadTasks, retryHeldRevivals } from './queues/dead-task-boot.js';
import { defaultDeps, redriveStalledTasks, StalledTaskSweeper } from './queues/stalled-redrive.js';
import { closeRedis } from './redis.js';
import { reapAllCliSandboxes, SHUTDOWN_REAP_BUDGET_MS } from './sandbox/cli-container-reaper.js';
import { reapOrphanedAuthVolumes } from './sandbox/auth-volume-reaper.js';
import { reapOrphanEnvTemplates } from './sandbox/env-template-reaper.js';
import { reapStaleComposedImages } from './sandbox/composed-image-reaper.js';
import {
  reapOrphanedSandboxImages,
  reapSupersededSandboxCores,
} from './sandbox/sandbox-image-reaper.js';
import { ensureOllamaModels } from './sandbox/ollama-provision.js';
import { ensureDdevCa, ensureDdevRegistryCache } from './sandbox/ddev-runner.js';
import { ensureSandboxCoreImage } from './sandbox/sandbox-core-image.js';
import { TerminalSessionReaper } from './sandbox/terminal-session-reaper.js';
import { IdeSessionReaper } from './sandbox/ide-session-reaper.js';
import { RuntimeRunnerReaper } from './sandbox/runtime-runner-reaper.js';
import { startDatabaseSnapshotCleanup } from './repo/database-snapshots.js';
import { startUploadReaper } from './repo/upload-reaper.js';
import { AgentPreemptionSweeper } from './sandbox/agent-preemption.js';
import { CliPriorityDecaySweeper } from './queues/cli-exec/priority-decay.js';
import { clearAgentLeases } from './queues/cli-exec/agent-lease.js';
import { CliStreamLogReaper } from './queues/cli-exec/stream-log-retention.js';
import {
  startRuntimeLimitsWatch,
  setRuntimeReclaimer,
  clearBrowserSurcharges,
  clearRuntimeReservations,
} from './sandbox/runtime-admission.js';
import { TerminalSessionManager } from './terminal/terminal-session-manager.js';
import { bootStepEngine } from './step-engine/boot.js';
import { MODULE_JOBS_RECONCILE_MS, startModuleJobs } from './modules/loader.js';
import { guardShutdown } from './shutdown-guard.js';
import { startModuleControlWorker } from './queues/module-control-queue.js';
import { deactivatedModuleIds, moduleActivationState } from './modules/activation.js';
import { ModulePassScheduler } from './modules/pass-scheduler.js';
import { startModuleActivationWatch } from './modules/activation-watch.js';

async function main(): Promise<void> {
  const buildStamp = initBuildStamp();
  const { repoStoragePath, bundleStoragePath } = await bootstrap();
  const {
    loaded: loadedModules,
    entries: moduleEntries,
    deactivated: deactivatedAtBoot,
  } = await bootStepEngine(getDb());
  // Reap any cli sandbox containers left behind by a prior worker that died
  // mid-job (tsx watch restart, SIGKILL, OOM). BullMQ will redeliver the
  // job to this worker once its lock expires; we want a clean slate to
  // re-spawn fresh containers without name/state collisions.
  await reapAllCliSandboxes('worker boot').catch((err) => {
    logger.warn({ err }, 'cli sandbox reap on boot failed');
  });
  // Reap CLI auth volumes whose task ended or whose provider or user is gone, among them the
  // per-task copies a prior worker that died mid-teardown left behind.
  await reapOrphanedAuthVolumes(getDb()).catch((err) => {
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
  // Per-provider sandbox images no provider names: a removal that failed, or a release before
  // removal existed, left them for good. Docker refuses one a container still uses.
  await reapOrphanedSandboxImages(getDb()).catch((err) => {
    logger.warn({ err }, 'orphaned sandbox-image reap on boot failed');
  });
  // Base images a rebuild superseded (`ensureSandboxCoreImage` rebuilds an out-of-date base).
  await reapSupersededSandboxCores().catch((err) => {
    logger.warn({ err }, 'superseded sandbox-base reap on boot failed');
  });
  // Drop runtime slot reservations left by the previous process. The reap above removed every
  // runtime runner, so a reservation from before this boot can only describe a boot that no
  // longer exists — leaving it would hold a slot out of the pool until its 45-min expiry.
  await clearRuntimeReservations();
  await clearAgentLeases();
  // Same reasoning for the browser-desktop surcharges: every runner they described is gone.
  await clearBrowserSurcharges();
  // Before this process starts a worker, whose connection would read as the owner of every active job.
  await requeueOrphanedActiveJobs(getTaskQueue(), () => true);
  await requeueOrphanedActiveJobs(getCliExecQueue(), cliExecJobRequeuedAtBoot);
  // Before the reconcile, which skips a dead task: a revived task's orphaned run is ended there and nowhere else.
  const deadTasks = await reconcileDeadTasks(getDb()).catch((err) => {
    logger.warn({ err }, 'dead-task reconciliation on boot failed');
    return null;
  });
  // Recover steps a prior worker orphaned mid-step (their sandboxes were reaped
  // above): resume waiting_cli steps and re-drive running steps whose advance-step
  // job died mid-execution, so neither hangs after a restart/crash/power loss.
  // Before any worker starts: a queued cli-exec job picked up first would read as an orphan
  // here while it runs, and a queued advance could flip a step this pass then resets.
  await reconcileOrphanedSteps(getDb()).catch((err) => {
    logger.warn({ err }, 'orphaned-step reconciliation on boot failed');
  });
  // At boot the queue read already names every job that exists, so no staleness window is needed.
  await redriveStalledTasks(getDb(), defaultDeps, { staleMs: 0 }).catch((err) => {
    logger.warn({ err }, 'stalled-task redrive on boot failed');
  });

  await buildStamp;
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
  const planMirrorWorker = startPlanMirrorWorker();
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
  await sweepDirtyPlanMirrors().catch((err) => {
    logger.warn({ err }, 'plan mirror reconciliation on boot failed');
  });
  await schedulePlanMirrorSweep().catch((err) => {
    logger.warn({ err }, 'failed to schedule plan mirror sweep');
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
  await scheduleGlobalKbReconcile().catch((err) => {
    logger.warn({ err }, 'failed to schedule global KB lost-sync reconcile');
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
  // Build the CLI sandbox base image if this host does not have it. It is built locally
  // and published to no registry, so a `docker image prune` or a fresh checkout removes it
  // and EVERY cli-exec then dies trying to pull a repository that does not exist. Every
  // use site ensures it too; doing it here means a pruned host heals before the first task
  // rather than during it. Non-blocking for the same reason ensureDdevCa is — the build
  // takes minutes and must not gate queue startup; the ensure is single-flight, so the
  // first job to need the image joins this build instead of starting a second.
  void ensureSandboxCoreImage().catch((err) => {
    logger.warn({ err }, 'sandbox base image provisioning on boot failed');
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
  const stopDatabaseSnapshotCleanup = startDatabaseSnapshotCleanup(getDb());
  const stopUploadReaper = startUploadReaper(getDb());
  // Let the admission gate preempt a dead task's grace-runner for a waiting live task instead
  // of starving it behind the retry-cache (reuses the reaper's list/reap).
  // The waiter's vote score reaches the reaper here: it is what lets a boosted task reclaim a
  // lower-voted task's LIVE (but settled) environment, on top of the dead/orphan and paused tiers.
  setRuntimeReclaimer((waiterScore) => runtimeRunnerReaper.reclaimOnePreemptible(waiterScore));
  // Give an up-voted task a slot that is already occupied. BullMQ priority can only order the
  // QUEUE, so without this a boosted task still waits behind whatever was enqueued first; a
  // pickup gate cannot help either, since it only runs once a slot is free. Kills agent
  // containers only — environments are never torn down.
  const agentPreemptionSweeper = new AgentPreemptionSweeper({ db: getDb() });
  agentPreemptionSweeper.start();
  // Rebuild queued cli-exec priorities from live load. BullMQ freezes priority at queue.add, so
  // the `rank` term keeps whatever agent count the task had during its last fan-out — measured,
  // an idle +1 task sat behind a neutral task with two agents running, purely on enqueue order.
  const cliPriorityDecaySweeper = new CliPriorityDecaySweeper({ db: getDb() });
  cliPriorityDecaySweeper.start();
  // Periodic sibling of the boot-time redrive above.
  const stalledTaskSweeper = new StalledTaskSweeper({ db: getDb() });
  stalledTaskSweeper.start();
  // A revival the boot pass held back, failed or never reached goes on being tried until a pass holds none back and fails none.
  const stopDeadTaskRevival =
    !deadTasks || deadTasks.held > 0 || deadTasks.failed > 0
      ? retryHeldRevivals(getDb())
      : () => undefined;
  // Live-retune the runtime admission gate when the resource-limit config changes.
  const stopRuntimeLimitsWatch = startRuntimeLimitsWatch();
  // Age out persisted CLI transcripts. Nothing else deletes cli_invocations.stream_log,
  // so it only accrues; off unless an admin sets a retention window.
  const cliStreamLogReaper = new CliStreamLogReaper({ db: getDb() });
  cliStreamLogReaper.start();

  // Held back if deactivated at the schema read or now, or if its schema setup was still running; the first pass starts one active by then.
  const moduleJobs = await startModuleJobs(
    loadedModules,
    moduleEntries,
    new Set([...deactivatedAtBoot, ...(await deactivatedModuleIds(getDb()))]),
  );
  // After the module jobs: a teardown refuses a module whose jobs this worker started.
  const moduleControlWorker = startModuleControlWorker({
    loaded: loadedModules,
    entries: moduleEntries,
  });
  const reconcileModuleJobs = async (): Promise<void> => {
    try {
      const { deactivated, stamps } = await moduleActivationState(getDb());
      await moduleJobs.reconcile(deactivated, stamps);
    } catch (err) {
      logger.warn({ err }, 'module jobs reconcile skipped');
    }
  };
  const moduleJobsScheduler = new ModulePassScheduler({
    run: reconcileModuleJobs,
    intervalMs: MODULE_JOBS_RECONCILE_MS,
  });
  moduleJobsScheduler.start();
  const stopModuleActivationWatch = startModuleActivationWatch(() => moduleJobsScheduler.request());

  logger.info('haive-worker ready');

  const runShutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down');
    // Force-close BullMQ workers without waiting for in-flight jobs (CLI execs
    // can run for minutes; Docker SIGTERM grace is ~10s). Jobs left active are
    // handed back when the next worker boots, or once their lock expires; the
    // next worker pid reaps orphan containers on boot.
    terminalReaper.stop();
    ideReaper.stop();
    runtimeRunnerReaper.stop();
    stopDatabaseSnapshotCleanup();
    stopUploadReaper();
    agentPreemptionSweeper.stop();
    cliPriorityDecaySweeper.stop();
    stalledTaskSweeper.stop();
    stopDeadTaskRevival();
    cliStreamLogReaper.stop();
    stopRuntimeLimitsWatch();
    stopModuleActivationWatch();
    moduleJobsScheduler.stop();
    await Promise.all([
      moduleJobs.shutdown(moduleJobsScheduler.inFlight()),
      terminalManager.stop().catch((err) => {
        logger.warn({ err }, 'terminal manager stop failed');
      }),
    ]);
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
      planMirrorWorker.close(true),
      moduleControlWorker.close(true),
      closeTaskQueue(),
      closeCliExecQueue(),
      closePrPollQueue(),
    ]);
    await reapAllCliSandboxes(`worker ${signal}`, SHUTDOWN_REAP_BUDGET_MS).catch((err) => {
      logger.warn({ err }, 'cli sandbox reap on shutdown failed');
    });
    await closeRedis();
    process.exit(0);
  };
  const shutdown = guardShutdown(runShutdown, (code) => process.exit(code));

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
