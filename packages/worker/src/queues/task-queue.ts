import { Queue, Worker, type Job } from 'bullmq';
import Docker from 'dockerode';
import { and, eq, ne } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  logger,
  type CliExecJobPayload,
  type RepoRagCleanupPayload,
  type TaskJobPayload,
  type WorkflowType,
} from '@haive/shared';
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
import { ContainerManager } from '../sandbox/container-manager.js';
import { defaultDockerRunner } from '../sandbox/docker-runner.js';
import { cleanupTaskAuthVolumes } from '../sandbox/task-auth-volume.js';
import { cleanupRagForRepository } from '../step-engine/steps/onboarding/_rag-connection.js';
import { getCliExecQueue } from './cli-exec-queue.js';

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
  metadata: Record<string, unknown> | null;
}

async function buildRunList(ctx: ResolvedTaskContext): Promise<StepDefinition[]> {
  const main = stepRegistry.listByWorkflow(ctx.workflowType);
  if (ctx.workflowType === 'workflow') {
    const prelude = stepRegistry.listByWorkflow('env_replicate');
    return [...prelude, ...main];
  }
  return main;
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
    metadata: task.metadata ?? null,
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

async function markTaskWaiting(
  db: Database,
  taskId: string,
  stepId: string,
  stepIndex: number,
): Promise<void> {
  await db
    .update(schema.tasks)
    .set({
      status: 'waiting_user',
      currentStepId: stepId,
      currentStepIndex: stepIndex,
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.id, taskId));
}

async function markTaskRunningWithStep(
  db: Database,
  taskId: string,
  stepId: string,
  stepIndex: number,
): Promise<void> {
  await db
    .update(schema.tasks)
    .set({
      status: 'running',
      currentStepId: stepId,
      currentStepIndex: stepIndex,
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

async function enqueueAdvance(taskId: string, userId: string, stepId: string): Promise<void> {
  const queue = getTaskQueue();
  await queue.add(
    TASK_JOB_NAMES.ADVANCE_STEP,
    { taskId, userId, stepId },
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

const workerDeps: WorkerDeps = {
  async enqueueCliInvocation(payload: CliExecJobPayload): Promise<void> {
    await getCliExecQueue().add(CLI_EXEC_JOB_NAMES.INVOKE, payload, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
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
      const steps = await buildRunList(ctx);
      const idx = steps.findIndex((s) => s.metadata.id === stepId);
      const next = idx >= 0 ? steps[idx + 1] : undefined;
      if (next) {
        await markTaskRunningWithStep(
          db,
          ctx.taskId,
          next.metadata.id,
          computeGlobalStepIndex(next.metadata.workflowType, next.metadata.index),
        );
        await enqueueAdvance(ctx.taskId, ctx.userId, next.metadata.id);
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
      );
      await appendEvent(db, ctx.taskId, result.row.id, 'step.waiting_form', { stepId });
      return;
    }
    case 'waiting_cli': {
      await db
        .update(schema.tasks)
        .set({
          status: 'running',
          currentStepId: stepId,
          currentStepIndex: computeGlobalStepIndex(
            stepDef.metadata.workflowType,
            stepDef.metadata.index,
          ),
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, ctx.taskId));
      await appendEvent(db, ctx.taskId, result.row.id, 'step.waiting_cli', { stepId });
      return;
    }
    case 'failed': {
      await markTaskFailed(db, ctx.taskId, result.error);
      await appendEvent(db, ctx.taskId, result.row.id, 'step.failed', {
        stepId,
        error: result.error,
      });
      return;
    }
  }
}

async function handleStartTask(db: Database, payload: TaskJobPayload): Promise<void> {
  const ctx = await resolveTaskContext(db, payload.taskId);
  if (!ctx) {
    logger.warn({ taskId: payload.taskId }, 'start-task: task not found');
    return;
  }
  await markTaskRunning(db, ctx.taskId);
  await appendEvent(db, ctx.taskId, null, 'task.running', {});

  const steps = await buildRunList(ctx);
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
    stepDef: first,
    providers,
    deps: workerDeps,
  });
  await handleResult(db, ctx, first.metadata.id, result);
}

async function handleAdvanceStep(db: Database, payload: TaskJobPayload): Promise<void> {
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

  let formValues = payload.formValues;
  if (!formValues) {
    const existing = await db
      .select()
      .from(schema.taskSteps)
      .where(
        and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.stepId, payload.stepId)),
      )
      .limit(1);
    formValues = existing[0]?.formValues ?? undefined;
  }

  const providers = await loadProviders(db, ctx.userId);
  const result = await advanceStep({
    db,
    taskId: ctx.taskId,
    userId: ctx.userId,
    repoPath: ctx.repoPath,
    workspacePath: ctx.workspacePath,
    cliProviderId: ctx.cliProviderId,
    stepDef,
    formValues,
    providers,
    deps: workerDeps,
  });
  await handleResult(db, ctx, payload.stepId, result);
}

async function handleCancelTask(db: Database, payload: TaskJobPayload): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.tasks.id, payload.taskId));
  await appendEvent(db, payload.taskId, null, 'task.cancelled', { source: 'worker' });
  await cleanupTaskContainers(db, payload.taskId, 'cancelled');
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

type TaskWorkerPayload = TaskJobPayload | RepoRagCleanupPayload;

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

        const payload = job.data as TaskJobPayload;
        if (job.name === TASK_JOB_NAMES.START) {
          await handleStartTask(db, payload);
        } else if (job.name === TASK_JOB_NAMES.ADVANCE_STEP) {
          await handleAdvanceStep(db, payload);
        } else if (job.name === TASK_JOB_NAMES.CANCEL) {
          await handleCancelTask(db, payload);
        } else {
          throw new Error(`unknown task job ${job.name}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const taskId = (job.data as TaskJobPayload).taskId;
        logger.error({ taskId, jobName: job.name, err }, 'task job failed');
        if (taskId && job.name !== TASK_JOB_NAMES.CLEANUP_REPO_RAG) {
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
