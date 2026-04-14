import { Queue, Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  logger,
  type CliExecInvocationKind,
  type CliExecJobPayload,
  type TaskJobPayload,
} from '@haive/shared';
import { cliAdapterRegistry } from '../cli-adapters/registry.js';
import type { ApiCallSpec, CliCommandSpec, SubAgentInvocation } from '../cli-adapters/types.js';
import {
  defaultCliSpawner,
  runSequentialSubAgent,
  type CliSpawner,
  type SubAgentRunResult,
} from '../cli-executor/index.js';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { getTaskQueue } from './task-queue.js';

const log = logger.child({ module: 'cli-exec-queue' });

let cliExecQueueInstance: Queue<CliExecJobPayload> | null = null;

export function getCliExecQueue(): Queue<CliExecJobPayload> {
  if (!cliExecQueueInstance) {
    cliExecQueueInstance = new Queue<CliExecJobPayload>(QUEUE_NAMES.CLI_EXEC, {
      connection: getBullRedis(),
    });
  }
  return cliExecQueueInstance;
}

export async function closeCliExecQueue(): Promise<void> {
  if (cliExecQueueInstance) {
    await cliExecQueueInstance.close();
    cliExecQueueInstance = null;
  }
}

export interface CliExecDeps {
  spawner: CliSpawner;
}

const defaultDeps: CliExecDeps = {
  spawner: defaultCliSpawner,
};

export async function handleCliExecJob(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps = defaultDeps,
): Promise<void> {
  const row = await db.query.cliInvocations.findFirst({
    where: eq(schema.cliInvocations.id, payload.invocationId),
  });
  if (!row) {
    log.warn({ invocationId: payload.invocationId }, 'cli invocation row missing');
    return;
  }

  await db
    .update(schema.cliInvocations)
    .set({ startedAt: new Date() })
    .where(eq(schema.cliInvocations.id, row.id));

  const startedAt = Date.now();
  try {
    const result = await executeByKind(db, payload, deps);
    const durationMs = Date.now() - startedAt;

    await db
      .update(schema.cliInvocations)
      .set({
        exitCode: result.exitCode,
        rawOutput: result.rawOutput,
        parsedOutput: result.parsedOutput as unknown,
        durationMs,
        errorMessage: result.errorMessage ?? null,
        endedAt: new Date(),
      })
      .where(eq(schema.cliInvocations.id, row.id));

    await resumeStepIfLinked(payload, result.exitCode === 0, result.errorMessage ?? null);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, invocationId: payload.invocationId }, 'cli exec failed');
    await db
      .update(schema.cliInvocations)
      .set({
        exitCode: -1,
        errorMessage: message,
        durationMs,
        endedAt: new Date(),
      })
      .where(eq(schema.cliInvocations.id, row.id));
    await resumeStepIfLinked(payload, false, message);
    throw err;
  }
}

interface ExecutionOutcome {
  exitCode: number | null;
  rawOutput: string | null;
  parsedOutput: unknown;
  errorMessage: string | null;
}

async function executeByKind(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps,
): Promise<ExecutionOutcome> {
  switch (payload.kind) {
    case 'cli':
      return executeCliSpec(payload.spec as CliCommandSpec, deps, payload.timeoutMs);
    case 'api':
      return executeApiSpec(payload.spec as ApiCallSpec);
    case 'subagent_sequential':
      return executeSubAgentSequential(db, payload, deps);
    case 'subagent_native':
      return executeCliSpec(payload.spec as CliCommandSpec, deps, payload.timeoutMs);
    default:
      throw new Error(
        `unknown cli exec kind: ${(payload as { kind: CliExecInvocationKind }).kind}`,
      );
  }
}

async function executeCliSpec(
  spec: CliCommandSpec,
  deps: CliExecDeps,
  timeoutMs?: number,
): Promise<ExecutionOutcome> {
  const result = await deps.spawner(spec, { timeoutMs });
  return {
    exitCode: result.exitCode,
    rawOutput: result.stdout,
    parsedOutput: tryJsonParse(result.stdout),
    errorMessage: result.error ?? (result.exitCode !== 0 ? result.stderr.slice(0, 2000) : null),
  };
}

async function executeApiSpec(_spec: ApiCallSpec): Promise<ExecutionOutcome> {
  throw new Error('api execution not yet wired');
}

async function executeSubAgentSequential(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps,
): Promise<ExecutionOutcome> {
  if (!payload.cliProviderId) {
    throw new Error('subagent_sequential requires cliProviderId');
  }
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.cliProviderId),
  });
  if (!provider) {
    throw new Error(`cli provider ${payload.cliProviderId} not found`);
  }
  const adapter = cliAdapterRegistry.get(provider.name);

  const invocation = payload.spec as SubAgentInvocation;
  if (invocation.mode !== 'sequential') {
    throw new Error(`subagent_sequential expected sequential invocation, got ${invocation.mode}`);
  }

  const result: SubAgentRunResult = await runSequentialSubAgent(
    invocation,
    (prompt) => adapter.buildCliInvocation(provider, prompt, { cwd: undefined }),
    deps.spawner,
    { timeoutMs: payload.timeoutMs },
  );

  const failed = result.exitCode !== 0;
  return {
    exitCode: result.exitCode,
    rawOutput: JSON.stringify(result.trace),
    parsedOutput: { collected: result.collected, synthesis: result.synthesis },
    errorMessage: failed ? describeFailedSubAgent(result) : null,
  };
}

function describeFailedSubAgent(result: SubAgentRunResult): string {
  const failedEntry = result.trace.find((t) => (t.exitCode ?? 0) !== 0 || t.error);
  if (!failedEntry) return 'sub-agent script exited non-zero';
  return `sub-agent step ${failedEntry.id} failed: ${failedEntry.error ?? failedEntry.stderr.slice(0, 500)}`;
}

function tryJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function resumeStepIfLinked(
  payload: CliExecJobPayload,
  success: boolean,
  _errorMessage: string | null,
): Promise<void> {
  if (!payload.taskStepId) return;
  const taskPayload: TaskJobPayload = {
    taskId: payload.taskId,
    userId: payload.userId,
  };
  const queue = getTaskQueue();
  if (success) {
    const db = getDb();
    const stepRow = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, payload.taskStepId),
      columns: { stepId: true },
    });
    if (stepRow) {
      taskPayload.stepId = stepRow.stepId;
    }
  }
  await queue.add(TASK_JOB_NAMES.ADVANCE_STEP, taskPayload, {
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

export function startCliExecWorker(deps: CliExecDeps = defaultDeps): Worker<CliExecJobPayload> {
  const worker = new Worker<CliExecJobPayload>(
    QUEUE_NAMES.CLI_EXEC,
    async (job: Job<CliExecJobPayload>) => {
      if (job.name !== CLI_EXEC_JOB_NAMES.INVOKE) {
        throw new Error(`unknown cli-exec job ${job.name}`);
      }
      const db = getDb();
      await handleCliExecJob(db, job.data, deps);
    },
    {
      connection: getBullRedis(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    log.info({ jobId: job.id, name: job.name }, 'cli-exec job completed');
  });
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, name: job?.name, err }, 'cli-exec job failed');
  });

  return worker;
}
