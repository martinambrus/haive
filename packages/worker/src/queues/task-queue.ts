import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import Docker from 'dockerode';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  CONFIG_KEYS,
  configService,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  ideSessionKey,
  logger,
  type CliExecJobPayload,
  type RepoRagCleanupPayload,
  type RepoResourceCleanupPayload,
  type ExecutionPath,
  type TaskJobPayload,
  type WorkflowType,
} from '@haive/shared';
import {
  listResidentOllamaModels,
  releaseEmbedModelIfUnused,
  resolveTaskEmbedTarget,
} from '@haive/shared/rag';
import { resolveGlobalKbSettings } from '@haive/shared/global-kb';
import type { CliProviderRecord } from '../cli-adapters/types.js';
import { getDb } from '../db.js';
import { getBullRedis, getRedis } from '../redis.js';
import { reapAllSessionsForTask } from '../sandbox/terminal-session-reaper.js';
import {
  advanceStep,
  computeGlobalStepIndex,
  stepRegistry,
  registerAllSteps,
  type AdvanceStepResult,
  type WorkerDeps,
} from '../step-engine/index.js';
import type { StepDefinition } from '../step-engine/step-definition.js';
import { orderWorkflowRunList } from '../orchestrator/execution-paths.js';
import { ContainerManager } from '../sandbox/container-manager.js';
import { defaultDockerRunner } from '../sandbox/docker-runner.js';
import { cleanupTaskAuthVolumes } from '../sandbox/task-auth-volume.js';
import { killTaskDdevRunners } from '../sandbox/ddev-runner.js';
import { killTaskAppRunners } from '../sandbox/app-runner.js';
import { killTaskIdeContainers } from '../sandbox/ide-runner.js';
import { removeTaskWorktree } from '../repo/worktree-remove.js';
import { getTaskEnvTemplate } from '../step-engine/steps/env-replicate/_shared.js';
import { cleanupRagForRepository } from '../step-engine/steps/onboarding/_rag-connection.js';
import { fatalClassFromMessage } from './cli-exec/failure-class.js';
import { enqueueUsagePollTick } from './usage-poll-queue.js';
import { USAGE_PROVIDERS } from '../usage-window/fetchers/index.js';
import { constrainingResetAt } from '../usage-window/allowance-watch.js';
import { reconcileKbAuthorEntryOnTaskEnd } from '../step-engine/steps/_global-kb-promote.js';
import {
  recordFixLoopRequest,
  recordFixLoopAccepted,
  buildFixLoopEscalationSchema,
  buildOscillationEscalationSchema,
  detectFixLoopOscillation,
  FIX_LOOP_ACTION_FIELD,
  FIX_LOOP_TARGET_STEP_ID,
  DEFAULT_MAX_FIX_ROUNDS,
} from '../step-engine/steps/workflow/_fix-loop.js';
import { getCliExecQueue } from './cli-exec-queue.js';
import { resetStepAndDownstream } from './_step-reset.js';
import { markCliParkBegin } from './cli-park-timing.js';
import { unloadTaskOllamaCliModels } from '../sandbox/ollama-provision.js';

let registered = false;
let taskQueueInstance: Queue<TaskJobPayload> | null = null;

function ensureRegistered(): void {
  if (registered) return;
  registerAllSteps(stepRegistry);
  registered = true;
}

export function getTaskQueue(): Queue<TaskJobPayload> {
  if (!taskQueueInstance) {
    taskQueueInstance = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, {
      connection: getBullRedis(),
    });
  }
  return taskQueueInstance;
}

export async function closeTaskQueue(): Promise<void> {
  if (taskQueueInstance) {
    await taskQueueInstance.close();
    taskQueueInstance = null;
  }
}

interface ResolvedTaskContext {
  taskId: string;
  userId: string;
  workflowType: WorkflowType;
  repoPath: string;
  workspacePath: string;
  cliProviderId: string | null;
  ignoreSavedStepClis: boolean;
  /** Execution path recorded by 00-triage; null pre-triage and on legacy rows. */
  executionPath: ExecutionPath | null;
  metadata: Record<string, unknown> | null;
  /** Current orchestration generation; advance-step jobs from an older epoch are
   *  skipped as stale (see handleAdvanceStep). */
  orchestrationEpoch: number;
}

async function buildRunList(ctx: ResolvedTaskContext, db: Database): Promise<StepDefinition[]> {
  // run_app assembles its own mode-aware list from steps reused BY ID (there is no
  // full registered list for the type — only the 99-run-app-ready gate is native).
  if (ctx.workflowType === 'run_app') return buildRunAppRunList(ctx, db);
  const main = stepRegistry.listByWorkflow(ctx.workflowType);
  // Only implementation-workflow tasks branch by execution path; onboarding,
  // onboarding_upgrade, kb_author, etc. run their full registered list unchanged.
  if (ctx.workflowType !== 'workflow') return main;
  const prelude = stepRegistry.listByWorkflow('env_replicate');
  // The model-health canary runs first (a dead model fails loudly before any path is
  // chosen — the path is moot when no model can run it), then 00-triage, both ahead of
  // the env-replicate prelude so the path is chosen up front; execution_path (null
  // pre-triage / on legacy rows) then trims the workflow steps to the chosen path. The
  // ordering + filtering is a pure helper in orchestrator/execution-paths.ts so it can
  // be unit-tested. Safe with the forward walk because every path set contains the
  // canary + triage + the spine, so the just-finished step is always present in the
  // filtered list.
  return orderWorkflowRunList(main, prelude, ctx.executionPath);
}

/** Assemble a run_app task's run list. The env + runtime steps are reused BY ID
 *  from the workflow / env-replicate sets; the runtime tail is chosen from the
 *  container tool 01-declare-deps persisted into the env template. Before declare-
 *  deps has run the tool is unknown, so the tail is empty and is filled in on the
 *  next rebuild (handleResult rebuilds the list after every step). The prefix
 *  [declare-deps, worktree-setup, debug-mode] is stable and 99-run-app-ready is
 *  always last, so the forward walk (findIndex(stepId)+1) stays correct as the tail
 *  grows. 01-debug-mode precedes the runtime (it self-skips when the global debug
 *  kill-switch is off) so a run_app session — the prime "run it and poke at it"
 *  surface — can opt into step-debugging before DDEV / the app-runner comes up.
 *  98-choose-view ALSO precedes the runtime (not just 99-run-app-ready): the
 *  VNC-vs-own-browser choice writes tasks.direct_access, which the runner reads at
 *  CREATE to decide host-port publishing (fixed at cold boot, never reconfigured) —
 *  mirrors 01d-browser-access in the workflow pipeline. */
async function buildRunAppRunList(
  ctx: ResolvedTaskContext,
  db: Database,
): Promise<StepDefinition[]> {
  const prefix = [
    stepRegistry.require('01-declare-deps'),
    stepRegistry.require('01-worktree-setup'),
    stepRegistry.require('01-debug-mode'),
  ];
  const chooseView = stepRegistry.require('98-choose-view');
  const ready = stepRegistry.require('99-run-app-ready');

  const envTemplate = await getTaskEnvTemplate(db, ctx.taskId);
  const containerTool = (envTemplate?.declaredDeps as { containerTool?: string } | null | undefined)
    ?.containerTool;

  let runtime: StepDefinition[] = [];
  if (containerTool === 'ddev') {
    // 01c brings DDEV up + imports the uploaded dump; 06a then runs the framework
    // DB migrations (drush updatedb / artisan migrate / …) so an imported DB matches
    // the code before browsing. 06a self-gates on .ddev/config.yaml and is skippable.
    runtime = [stepRegistry.require('01c-ddev-env'), stepRegistry.require('06a-db-migrate')];
  } else if (containerTool) {
    // Non-DDEV (none / docker / docker-compose): build the env image, then boot the
    // app in the app-runner (01a-app-boot's optional LLM infers the run command).
    runtime = [
      stepRegistry.require('02-generate-dockerfile'),
      stepRegistry.require('03-build-image'),
      stepRegistry.require('01a-app-boot'),
    ];
  }
  return [...prefix, chooseView, ...runtime, ready];
}

async function resolveTaskContext(
  db: Database,
  taskId: string,
): Promise<ResolvedTaskContext | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
  });
  if (!task) return null;

  let repoPath: string | null = null;
  if (task.repositoryId) {
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { storagePath: true, localPath: true },
    });
    repoPath = repo?.storagePath ?? repo?.localPath ?? null;
  }
  if (!repoPath) {
    throw new Error(`task ${taskId} has no resolvable repo path`);
  }

  return {
    taskId: task.id,
    userId: task.userId,
    workflowType: task.type as WorkflowType,
    repoPath,
    workspacePath: repoPath,
    cliProviderId: task.cliProviderId,
    ignoreSavedStepClis: task.ignoreSavedStepClis,
    executionPath: (task.executionPath as ExecutionPath | null) ?? null,
    metadata: task.metadata ?? null,
    orchestrationEpoch: task.orchestrationEpoch ?? 0,
  };
}

async function appendEvent(
  db: Database,
  taskId: string,
  taskStepId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId,
    eventType,
    payload,
  });
}

async function markTaskRunning(db: Database, taskId: string): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.tasks.id, taskId));
}

/** current_step_index mirrors the current step's run_seq (buildRunList position — the
 *  run-monotonic order key), NOT step_index (a static per-workflow-type offset that is
 *  not run-monotonic once step families interleave, e.g. an env-replicate prelude spliced
 *  into a workflow). Reads run_seq from the step row; falls back to the caller's static
 *  index only when the row is not yet materialized (advancing to a not-yet-run next step,
 *  whose run_seq is stamped a moment later when it parks — the label is read while parked). */
async function resolveCurrentStepIndex(
  db: Database,
  taskId: string,
  stepId: string,
  round: number,
  fallbackIndex: number,
): Promise<number> {
  const rows = await db
    .select({ runSeq: schema.taskSteps.runSeq })
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, stepId),
        eq(schema.taskSteps.round, round),
      ),
    )
    .limit(1);
  return rows[0]?.runSeq ?? fallbackIndex;
}

async function markTaskWaiting(
  db: Database,
  taskId: string,
  stepId: string,
  stepIndex: number,
  round = 0,
): Promise<void> {
  const currentStepIndex = await resolveCurrentStepIndex(db, taskId, stepId, round, stepIndex);
  await db
    .update(schema.tasks)
    .set({
      status: 'waiting_user',
      currentStepId: stepId,
      currentStepIndex,
      currentRound: round,
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.id, taskId));
}

async function markTaskRunningWithStep(
  db: Database,
  taskId: string,
  stepId: string,
  stepIndex: number,
  round = 0,
): Promise<void> {
  const currentStepIndex = await resolveCurrentStepIndex(db, taskId, stepId, round, stepIndex);
  await db
    .update(schema.tasks)
    .set({
      status: 'running',
      currentStepId: stepId,
      currentStepIndex,
      currentRound: round,
      // Clear any stale terminal fields. A worker restart mid-run fails the
      // orphaned step (markTaskFailed), which stamps completedAt + errorMessage
      // and status=failed; the auto-resume then re-enters here to flip back to
      // running. Left unset, the stale completedAt freezes the UI wall clock at
      // failure-minus-start (and kills the live tick, since ticking keys on
      // !completedAt), and the stale errorMessage leaks onto the running task.
      completedAt: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.id, taskId));
}

async function markTaskCompleted(db: Database, taskId: string): Promise<void> {
  await db
    .update(schema.tasks)
    .set({
      status: 'completed',
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.id, taskId));
  await cleanupTaskContainers(db, taskId, 'completed');
  await maybeUnloadTaskEmbedModel(db, taskId);
  await unloadTaskOllamaCliModels(db, taskId);
}

async function markTaskFailed(db: Database, taskId: string, message: string): Promise<void> {
  await db
    .update(schema.tasks)
    .set({
      status: 'failed',
      errorMessage: message,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.id, taskId));
  await cleanupTaskContainers(db, taskId, 'failed');
  await maybeUnloadTaskEmbedModel(db, taskId);
  await unloadTaskOllamaCliModels(db, taskId);
  // A failed kb_author enrich leaves its global KB entry stuck in 'enriching'; mark
  // it 'failed' so the KB view can show a retry / go-to-task affordance.
  await reconcileKbAuthorEntryOnTaskEnd(db, taskId, 'failed', logger);
}

/** After a task reaches a terminal state, evict its RAG embedding model from
 *  Ollama so the GPU is freed — but only when it is still resident AND no other
 *  live task uses the SAME (url, model). The resolve + residency + live-task gate
 *  lives in @haive/shared/rag (shared with the worker-boot reconciler and the API
 *  release endpoint, so all three stay in lockstep on "safe to evict"). Best-effort
 *  and self-contained: never throws, so it cannot break the terminal transition.
 *  Repo-RAG only; the global-KB model has its own lifecycle and keep_alive
 *  backstop. */
async function maybeUnloadTaskEmbedModel(db: Database, taskId: string): Promise<void> {
  try {
    const target = await resolveTaskEmbedTarget(db, taskId);
    if (!target) return;
    const status = await releaseEmbedModelIfUnused(db, {
      url: target.url,
      model: target.model,
      excludeTaskId: taskId,
    });
    logger.info({ taskId, model: target.model, status }, 'ollama embed model release');
  } catch (err) {
    logger.warn({ err, taskId }, 'ollama embed model unload failed');
  }
}

/** Worker-boot recovery for the embed-model unload. A cancel/complete/fail can die
 *  mid-transition (worker crash, redeploy, tsx-watch restart) AFTER marking the
 *  task terminal but BEFORE `maybeUnloadTaskEmbedModel` runs, leaving the model
 *  pinned on its last keep_alive (the bug that motivated this). On boot, reconcile
 *  residency to intent: for every Ollama endpoint Haive knows (global-KB settings +
 *  the distinct repo-RAG 04-tooling targets), evict each resident embed model that
 *  no live task needs. The global-KB model is kept while a global-KB sync is in
 *  flight. Idempotent + best-effort; never throws, so it cannot block boot. */
export async function reconcileEmbedModelResidency(db: Database): Promise<void> {
  try {
    const settings = await resolveGlobalKbSettings();
    const globalKbUrl = settings.enabled ? settings.ollamaUrl : null;
    const globalKbModel = settings.enabled ? settings.embedModel : null;

    // Distinct repo-RAG (url, model) targets ever configured — realistically one.
    const rows = (await db.execute(sql`
      SELECT DISTINCT
        output->'tooling'->>'ollamaUrl' AS url,
        output->'tooling'->>'embeddingModel' AS model
      FROM task_steps
      WHERE step_id = '04-tooling-infrastructure'
        AND output->'tooling'->>'ollamaUrl' IS NOT NULL
        AND output->'tooling'->>'embeddingModel' IS NOT NULL
    `)) as unknown as Array<{ url: string; model: string }>;

    const byUrl = new Map<string, Set<string>>();
    const add = (url: string | null, model: string | null): void => {
      if (!url || !model) return;
      if (!byUrl.has(url)) byUrl.set(url, new Set());
      byUrl.get(url)!.add(model);
    };
    for (const r of rows) add(r.url, r.model);
    add(globalKbUrl, globalKbModel);
    if (byUrl.size === 0) return;

    // An in-flight global-KB sync legitimately keeps the global-KB model resident.
    const kbQueue = new Queue(QUEUE_NAMES.GLOBAL_KB_SYNC, { connection: getBullRedis() });
    let kbSyncActive = 0;
    try {
      kbSyncActive = (await kbQueue.getActiveCount()) + (await kbQueue.getWaitingCount());
    } finally {
      await kbQueue.close().catch(() => {});
    }

    let unloaded = 0;
    for (const [url, models] of byUrl) {
      const resident = await listResidentOllamaModels(url);
      if (!resident) continue; // unreachable, or nothing loaded
      for (const model of models) {
        if (!resident.includes(model)) continue;
        const alsoInUse = kbSyncActive > 0 && url === globalKbUrl && model === globalKbModel;
        const status = await releaseEmbedModelIfUnused(db, { url, model, alsoInUse });
        if (status === 'unloaded') unloaded += 1;
      }
    }
    logger.info(
      { endpoints: byUrl.size, kbSyncActive, unloaded },
      'embed-model residency reconciled on boot',
    );
  } catch (err) {
    logger.warn({ err }, 'embed-model residency reconciliation on boot failed');
  }
}

export type ContainerCleanupRunner = (db: Database, taskId: string) => Promise<number>;

let containerCleanupRunner: ContainerCleanupRunner | null = null;

export function setContainerCleanupRunner(runner: ContainerCleanupRunner | null): void {
  containerCleanupRunner = runner;
}

async function cleanupTaskContainers(
  db: Database,
  taskId: string,
  reason: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  if (reason === 'cancelled') {
    try {
      const killed = await killSandboxContainersByTaskLabel(taskId);
      if (killed > 0) {
        await appendEvent(db, taskId, null, 'sandbox_containers.killed', { reason, count: killed });
      }
    } catch (err) {
      logger.warn({ err, taskId, reason }, 'kill-sandbox-containers failed');
    }
  }

  try {
    let destroyed = 0;
    if (containerCleanupRunner) {
      destroyed = await containerCleanupRunner(db, taskId);
    } else {
      destroyed = await defaultContainerCleanup(db, taskId);
    }
    if (destroyed > 0) {
      await appendEvent(db, taskId, null, 'containers.destroyed', {
        reason,
        count: destroyed,
      });
    }
  } catch (err) {
    logger.warn({ err, taskId, reason }, 'cleanup-task-containers failed');
  }

  // Per-task DDEV nested-Docker runners. Keep them alive on 'failed' so recovery
  // (retry / retry-with-AI / skip) can act on the SAME env + already-imported DB;
  // tear down only on a definitive end (completed / cancelled, incl. abort which
  // cancels). `-v` drops the runner's anon /var/lib/docker volume too.
  if (reason !== 'failed') {
    try {
      const killed = await killTaskDdevRunners(taskId);
      if (killed > 0) {
        await appendEvent(db, taskId, null, 'ddev_runners.destroyed', { reason, count: killed });
      }
    } catch (err) {
      logger.warn({ err, taskId, reason }, 'cleanup-ddev-runners failed');
    }
    // Per-task app-runners (non-DDEV runtime). Same keep-alive-on-'failed'
    // semantics as the DDEV runner so recovery can reuse the running app.
    try {
      const killedApps = await killTaskAppRunners(taskId);
      if (killedApps > 0) {
        await appendEvent(db, taskId, null, 'app_runners.destroyed', { reason, count: killedApps });
      }
    } catch (err) {
      logger.warn({ err, taskId, reason }, 'cleanup-app-runners failed');
    }
    // Per-task browser IDE (code-server). Keep on 'failed' like the runtimes so the
    // user can still inspect/edit after a failure; tear down (container + per-task
    // user-data volume) and drop the session entry on a definitive end.
    try {
      const killedIde = await killTaskIdeContainers(taskId);
      await getRedis()
        .del(ideSessionKey(taskId))
        .catch(() => undefined);
      if (killedIde > 0) {
        await appendEvent(db, taskId, null, 'ide_containers.destroyed', {
          reason,
          count: killedIde,
        });
      }
    } catch (err) {
      logger.warn({ err, taskId, reason }, 'cleanup-ide-containers failed');
    }
  }

  try {
    const { removed, failed } = await cleanupTaskAuthVolumes(taskId);
    if (removed.length > 0 || failed.length > 0) {
      await appendEvent(db, taskId, null, 'auth_volumes.destroyed', {
        reason,
        removed: removed.length,
        failed: failed.length,
      });
    }
  } catch (err) {
    logger.warn({ err, taskId, reason }, 'cleanup-task-auth-volumes failed');
  }

  // Remove the feature worktree. On cancel: always (a task cancelled before its
  // worktree-cleanup step would leak the dir into the haive_repos volume). On
  // completion: only for task types with NO worktree-cleanup step of their own —
  // A few completion-time cleanups depend on the task type — fetch it once.
  let completedType: string | null = null;
  if (reason === 'completed') {
    const t = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { type: true },
    });
    completedType = t?.type ?? null;
  }

  // run_app has no 12-worktree-cleanup, so its Finish would otherwise leak the
  // worktree; workflow completion still defers to step 12 (whose `keep` choice must
  // be respected). On 'failed' the runtime is kept for recovery, so a later cancel
  // reaps it then.
  const removeWorktree = reason === 'cancelled' || completedType === 'run_app';
  if (removeWorktree) {
    try {
      const wt = await removeTaskWorktree(db, taskId);
      if (wt.removed) {
        await appendEvent(db, taskId, null, 'worktree.removed', {
          reason,
          worktreePath: wt.worktreePath,
          method: wt.method,
          branch: wt.branch,
          branchDeleted: wt.branchDeleted,
        });
      } else if (wt.error) {
        logger.warn(
          { taskId, worktreePath: wt.worktreePath, err: wt.error },
          'worktree removal failed',
        );
      }
    } catch (err) {
      logger.warn({ err, taskId, reason }, 'cleanup-task-worktree failed');
    }
  }

  // Reap the env template + image ONLY on cancel. cleanupTaskEnvImage deletes the
  // env_templates ROW (not just the docker image), and that row is a reusable
  // deliverable: env-replicate builds it (status ready + built image) for later tasks
  // to reuse via tasks.env_template_id. Reaping on completion deleted a freshly built
  // template before anything could reuse it — and env-replicate runs as the prelude of
  // a 'workflow' task, so it cannot be told apart by task type. Reaping genuinely
  // leaked per-task build images on completion needs a separate path that does not
  // drop the reusable row.
  if (reason === 'cancelled') {
    try {
      await cleanupTaskEnvImage(db, taskId, reason);
    } catch (err) {
      logger.warn({ err, taskId, reason }, 'cleanup-task-env-image failed');
    }
  }

  // Force-tear-down any open interactive terminal sessions for this task.
  // The web UI disables the Terminal tab when status is in a terminal state,
  // and the WS owner sees its out-channel close as the container is removed
  // here.
  try {
    const reaped = await reapAllSessionsForTask(getRedis(), new Docker(), taskId);
    if (reaped > 0) {
      await appendEvent(db, taskId, null, 'terminal_sessions.destroyed', {
        reason,
        count: reaped,
      });
    }
  } catch (err) {
    logger.warn({ err, taskId, reason }, 'cleanup-terminal-sessions failed');
  }
}

async function cleanupTaskEnvImage(
  db: Database,
  taskId: string,
  reason: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true },
  });
  const envTemplateId = task?.envTemplateId;
  if (!envTemplateId) return;

  const others = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.envTemplateId, envTemplateId), ne(schema.tasks.id, taskId)));
  const stillLive = others.some(
    (t) => t.status !== 'cancelled' && t.status !== 'failed' && t.status !== 'completed',
  );
  if (stillLive) return;

  const tpl = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.id, envTemplateId),
    columns: { imageTag: true },
  });
  if (!tpl?.imageTag) {
    await db.delete(schema.envTemplates).where(eq(schema.envTemplates.id, envTemplateId));
    return;
  }

  const result = await defaultDockerRunner.remove(tpl.imageTag);
  if (!result.ok) {
    logger.warn(
      {
        taskId,
        reason,
        imageTag: tpl.imageTag,
        envTemplateId,
        stderr: result.stderr,
        error: result.error,
      },
      'env image removal failed',
    );
    return;
  }

  await db.delete(schema.envTemplates).where(eq(schema.envTemplates.id, envTemplateId));
  await appendEvent(db, taskId, null, 'env_image.destroyed', {
    reason,
    imageTag: tpl.imageTag,
    envTemplateId,
  });
}

async function killSandboxContainersByTaskLabel(taskId: string): Promise<number> {
  const { spawn } = await import('node:child_process');
  const list = await new Promise<string>((resolve) => {
    let stdout = '';
    const child = spawn('docker', ['ps', '-q', '--filter', `label=haive.task.id=${taskId}`]);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('close', () => resolve(stdout));
    child.on('error', () => resolve(''));
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve(stdout);
    }, 10_000);
  });
  const ids = list.split(/\s+/).filter((s) => s.length > 0);
  if (ids.length === 0) return 0;
  await new Promise<void>((resolve) => {
    const child = spawn('docker', ['rm', '-f', ...ids]);
    child.on('close', () => resolve());
    child.on('error', () => resolve());
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 30_000);
  });
  return ids.length;
}

async function defaultContainerCleanup(db: Database, taskId: string): Promise<number> {
  const manager = new ContainerManager({ db });
  const rows = await manager.getByTask(taskId);
  let destroyed = 0;
  for (const row of rows) {
    if (row.status === 'destroyed') continue;
    try {
      await manager.destroy(row.id, { force: true });
      destroyed += 1;
    } catch (err) {
      logger.warn({ err, containerId: row.id, taskId }, 'container destroy failed');
    }
  }
  return destroyed;
}

async function enqueueAdvance(
  taskId: string,
  userId: string,
  stepId: string,
  round = 0,
  epoch?: number,
): Promise<void> {
  const queue = getTaskQueue();
  await queue.add(
    TASK_JOB_NAMES.ADVANCE_STEP,
    { taskId, userId, stepId, round, epoch },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
}

async function loadProviders(db: Database, userId: string): Promise<CliProviderRecord[]> {
  const rows = await db
    .select()
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.userId, userId));
  return rows;
}

/** Composite fair-scheduling priority bands (BullMQ priority: lower = sooner, max
 *  ~2^21). priority = taskRank * FAIR_RANK_MULTIPLIER + userTiebreak, so a task's
 *  Nth in-flight agent shares a band with every other task's Nth agent (round-robin
 *  across tasks — one task's fan-out cannot front-load its later terminals ahead of
 *  another task's first terminal), and within a band the least-loaded user sorts
 *  first. Both terms are clamped so the product stays under the ceiling:
 *  FAIR_TASK_RANK_MAX * FAIR_RANK_MULTIPLIER + FAIR_USER_TIEBREAK_MAX < 2^21. */
const FAIR_RANK_MULTIPLIER = 1000;
const FAIR_USER_TIEBREAK_MAX = FAIR_RANK_MULTIPLIER - 1; // never bleeds into the next band
const FAIR_TASK_RANK_MAX = 2000;

/** In-flight (enqueued or running, not yet ended/superseded) CLI invocation counts
 *  for one enqueue, in a single scan of the small in-flight set: `task` = this
 *  task's count (its rank, since the invocation row is inserted before enqueue) and
 *  `user` = this user's count across all their tasks (the cross-user tiebreak).
 *  cli_invocations has no user_id, so join through tasks; the FILTERs partition the
 *  same in-flight set two ways. */
async function cliBacklogCounts(
  db: Database,
  userId: string,
  taskId: string,
): Promise<{ task: number; user: number }> {
  const rows = await db
    .select({
      task: sql<number>`count(*) filter (where ${schema.cliInvocations.taskId} = ${taskId})::int`,
      user: sql<number>`count(*) filter (where ${schema.tasks.userId} = ${userId})::int`,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.cliInvocations.taskId, schema.tasks.id))
    .where(and(isNull(schema.cliInvocations.endedAt), isNull(schema.cliInvocations.supersededAt)));
  return { task: rows[0]?.task ?? 0, user: rows[0]?.user ?? 0 };
}

const workerDeps: WorkerDeps = {
  async enqueueCliInvocation(payload: CliExecJobPayload): Promise<void> {
    const queue = getCliExecQueue();
    const opts: JobsOptions = {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    };
    // Fair scheduling (kill-switch'd): composite priority round-robins across tasks
    // (primary = this task's in-flight rank) so one task's fan-out cannot front-load
    // its later terminals ahead of another task's first terminal, then breaks ties
    // by this user's in-flight backlog so the least-loaded user wins equal ranks
    // (cross-user fairness). Fail-soft — a stale count only mis-orders, never blocks.
    try {
      if (await configService.getBoolean(CONFIG_KEYS.FAIR_SCHEDULING_ENABLED, true)) {
        const counts = await cliBacklogCounts(getDb(), payload.userId, payload.taskId);
        const rank = Math.min(Math.max(counts.task, 1), FAIR_TASK_RANK_MAX);
        const tiebreak = Math.min(counts.user, FAIR_USER_TIEBREAK_MAX);
        opts.priority = rank * FAIR_RANK_MULTIPLIER + tiebreak;
      }
    } catch (err) {
      logger.warn({ err, userId: payload.userId }, 'fair-scheduling priority compute failed; FIFO');
    }
    await queue.add(CLI_EXEC_JOB_NAMES.INVOKE, payload, opts);
    // Queued-status visibility: if every slot is busy at enqueue, the job will
    // wait — mark the invocation so the UI shows an amber "machine busy" banner.
    // The handler overwrites this at run-start (handlers.ts started_at write), so
    // the queued text never leaks into the running (blue) status banner.
    try {
      const concurrency = await configService.getNumber(CONFIG_KEYS.MAX_PARALLEL_AGENTS, 3);
      if ((await queue.getActiveCount()) >= concurrency) {
        await getDb()
          .update(schema.cliInvocations)
          .set({
            statusMessage: `Queued — machine at capacity (${concurrency} parallel slot${
              concurrency === 1 ? '' : 's'
            }). Your run starts automatically when a slot frees.`,
          })
          .where(eq(schema.cliInvocations.id, payload.invocationId));
      }
    } catch (err) {
      logger.warn({ err, invocationId: payload.invocationId }, 'queued-status mark failed');
    }
  },
};

async function handleResult(
  db: Database,
  ctx: ResolvedTaskContext,
  stepId: string,
  result: AdvanceStepResult,
): Promise<void> {
  const stepDef = stepRegistry.require(stepId);
  switch (result.status) {
    case 'done':
    case 'skipped': {
      await appendEvent(db, ctx.taskId, result.row.id, `step.${result.status}`, {
        stepId,
      });
      // A step completed → real progress; clear the consecutive auto-resume counter so only
      // back-to-back auto-resumes with no progress in between reach the anti-thrash cap.
      await db
        .update(schema.tasks)
        .set({ allowanceAutoResumeCount: 0 })
        .where(and(eq(schema.tasks.id, ctx.taskId), ne(schema.tasks.allowanceAutoResumeCount, 0)));
      const steps = await buildRunList(ctx, db);
      const idx = steps.findIndex((s) => s.metadata.id === stepId);
      const next = idx >= 0 ? steps[idx + 1] : undefined;
      if (next) {
        // Forward walk stays in the same round as the step that just finished.
        const nextRound = result.row.round;
        await markTaskRunningWithStep(
          db,
          ctx.taskId,
          next.metadata.id,
          computeGlobalStepIndex(next.metadata.workflowType, next.metadata.index),
          nextRound,
        );
        await enqueueAdvance(
          ctx.taskId,
          ctx.userId,
          next.metadata.id,
          nextRound,
          ctx.orchestrationEpoch,
        );
      } else {
        await markTaskCompleted(db, ctx.taskId);
        await appendEvent(db, ctx.taskId, null, 'task.completed', {});
      }
      return;
    }
    case 'waiting_form': {
      await markTaskWaiting(
        db,
        ctx.taskId,
        stepId,
        computeGlobalStepIndex(stepDef.metadata.workflowType, stepDef.metadata.index),
        result.row.round,
      );
      // Stamp the start of the idle (waiting-for-input) period so the step's
      // active-work timer can exclude it. Folded into idle_ms on form submit.
      await db
        .update(schema.taskSteps)
        .set({ waitingStartedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.taskSteps.id, result.row.id));
      await appendEvent(db, ctx.taskId, result.row.id, 'step.waiting_form', { stepId });
      return;
    }
    case 'waiting_cli': {
      await db
        .update(schema.tasks)
        .set({
          status: 'running',
          currentStepId: stepId,
          // run_seq (run-monotonic), not step_index; result.row is this step's own row.
          currentStepIndex:
            result.row.runSeq ??
            computeGlobalStepIndex(stepDef.metadata.workflowType, stepDef.metadata.index),
          currentRound: result.row.round,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, ctx.taskId));
      // Park-begin candidate: the step just entered waiting_cli. If its invocations are still
      // only queued (none running yet — e.g. deferred by the per-task agent cap), stamp the
      // wait as idle; the first invocation to start running folds it back. Guarded/atomic, so
      // it no-ops if an invocation is already running (re-entry while agents are mid-flight).
      await markCliParkBegin(db, result.row.id);
      await appendEvent(db, ctx.taskId, result.row.id, 'step.waiting_cli', { stepId });
      return;
    }
    case 'loop_back': {
      // A downstream step found a blocking defect. Bump the round and re-enter at the
      // implementation step (which re-runs in fix mode with this diagnosis); the
      // forward walk then re-runs the whole post-implementation chain as round-N rows.
      const nextRound = result.row.round + 1;
      const taskRow = await db.query.tasks.findFirst({
        where: eq(schema.tasks.id, ctx.taskId),
        columns: { maxFixRounds: true },
      });
      const cap = taskRow?.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
      await appendEvent(db, ctx.taskId, result.row.id, 'step.loop_back', {
        stepId,
        sourceStepId: result.sourceStepId,
        round: nextRound,
      });
      // Oscillation guard: before the round cap, catch a non-converging loop (two checks
      // with contradictory criteria ping-ponging) and escalate to the SAME Continue/Accept/
      // Abort gate early instead of burning every round. Skipped for uncapped human restarts
      // (the developer is already the bound). Mirrors the cap-reached branch below.
      if (!result.uncapped) {
        const osc = await detectFixLoopOscillation(
          db,
          ctx.taskId,
          result.sourceStepId,
          result.diagnosis,
          nextRound,
        );
        if (osc.tripped && osc.conflictingDiagnoses) {
          await recordFixLoopRequest(db, ctx.taskId, result.row.id, {
            diagnosis: result.diagnosis,
            sourceStepId: result.sourceStepId,
            round: nextRound,
          });
          await db
            .update(schema.taskSteps)
            .set({
              status: 'waiting_form',
              formSchema: buildOscillationEscalationSchema(
                result.sourceStepId,
                osc.conflictingStepId ?? 'another step',
                osc.conflictingDiagnoses[0],
                osc.conflictingDiagnoses[1],
              ),
              formValues: null,
              endedAt: null,
              waitingStartedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.taskSteps.id, result.row.id));
          await markTaskWaiting(
            db,
            ctx.taskId,
            stepId,
            computeGlobalStepIndex(stepDef.metadata.workflowType, stepDef.metadata.index),
            result.row.round,
          );
          await appendEvent(db, ctx.taskId, result.row.id, 'fix_loop.oscillation_detected', {
            sourceStepId: result.sourceStepId,
            conflictingStepId: osc.conflictingStepId,
            round: nextRound,
          });
          return;
        }
      }
      // Uncapped restarts (human gate-2 reject) skip the cap entirely — the developer is
      // the bound, not max_fix_rounds — and fall through to re-enter implementation below.
      // Count fix rounds actually entered (each appends fix_loop.started) rather than the
      // absolute round: a human spec revision forks the round forward without spending the
      // auto-fix budget, so keying the cap on nextRound would silently cost a fix attempt.
      const startedRows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, ctx.taskId),
            eq(schema.taskEvents.eventType, 'fix_loop.started'),
          ),
        );
      const priorFixRounds = startedRows[0]?.n ?? 0;
      if (!result.uncapped && priorFixRounds + 1 > cap) {
        // Cap reached → escalate to an interactive gate (Continue / Accept / Abort)
        // parked on the source step, instead of failing. Record the fix request for the
        // next round up front so "Continue" can re-enter implementation immediately; it
        // is simply never read if the user accepts or aborts.
        await recordFixLoopRequest(db, ctx.taskId, result.row.id, {
          diagnosis: result.diagnosis,
          sourceStepId: result.sourceStepId,
          round: nextRound,
        });
        await db
          .update(schema.taskSteps)
          .set({
            status: 'waiting_form',
            formSchema: buildFixLoopEscalationSchema(result.sourceStepId, result.diagnosis, cap),
            formValues: null,
            endedAt: null,
            waitingStartedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.taskSteps.id, result.row.id));
        await markTaskWaiting(
          db,
          ctx.taskId,
          stepId,
          computeGlobalStepIndex(stepDef.metadata.workflowType, stepDef.metadata.index),
          result.row.round,
        );
        await appendEvent(db, ctx.taskId, result.row.id, 'fix_loop.escalated', {
          sourceStepId: result.sourceStepId,
          rounds: cap,
          round: nextRound,
        });
        return;
      }
      const target = stepRegistry.require(FIX_LOOP_TARGET_STEP_ID);
      await recordFixLoopRequest(db, ctx.taskId, result.row.id, {
        diagnosis: result.diagnosis,
        sourceStepId: result.sourceStepId,
        round: nextRound,
      });
      await appendEvent(db, ctx.taskId, result.row.id, 'fix_loop.started', {
        sourceStepId: result.sourceStepId,
        round: nextRound,
      });
      // If a prior attempt at this round left a terminal row (e.g. a reaped/failed CLI
      // whose invocation was never superseded — a worker reload mid-CLI), reset it so the
      // re-entry runs a FRESH invocation instead of re-consuming the dead one. Returns null
      // (no-op) when the round is new, which is the normal case. Mirrors the revise reset.
      const reentryReset = await resetStepAndDownstream(
        db,
        ctx.taskId,
        target.metadata.id,
        nextRound,
      );
      const reentryEpoch = reentryReset?.newEpoch ?? ctx.orchestrationEpoch;
      await markTaskRunningWithStep(
        db,
        ctx.taskId,
        target.metadata.id,
        computeGlobalStepIndex(target.metadata.workflowType, target.metadata.index),
        nextRound,
      );
      await enqueueAdvance(ctx.taskId, ctx.userId, target.metadata.id, nextRound, reentryEpoch);
      return;
    }
    case 'revise': {
      // A review step asked to revise an EARLIER generator step instead of failing
      // (e.g. gate-1 reject → re-plan 04, 03c reject → re-mine 03b). No cap, because the
      // loop is human-gated (the review form re-parks every cycle). The target reads its
      // revise feedback from task_events, which survives across rounds.
      const target = stepRegistry.require(result.targetStepId);
      // The learning loop (11-phase-8-learning) revises ITSELF — keep it in place in the
      // SAME round (iterative draft polish, one card). The spec gates revise an EARLIER
      // step, so FORK a new round: each attempt becomes its own forward card (history
      // preserved, per-card timer, terminal re-opens on the fresh row) — mirrors loop_back.
      const selfLoop = result.targetStepId === result.sourceStepId;
      const targetRound = selfLoop ? result.row.round : result.row.round + 1;
      await appendEvent(db, ctx.taskId, result.row.id, 'step.revise', {
        stepId,
        sourceStepId: result.sourceStepId,
        targetStepId: result.targetStepId,
        round: targetRound,
      });
      const reset = await resetStepAndDownstream(db, ctx.taskId, result.targetStepId, targetRound);
      // An in-place self-revise REQUIRES the existing row. A forked round legitimately has
      // no row yet — reset is then a crash-safety no-op (only resets a stale terminal row),
      // exactly as in loop_back; upsertRow materializes the fresh round-N rows.
      if (selfLoop && !reset) {
        await markTaskFailed(
          db,
          ctx.taskId,
          `revise: target step ${result.targetStepId} not found at round ${result.row.round}`,
        );
        return;
      }
      await markTaskRunningWithStep(
        db,
        ctx.taskId,
        target.metadata.id,
        computeGlobalStepIndex(target.metadata.workflowType, target.metadata.index),
        targetRound,
      );
      await enqueueAdvance(
        ctx.taskId,
        ctx.userId,
        target.metadata.id,
        targetRound,
        reset?.newEpoch ?? ctx.orchestrationEpoch,
      );
      return;
    }
    case 'failed': {
      await markTaskFailed(db, ctx.taskId, result.error);
      // Provider-outage hint: if the step failed on a fatal rate-limit/quota or 5xx
      // server failure, attach a structured errorHint so the UI shows an
      // "outage — retry when the provider recovers" banner instead of implying a code
      // defect. Read from the failing INVOCATION's errorMessage (the raw fatal headline
      // lives there; the step message may be prefixed e.g. "cli invocation failed: …"),
      // so this works for the DAG, single-terminal, and merge fail paths alike. Auth is
      // left to its existing textual message + the cli_login_required hint.
      const endedInvs = await db
        .select({
          errorMessage: schema.cliInvocations.errorMessage,
          cliProviderId: schema.cliInvocations.cliProviderId,
        })
        .from(schema.cliInvocations)
        .where(
          and(
            eq(schema.cliInvocations.taskStepId, result.row.id),
            isNotNull(schema.cliInvocations.endedAt),
            isNull(schema.cliInvocations.supersededAt),
            isNotNull(schema.cliInvocations.errorMessage),
          ),
        )
        .orderBy(desc(schema.cliInvocations.endedAt))
        .limit(50);
      const outage = endedInvs
        .map((r) => ({
          reason: fatalClassFromMessage(r.errorMessage),
          cliProviderId: r.cliProviderId,
        }))
        .find((r) => r.reason === 'rate_limit' || r.reason === 'server_error');
      if (outage?.reason) {
        let providerName: string | undefined;
        if (outage.cliProviderId) {
          const prov = await db.query.cliProviders.findFirst({
            where: eq(schema.cliProviders.id, outage.cliProviderId),
            columns: { name: true },
          });
          providerName = prov?.name ?? undefined;
        }
        await db
          .update(schema.taskSteps)
          .set({
            errorHint: { type: 'provider_unavailable', reason: outage.reason, providerName },
            updatedAt: new Date(),
          })
          .where(eq(schema.taskSteps.id, result.row.id));

        // Allowance-back watch (notify-only): if the fatal reason is a provider rate-limit/
        // quota AND we can read that provider's usage window, arm a SILENT watch on the task
        // so the usage poller can notify the user once the allowance replenishes. Capture the
        // window the task is blocked until (latest reset over the exhausted windows) so the
        // poller can fire on the authoritative vendor reset, not just a %-drop. No event/
        // notification here — the task-failed notification already told the user it stopped.
        if (
          outage.reason === 'rate_limit' &&
          outage.cliProviderId &&
          providerName &&
          providerName in USAGE_PROVIDERS
        ) {
          const [snap] = await db
            .select({
              fiveHourPct: schema.usageWindowSnapshots.fiveHourPct,
              fiveHourResetAt: schema.usageWindowSnapshots.fiveHourResetAt,
              sevenDayPct: schema.usageWindowSnapshots.sevenDayPct,
              sevenDayResetAt: schema.usageWindowSnapshots.sevenDayResetAt,
              dailyPct: schema.usageWindowSnapshots.dailyPct,
              dailyResetAt: schema.usageWindowSnapshots.dailyResetAt,
            })
            .from(schema.usageWindowSnapshots)
            .where(eq(schema.usageWindowSnapshots.providerId, outage.cliProviderId))
            .limit(1);
          const resetAt = snap ? constrainingResetAt(snap) : null;
          await db
            .update(schema.tasks)
            .set({
              awaitingAllowanceProviderId: outage.cliProviderId,
              allowanceResetAt: resetAt,
              allowanceReplenishedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.tasks.id, ctx.taskId));
          // Refresh the snapshot now, and wake the poller AT the reset so detection isn't up
          // to a full 5-min tick late. Both are best-effort (the repeatable tick is the floor).
          await enqueueUsagePollTick();
          if (resetAt && resetAt.getTime() > Date.now()) {
            await enqueueUsagePollTick({ delayMs: resetAt.getTime() - Date.now() });
          }
        }
      }
      await appendEvent(db, ctx.taskId, result.row.id, 'step.failed', {
        stepId,
        error: result.error,
      });
      return;
    }
  }
}

/** Resolve a fix-loop escalation gate decision parked on the source step (the step that
 *  found the defect at the round cap): continue (one more round), accept (stand down the
 *  loop + advance), or abort (fail). Mirrors the revise route's submit-driven routing. */
async function resolveFixLoopGate(
  db: Database,
  ctx: ResolvedTaskContext,
  gateRow: typeof schema.taskSteps.$inferSelect,
  action: string,
  round: number,
): Promise<void> {
  await db
    .update(schema.taskSteps)
    .set({ status: 'done', endedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, gateRow.id));

  if (action === 'abort') {
    await appendEvent(db, ctx.taskId, gateRow.id, 'fix_loop.aborted', { round });
    await markTaskFailed(db, ctx.taskId, `Fix loop aborted by the user at round ${round}.`);
    return;
  }

  if (action === 'accept') {
    // Stand down every later fix-loop check + advance forward from the source step so the
    // remaining chain runs to gate 2 with the issues recorded but unresolved.
    await recordFixLoopAccepted(db, ctx.taskId, gateRow.id);
    await appendEvent(db, ctx.taskId, gateRow.id, 'fix_loop.accepted', { round });
    const steps = await buildRunList(ctx, db);
    const idx = steps.findIndex((s) => s.metadata.id === gateRow.stepId);
    const next = idx >= 0 ? steps[idx + 1] : undefined;
    if (next) {
      await markTaskRunningWithStep(
        db,
        ctx.taskId,
        next.metadata.id,
        computeGlobalStepIndex(next.metadata.workflowType, next.metadata.index),
        round,
      );
      await enqueueAdvance(ctx.taskId, ctx.userId, next.metadata.id, round, ctx.orchestrationEpoch);
    } else {
      await markTaskCompleted(db, ctx.taskId);
      await appendEvent(db, ctx.taskId, null, 'task.completed', {});
    }
    return;
  }

  // 'continue' (default): grant one more round — re-enter implementation at round + 1.
  // The fix request for that round was recorded when the gate was raised.
  const target = stepRegistry.require(FIX_LOOP_TARGET_STEP_ID);
  const nextRound = round + 1;
  await appendEvent(db, ctx.taskId, gateRow.id, 'fix_loop.continued', { round: nextRound });
  await markTaskRunningWithStep(
    db,
    ctx.taskId,
    target.metadata.id,
    computeGlobalStepIndex(target.metadata.workflowType, target.metadata.index),
    nextRound,
  );
  await enqueueAdvance(
    ctx.taskId,
    ctx.userId,
    target.metadata.id,
    nextRound,
    ctx.orchestrationEpoch,
  );
}

async function handleStartTask(db: Database, payload: TaskJobPayload): Promise<void> {
  const ctx = await resolveTaskContext(db, payload.taskId);
  if (!ctx) {
    logger.warn({ taskId: payload.taskId }, 'start-task: task not found');
    return;
  }
  await markTaskRunning(db, ctx.taskId);
  await appendEvent(db, ctx.taskId, null, 'task.running', {});

  const steps = await buildRunList(ctx, db);
  const first = steps[0];
  if (!first) {
    await markTaskFailed(db, ctx.taskId, `no steps registered for workflow ${ctx.workflowType}`);
    return;
  }
  const providers = await loadProviders(db, ctx.userId);
  const result = await advanceStep({
    db,
    taskId: ctx.taskId,
    userId: ctx.userId,
    repoPath: ctx.repoPath,
    workspacePath: ctx.workspacePath,
    cliProviderId: ctx.cliProviderId,
    ignoreSavedStepClis: ctx.ignoreSavedStepClis,
    stepDef: first,
    // first === steps[0], so its run-list position (run_seq) is 0.
    runSeq: 0,
    providers,
    deps: workerDeps,
  });
  await handleResult(db, ctx, first.metadata.id, result);
}

async function handleAdvanceStep(
  db: Database,
  payload: TaskJobPayload,
  jobId?: string,
): Promise<void> {
  const ctx = await resolveTaskContext(db, payload.taskId);
  if (!ctx) {
    logger.warn({ taskId: payload.taskId }, 'advance-step: task not found');
    return;
  }
  if (!payload.stepId) {
    throw new Error('advance-step requires stepId');
  }
  const stepDef = stepRegistry.get(payload.stepId);
  if (!stepDef) {
    await markTaskFailed(db, ctx.taskId, `unknown step id ${payload.stepId}`);
    return;
  }

  const round = payload.round ?? 0;

  // Epoch guard: a retry/reset bumps the task's orchestration epoch, so an advance-step
  // job that explicitly carries an OLDER epoch is stale — skip it. This enforces the
  // "a retry stops in-flight work first" invariant: it invalidates queued/duplicate jobs
  // from before the retry, while still allowing a legit same-epoch stalled-recovery
  // re-delivery (which the same-step concurrency guard below cannot tell apart). A job
  // with no epoch (un-stamped / pre-deploy enqueue) is allowed — never falsely skipped.
  if (payload.epoch != null && payload.epoch < ctx.orchestrationEpoch) {
    logger.warn(
      {
        taskId: ctx.taskId,
        stepId: payload.stepId,
        jobEpoch: payload.epoch,
        taskEpoch: ctx.orchestrationEpoch,
      },
      'advance-step skipped: stale orchestration epoch (a retry/reset superseded this job)',
    );
    return;
  }

  // Concurrency guard: only one step of a task may execute at a time. A stale or
  // re-delivered advance-step — e.g. a queued job that survived a Retry/reset and
  // is replayed on worker restart — must NOT run a step while another is already
  // active; that is exactly how two steps end up running in parallel. handleResult
  // marks the prior step terminal BEFORE enqueuing the next, so a legitimate
  // hand-off never sees another active step here. Skipping returns normally, so
  // the stale job completes (leaves the queue) and is never re-delivered.
  const otherActive = await db
    .select({ stepId: schema.taskSteps.stepId, status: schema.taskSteps.status })
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, ctx.taskId),
        ne(schema.taskSteps.stepId, payload.stepId),
        inArray(schema.taskSteps.status, ['running', 'waiting_cli', 'waiting_form']),
      ),
    )
    .limit(1);
  if (otherActive[0]) {
    logger.warn(
      {
        taskId: ctx.taskId,
        stepId: payload.stepId,
        activeStepId: otherActive[0].stepId,
        activeStatus: otherActive[0].status,
      },
      'advance-step skipped: another step is already active (stale/duplicate job)',
    );
    return;
  }

  const existingRows = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, ctx.taskId),
        eq(schema.taskSteps.stepId, payload.stepId),
        eq(schema.taskSteps.round, round),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  // Same-step duplicate guard: only meaningful once an apply() is ACTUALLY
  // running (step status 'running'). The task worker's concurrency (5) lets a
  // second advance-step job for the same step+round+epoch start a parallel
  // apply() — observed as two RAG-populate embed loops (double CPU) after a
  // worker reload. If the step is already 'running', another delivery set it so;
  // yield to the live sibling in BullMQ's active set (tiebreak on job id, lower
  // wins, so two can't both yield). Gating on 'running' is what keeps this from
  // skipping a legit waiting_form submit / pending first run — with no apply in
  // flight there is nothing to duplicate, and a stale "active" zombie job (a dead
  // worker's, whose 30-min lock has not expired) must NOT block the step from
  // advancing. A genuinely orphaned 'running' step recovers via its own job's
  // same-id stalled re-delivery (excluded below by `j.id === jobId`).
  if (existing?.status === 'running' && jobId != null) {
    const activeJobs = await getTaskQueue().getActive();
    const sibling = activeJobs.find((j) => {
      if (j.id == null || j.id === jobId || j.name !== TASK_JOB_NAMES.ADVANCE_STEP) return false;
      const d = j.data as TaskJobPayload;
      return (
        d.taskId === ctx.taskId &&
        d.stepId === payload.stepId &&
        (d.round ?? 0) === round &&
        (d.epoch ?? null) === (payload.epoch ?? null)
      );
    });
    if (sibling && Number(jobId) > Number(sibling.id)) {
      logger.warn(
        { taskId: ctx.taskId, stepId: payload.stepId, round, jobId, siblingJobId: sibling.id },
        'advance-step skipped: same step already running in another job (duplicate)',
      );
      return;
    }
  }

  // Finalized out-of-band — a user Skip via the api set this step to 'skipped'.
  // Don't re-run it; advance to the next step from the registry run list (the api
  // can't see unmaterialized future steps to compute the next step itself).
  if (existing?.status === 'skipped') {
    await handleResult(db, ctx, payload.stepId, { status: 'skipped', row: existing });
    return;
  }

  // Fix-loop escalation gate: a submission carrying the gate's decision field resolves
  // the action (continue / accept / abort) here instead of re-running the parked step.
  const gateAction = (payload.formValues ??
    (existing?.formValues as Record<string, unknown> | null))?.[FIX_LOOP_ACTION_FIELD];
  if (existing && typeof gateAction === 'string') {
    await resolveFixLoopGate(db, ctx, existing, gateAction, round);
    return;
  }

  const formValues = payload.formValues ?? existing?.formValues ?? undefined;

  // Stamp the step's position in the run list as run_seq (the run-order display key).
  const runList = await buildRunList(ctx, db);
  const runIdx = runList.findIndex((s) => s.metadata.id === payload.stepId);

  const providers = await loadProviders(db, ctx.userId);
  const result = await advanceStep({
    db,
    taskId: ctx.taskId,
    userId: ctx.userId,
    repoPath: ctx.repoPath,
    workspacePath: ctx.workspacePath,
    cliProviderId: ctx.cliProviderId,
    ignoreSavedStepClis: ctx.ignoreSavedStepClis,
    stepDef,
    round,
    runSeq: runIdx >= 0 ? runIdx : undefined,
    formValues,
    providers,
    deps: workerDeps,
  });
  await handleResult(db, ctx, payload.stepId, result);
}

/** Recover steps orphaned by a prior worker that died mid-step (graceful restart,
 *  crash, or power loss). On boot no worker is alive and any sandbox was just reaped,
 *  so a stuck step never resumes on its own. Two passes:
 *
 *  1. `waiting_cli`: resolveLlmPhase is waiting on an invocation with endedAt=null
 *     that will never complete. Mark that dead invocation ended (also makes any
 *     re-delivered cli-exec job a no-op — handlers skip ended invocations) and
 *     re-drive: a step whose CLI DID finish + record resumes (exit 0 → apply →
 *     advance), an orphaned one fails (retryable).
 *  2. `running`: the advance-step JOB itself died mid-execution. Its zombie sits in
 *     BullMQ's active list under a 30-min lock, so the same-step duplicate guard
 *     blocks any retry until that lock expires. Reset the step (resetStepAndDownstream
 *     also bumps the task's orchestration epoch) and re-drive at the NEW epoch: the
 *     duplicate guard matches siblings by epoch so the new advance is not blocked, and
 *     the zombie is skipped by the epoch guard when BullMQ eventually redelivers it. No
 *     BullMQ/redis surgery, so it is safe regardless of worker count.
 *
 *  `waiting_form` user gates are durable (no in-flight job) and left untouched. */
export async function reconcileOrphanedSteps(db: Database): Promise<void> {
  const stuckCli = await db
    .select({
      taskId: schema.taskSteps.taskId,
      stepId: schema.taskSteps.stepId,
      round: schema.taskSteps.round,
      userId: schema.tasks.userId,
      epoch: schema.tasks.orchestrationEpoch,
    })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(and(eq(schema.taskSteps.status, 'waiting_cli'), eq(schema.tasks.status, 'running')));
  if (stuckCli.length > 0)
    logger.warn(
      { count: stuckCli.length },
      'reconciling waiting_cli steps orphaned by worker restart',
    );
  for (const s of stuckCli) {
    try {
      const [inv] = await db
        .select({ id: schema.cliInvocations.id })
        .from(schema.cliInvocations)
        .innerJoin(schema.taskSteps, eq(schema.taskSteps.id, schema.cliInvocations.taskStepId))
        .where(
          and(
            eq(schema.taskSteps.taskId, s.taskId),
            eq(schema.taskSteps.stepId, s.stepId),
            eq(schema.taskSteps.round, s.round),
            isNull(schema.cliInvocations.endedAt),
            isNull(schema.cliInvocations.supersededAt),
          ),
        )
        .orderBy(desc(schema.cliInvocations.startedAt))
        .limit(1);
      if (inv) {
        await db
          .update(schema.cliInvocations)
          .set({
            endedAt: new Date(),
            errorMessage: 'CLI invocation orphaned by a worker restart (worker exited mid-run)',
          })
          .where(eq(schema.cliInvocations.id, inv.id));
      }
      await enqueueAdvance(s.taskId, s.userId, s.stepId, s.round, s.epoch);
      logger.info({ taskId: s.taskId, stepId: s.stepId }, 'reconciled orphaned waiting_cli step');
    } catch (err) {
      logger.error({ err, taskId: s.taskId, stepId: s.stepId }, 'reconcile orphaned step failed');
    }
  }

  // Pass 2: steps left `running` because the advance-step job died mid-execution.
  const stuckRunning = await db
    .select({
      taskId: schema.taskSteps.taskId,
      stepId: schema.taskSteps.stepId,
      round: schema.taskSteps.round,
      userId: schema.tasks.userId,
    })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(and(eq(schema.taskSteps.status, 'running'), eq(schema.tasks.status, 'running')));
  if (stuckRunning.length > 0)
    logger.warn(
      { count: stuckRunning.length },
      'reconciling running steps orphaned by worker restart',
    );
  for (const s of stuckRunning) {
    try {
      // resetStepAndDownstream supersedes the step's open invocations, resets it to
      // pending, and bumps the task epoch so the orphaned zombie advance job no longer
      // matches the same-step duplicate guard; re-drive at that new epoch.
      const reset = await resetStepAndDownstream(db, s.taskId, s.stepId, s.round);
      if (!reset) continue;
      await enqueueAdvance(s.taskId, s.userId, s.stepId, s.round, reset.newEpoch);
      logger.info(
        { taskId: s.taskId, stepId: s.stepId, epoch: reset.newEpoch },
        'reconciled orphaned running step',
      );
    } catch (err) {
      logger.error(
        { err, taskId: s.taskId, stepId: s.stepId },
        'reconcile orphaned running step failed',
      );
    }
  }
}

/** Backfill task_steps.run_seq for rows created before it was stamped. run_seq is the
 *  step's index in buildRunList — the run-order display key the step list sorts by. Only
 *  non-terminal tasks are processed (the lists a user is actively watching); terminal tasks
 *  keep run_seq null and fall back to created_at ordering (their single-pass display was
 *  already correct). Per-task try/catch so one task with an unresolvable repo cannot abort
 *  the pass. One-time: once stamped, a task's rows are no longer null and are skipped next
 *  boot. All rounds of a step share its run-list position, so the update keys on step_id. */
export async function backfillMissingRunSeq(db: Database): Promise<void> {
  const tasks = await db
    .selectDistinct({ taskId: schema.taskSteps.taskId })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(
      and(
        isNull(schema.taskSteps.runSeq),
        inArray(schema.tasks.status, ['created', 'running', 'waiting_user', 'failed']),
      ),
    );
  if (tasks.length === 0) return;
  logger.info({ count: tasks.length }, 'backfilling run_seq for non-terminal tasks');
  for (const { taskId } of tasks) {
    try {
      const ctx = await resolveTaskContext(db, taskId);
      if (!ctx) continue;
      const runList = await buildRunList(ctx, db);
      for (let i = 0; i < runList.length; i++) {
        await db
          .update(schema.taskSteps)
          .set({ runSeq: i })
          .where(
            and(
              eq(schema.taskSteps.taskId, taskId),
              eq(schema.taskSteps.stepId, runList[i]!.metadata.id),
              isNull(schema.taskSteps.runSeq),
            ),
          );
      }
    } catch (err) {
      logger.warn({ err, taskId }, 'run_seq backfill failed for task');
    }
  }
}

async function handleCancelTask(db: Database, payload: TaskJobPayload): Promise<void> {
  const now = new Date();
  await db
    .update(schema.tasks)
    .set({ status: 'cancelled', completedAt: now, updatedAt: now })
    .where(eq(schema.tasks.id, payload.taskId));
  // The task is terminal now, but its active/parked step rows are still in a
  // non-terminal state (e.g. a run_app hold step left at waiting_form) — that
  // shows a live form on a cancelled task. step_status has no 'cancelled' value,
  // so mark them failed (mirrors the Stop path) with a clear reason. Only
  // non-terminal rows are touched, so re-running this is a no-op.
  await db
    .update(schema.taskSteps)
    .set({ status: 'failed', errorMessage: 'Task cancelled', endedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.taskSteps.taskId, payload.taskId),
        inArray(schema.taskSteps.status, ['pending', 'running', 'waiting_form', 'waiting_cli']),
      ),
    );
  await appendEvent(db, payload.taskId, null, 'task.cancelled', { source: 'worker' });
  await cleanupTaskContainers(db, payload.taskId, 'cancelled');
  await maybeUnloadTaskEmbedModel(db, payload.taskId);
  await unloadTaskOllamaCliModels(db, payload.taskId);
  // A cancelled kb_author enrich should not leave an orphan global KB entry behind;
  // delete the still-enriching row so it disappears from the KB view too.
  await reconcileKbAuthorEntryOnTaskEnd(db, payload.taskId, 'cancelled', logger);
}

async function handleCleanupRepoRag(db: Database, payload: RepoRagCleanupPayload): Promise<void> {
  const result = await cleanupRagForRepository(db, payload);
  logger.info(
    {
      repositoryId: payload.repositoryId,
      userId: payload.userId,
      dropped: result.dropped,
      kept: result.kept,
    },
    'repo rag cleanup complete',
  );
}

const WORKER_REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

/** Tear down the Docker resources + workspace files a deleted repository left
 *  behind. Best-effort + idempotent: it races the repo's CANCEL jobs (already-
 *  removed = no-op) and runs after the repo row is gone, working off the ids and
 *  paths captured at delete time. */
async function handleCleanupRepoResources(
  db: Database,
  payload: RepoResourceCleanupPayload,
): Promise<void> {
  // Per-task runners — incl. failed tasks whose DDEV/app runners were kept for
  // recovery and are otherwise never torn down.
  for (const taskId of payload.taskIds) {
    await killTaskDdevRunners(taskId).catch((err) =>
      logger.warn({ err, taskId }, 'repo-cleanup: ddev runner teardown failed'),
    );
    await killTaskAppRunners(taskId).catch((err) =>
      logger.warn({ err, taskId }, 'repo-cleanup: app runner teardown failed'),
    );
  }

  // Env images no longer referenced by any task OUTSIDE this repo's captured set
  // (ref-counted so a shared/global image another repo still uses is kept).
  const deleted = new Set(payload.taskIds);
  for (const envTemplateId of payload.envTemplateIds) {
    try {
      const refs = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.envTemplateId, envTemplateId));
      if (refs.some((r) => !deleted.has(r.id))) continue; // still used elsewhere
      const tpl = await db.query.envTemplates.findFirst({
        where: eq(schema.envTemplates.id, envTemplateId),
        columns: { imageTag: true },
      });
      if (tpl?.imageTag) {
        const result = await defaultDockerRunner.remove(tpl.imageTag);
        if (!result.ok) {
          logger.warn(
            { envTemplateId, imageTag: tpl.imageTag, stderr: result.stderr },
            'repo-cleanup: env image removal failed',
          );
          continue;
        }
      }
      await db.delete(schema.envTemplates).where(eq(schema.envTemplates.id, envTemplateId));
    } catch (err) {
      logger.warn({ err, envTemplateId }, 'repo-cleanup: env image cleanup failed');
    }
  }

  // Workspace files in the haive_repos volume. NEVER touch /host-fs local-path
  // repos (the user's real directories) — gate on the repo-storage root.
  if (payload.storagePath) {
    const resolved = resolve(payload.storagePath);
    if (resolved.startsWith(WORKER_REPO_STORAGE_ROOT + '/')) {
      await rm(resolved, { recursive: true, force: true }).catch((err) =>
        logger.warn({ err, path: resolved }, 'repo-cleanup: workspace rm failed'),
      );
    }
  }

  logger.info(
    {
      repositoryId: payload.repositoryId,
      tasks: payload.taskIds.length,
      envTemplates: payload.envTemplateIds.length,
    },
    'repo resource cleanup complete',
  );
}

type TaskWorkerPayload = TaskJobPayload | RepoRagCleanupPayload | RepoResourceCleanupPayload;

export function startTaskWorker(): Worker<TaskWorkerPayload> {
  ensureRegistered();
  const worker = new Worker<TaskWorkerPayload>(
    QUEUE_NAMES.TASK,
    async (job: Job<TaskWorkerPayload>) => {
      const db = getDb();
      try {
        if (job.name === TASK_JOB_NAMES.CLEANUP_REPO_RAG) {
          await handleCleanupRepoRag(db, job.data as RepoRagCleanupPayload);
          return;
        }
        if (job.name === TASK_JOB_NAMES.CLEANUP_REPO_RESOURCES) {
          await handleCleanupRepoResources(db, job.data as RepoResourceCleanupPayload);
          return;
        }

        const payload = job.data as TaskJobPayload;
        if (job.name === TASK_JOB_NAMES.START) {
          await handleStartTask(db, payload);
        } else if (job.name === TASK_JOB_NAMES.ADVANCE_STEP) {
          await handleAdvanceStep(db, payload, job.id);
        } else if (job.name === TASK_JOB_NAMES.CANCEL) {
          await handleCancelTask(db, payload);
        } else {
          throw new Error(`unknown task job ${job.name}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const taskId = (job.data as TaskJobPayload).taskId;
        logger.error({ taskId, jobName: job.name, err }, 'task job failed');
        if (
          taskId &&
          job.name !== TASK_JOB_NAMES.CLEANUP_REPO_RAG &&
          job.name !== TASK_JOB_NAMES.CLEANUP_REPO_RESOURCES
        ) {
          await markTaskFailed(db, taskId, message).catch((cleanupErr) => {
            logger.warn({ err: cleanupErr, taskId }, 'markTaskFailed during catch failed');
          });
        }
        throw err;
      }
    },
    {
      connection: getBullRedis(),
      concurrency: 5,
      // Task jobs orchestrate step runs which can wait minutes on CLI execs.
      // Match cli-exec lockDuration so a worker restart doesn't cause job
      // redelivery + duplicate step processing.
      lockDuration: 30 * 60 * 1000,
      maxStalledCount: 10,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'task job completed');
  });
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, name: job?.name, err }, 'task job failed');
  });

  return worker;
}
