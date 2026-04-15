import { Queue, Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { schema, type Database } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  logger,
  type CliExecInvocationKind,
  type CliExecJobPayload,
  type CliProbeJobPayload,
  type CliProbePathResult,
  type CliProbeResult,
  type TaskJobPayload,
} from '@haive/shared';
import { cliAdapterRegistry } from '../cli-adapters/registry.js';
import type { BaseCliAdapter } from '../cli-adapters/base-adapter.js';
import type {
  ApiCallSpec,
  CliCommandSpec,
  CliProviderRecord,
  SubAgentInvocation,
} from '../cli-adapters/types.js';
import {
  defaultCliSpawner,
  runSequentialSubAgent,
  type CliExecutionResult,
  type CliSpawner,
  type SpawnOptions,
  type SubAgentRunResult,
} from '../cli-executor/index.js';
import { assembleNativePrompt } from '../sub-agent-emulator/native-mode.js';
import { resolveProviderSecrets } from '../secrets/provider-secrets.js';
import { runInSandbox } from '../sandbox/sandbox-runner.js';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { getTaskQueue } from './task-queue.js';

const log = logger.child({ module: 'cli-exec-queue' });

type CliExecQueuePayload = CliExecJobPayload | CliProbeJobPayload;

let cliExecQueueInstance: Queue<CliExecQueuePayload> | null = null;

export function getCliExecQueue(): Queue<CliExecQueuePayload> {
  if (!cliExecQueueInstance) {
    cliExecQueueInstance = new Queue<CliExecQueuePayload>(QUEUE_NAMES.CLI_EXEC, {
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

  const secrets = payload.cliProviderId
    ? await resolveProviderSecrets(db, payload.cliProviderId)
    : {};

  const startedAt = Date.now();
  try {
    const result = await executeByKind(db, payload, deps, secrets);
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
  secrets: Record<string, string>,
): Promise<ExecutionOutcome> {
  switch (payload.kind) {
    case 'cli': {
      const wrapperContent = await loadProviderWrapperContent(db, payload.cliProviderId);
      return executeCliSpec(
        payload.spec as CliCommandSpec,
        deps,
        payload.timeoutMs,
        secrets,
        wrapperContent,
      );
    }
    case 'api':
      return executeApiSpec(db, payload, secrets);
    case 'subagent_sequential':
      return executeSubAgentSequential(db, payload, secrets);
    case 'subagent_native':
      return executeSubAgentNative(db, payload, deps, secrets);
    default:
      throw new Error(
        `unknown cli exec kind: ${(payload as { kind: CliExecInvocationKind }).kind}`,
      );
  }
}

async function loadProviderWrapperContent(
  db: Database,
  providerId?: string | null,
): Promise<string | null> {
  if (!providerId) return null;
  const row = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, providerId),
    columns: { wrapperContent: true },
  });
  return row?.wrapperContent ?? null;
}

async function executeCliSpec(
  spec: CliCommandSpec,
  deps: CliExecDeps,
  timeoutMs?: number,
  secrets: Record<string, string> = {},
  wrapperContent: string | null = null,
): Promise<ExecutionOutcome> {
  const mergedSpec: CliCommandSpec = {
    ...spec,
    env: { ...spec.env, ...secrets },
  };
  const spawner: CliSpawner = createSandboxSpawner(wrapperContent);
  const result = await spawner(mergedSpec, { timeoutMs });
  // deps.spawner stays injectable for tests; default code path uses the sandbox spawner
  // so the legacy direct-spawn behaviour no longer fires in production.
  void deps;
  return {
    exitCode: result.exitCode,
    rawOutput: result.stdout,
    parsedOutput: tryJsonParse(result.stdout),
    errorMessage: result.error ?? (result.exitCode !== 0 ? result.stderr.slice(0, 2000) : null),
  };
}

function createSandboxSpawner(wrapperContent: string | null | undefined): CliSpawner {
  return async (spec, opts: SpawnOptions = {}): Promise<CliExecutionResult> => {
    const result = await runInSandbox({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      wrapperContent: wrapperContent ?? undefined,
      timeoutMs: opts.timeoutMs,
      onStdoutChunk: opts.onStdoutChunk,
      onStderrChunk: opts.onStderrChunk,
      signal: opts.signal,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      error: result.error,
    };
  };
}

async function executeApiSpec(
  db: Database,
  payload: CliExecJobPayload,
  secrets: Record<string, string>,
): Promise<ExecutionOutcome> {
  const spec = payload.spec as ApiCallSpec;

  let providerEnvVars: Record<string, string> = {};
  if (payload.cliProviderId) {
    const provider = await db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, payload.cliProviderId),
    });
    if (provider?.envVars) providerEnvVars = provider.envVars;
  }

  const apiKey = secrets[spec.apiKeyEnvName] ?? providerEnvVars[spec.apiKeyEnvName];
  if (!apiKey) {
    return {
      exitCode: 1,
      rawOutput: null,
      parsedOutput: null,
      errorMessage: `api key ${spec.apiKeyEnvName} not found in secrets or envVars`,
    };
  }

  switch (spec.sdkPackage) {
    case '@anthropic-ai/sdk':
      return callAnthropic(spec, apiKey);
    case 'openai':
      return callOpenAI(spec, apiKey);
    case '@google/genai':
      return callGoogleGenAI(spec, apiKey);
    default:
      return {
        exitCode: 1,
        rawOutput: null,
        parsedOutput: null,
        errorMessage: `unknown sdk package: ${spec.sdkPackage}`,
      };
  }
}

async function callAnthropic(spec: ApiCallSpec, apiKey: string): Promise<ExecutionOutcome> {
  const client = new Anthropic(spec.baseUrl ? { apiKey, baseURL: spec.baseUrl } : { apiKey });
  try {
    const response = await client.messages.create({
      model: spec.model || spec.defaultModel,
      max_tokens: spec.maxOutputTokens,
      messages: [{ role: 'user', content: spec.prompt }],
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');
    return {
      exitCode: 0,
      rawOutput: text,
      parsedOutput: tryJsonParse(text),
      errorMessage: null,
    };
  } catch (err) {
    return {
      exitCode: 1,
      rawOutput: null,
      parsedOutput: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function callOpenAI(spec: ApiCallSpec, apiKey: string): Promise<ExecutionOutcome> {
  const client = new OpenAI(spec.baseUrl ? { apiKey, baseURL: spec.baseUrl } : { apiKey });
  try {
    const response = await client.chat.completions.create({
      model: spec.model || spec.defaultModel,
      max_tokens: spec.maxOutputTokens,
      messages: [{ role: 'user', content: spec.prompt }],
    });
    const text = response.choices[0]?.message?.content ?? '';
    return {
      exitCode: 0,
      rawOutput: text,
      parsedOutput: tryJsonParse(text),
      errorMessage: null,
    };
  } catch (err) {
    return {
      exitCode: 1,
      rawOutput: null,
      parsedOutput: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function callGoogleGenAI(spec: ApiCallSpec, apiKey: string): Promise<ExecutionOutcome> {
  const client = new GoogleGenAI({ apiKey });
  try {
    const response = await client.models.generateContent({
      model: spec.model || spec.defaultModel,
      contents: spec.prompt,
    });
    const text = response.text ?? '';
    return {
      exitCode: 0,
      rawOutput: text,
      parsedOutput: tryJsonParse(text),
      errorMessage: null,
    };
  } catch (err) {
    return {
      exitCode: 1,
      rawOutput: null,
      parsedOutput: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeSubAgentNative(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps,
  secrets: Record<string, string>,
): Promise<ExecutionOutcome> {
  if (!payload.cliProviderId) {
    throw new Error('subagent_native requires cliProviderId');
  }
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.cliProviderId),
  });
  if (!provider) {
    throw new Error(`cli provider ${payload.cliProviderId} not found`);
  }
  const adapter = cliAdapterRegistry.get(provider.name);

  const invocation = payload.spec as SubAgentInvocation;
  if (invocation.mode !== 'native') {
    throw new Error(`subagent_native expected native invocation, got ${invocation.mode}`);
  }

  const prompt = assembleNativePrompt(invocation);
  const spec = adapter.buildCliInvocation(provider, prompt, {
    cwd: undefined,
    extraEnv: secrets,
  });
  return executeCliSpec(spec, deps, payload.timeoutMs, secrets, provider.wrapperContent);
}

async function executeSubAgentSequential(
  db: Database,
  payload: CliExecJobPayload,
  secrets: Record<string, string>,
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

  const sandboxSpawner = createSandboxSpawner(provider.wrapperContent);
  const result: SubAgentRunResult = await runSequentialSubAgent(
    invocation,
    (prompt) =>
      adapter.buildCliInvocation(provider, prompt, { cwd: undefined, extraEnv: secrets }),
    sandboxSpawner,
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

export async function handleProbeJob(
  db: Database,
  payload: CliProbeJobPayload,
): Promise<CliProbeResult> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
  });
  if (!provider) {
    return {
      ok: false,
      providerId: payload.providerId,
      targetMode: payload.targetMode,
      cli: payload.targetMode !== 'api' ? { ok: false, error: 'provider not found' } : undefined,
      api: payload.targetMode !== 'cli' ? { ok: false, error: 'provider not found' } : undefined,
    };
  }

  if (!cliAdapterRegistry.has(provider.name)) {
    return {
      ok: false,
      providerId: payload.providerId,
      targetMode: payload.targetMode,
      cli:
        payload.targetMode !== 'api'
          ? { ok: false, error: `no adapter registered for ${provider.name}` }
          : undefined,
      api:
        payload.targetMode !== 'cli'
          ? { ok: false, error: `no adapter registered for ${provider.name}` }
          : undefined,
    };
  }
  const adapter = cliAdapterRegistry.get(provider.name);
  const secrets = await resolveProviderSecrets(db, payload.providerId);

  const wantCli = payload.targetMode === 'cli' || payload.targetMode === 'both';
  const wantApi = payload.targetMode === 'api' || payload.targetMode === 'both';

  const result: CliProbeResult = {
    ok: true,
    providerId: payload.providerId,
    targetMode: payload.targetMode,
  };

  if (wantCli) {
    result.cli = await probeCliPath(adapter, provider);
  }

  if (wantApi) {
    result.api = await probeApiPath(adapter, provider, secrets);
  }

  const cliOk = !wantCli || result.cli?.ok === true;
  const apiOk = !wantApi || result.api?.ok === true;
  result.ok = cliOk && apiOk;

  return result;
}

async function probeCliPath(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
): Promise<CliProbePathResult> {
  const startedAt = Date.now();
  const resolvedCommand = resolveProviderExecutable(adapter, provider);
  try {
    const result = await runInSandbox({
      command: resolvedCommand,
      args: ['--version'],
      env: provider.envVars ?? {},
      wrapperContent: provider.wrapperContent ?? undefined,
      timeoutMs: 15_000,
    });
    const durationMs = Date.now() - startedAt;
    if (result.exitCode === 0) {
      const detail = result.stdout.trim() || result.stderr.trim() || 'binary reachable';
      return { ok: true, detail, durationMs };
    }
    const error =
      result.error ??
      (result.stderr.trim() || `exit ${result.exitCode ?? 'unknown'} from sandbox probe`);
    return { ok: false, error, durationMs };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

function resolveProviderExecutable(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
): string {
  const wrapper = provider.wrapperPath?.trim();
  if (wrapper) return wrapper;
  const explicit = provider.executablePath?.trim();
  if (explicit) return explicit;
  return adapter.defaultExecutable;
}

async function probeApiPath(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  secrets: Record<string, string>,
): Promise<CliProbePathResult> {
  const startedAt = Date.now();
  if (!adapter.supportsApi || !adapter.buildApiInvocation) {
    return { ok: false, error: `${provider.name} does not support API path` };
  }
  try {
    const spec = adapter.buildApiInvocation(provider, 'Reply with the single word OK.', {
      maxOutputTokens: 20,
    });
    const apiKey = secrets[spec.apiKeyEnvName] ?? provider.envVars?.[spec.apiKeyEnvName];
    if (!apiKey) {
      return {
        ok: false,
        error: `api key ${spec.apiKeyEnvName} not found in secrets or envVars`,
        durationMs: Date.now() - startedAt,
      };
    }
    const outcome =
      spec.sdkPackage === '@anthropic-ai/sdk'
        ? await callAnthropic(spec, apiKey)
        : spec.sdkPackage === 'openai'
          ? await callOpenAI(spec, apiKey)
          : spec.sdkPackage === '@google/genai'
            ? await callGoogleGenAI(spec, apiKey)
            : {
                exitCode: 1,
                rawOutput: null,
                parsedOutput: null,
                errorMessage: `unknown sdk: ${spec.sdkPackage}`,
              };
    if (outcome.exitCode === 0 && outcome.rawOutput) {
      return {
        ok: true,
        detail: outcome.rawOutput.slice(0, 200),
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      ok: false,
      error: outcome.errorMessage ?? 'api call failed',
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

export function startCliExecWorker(
  deps: CliExecDeps = defaultDeps,
): Worker<CliExecQueuePayload, CliProbeResult | void> {
  const worker = new Worker<CliExecQueuePayload, CliProbeResult | void>(
    QUEUE_NAMES.CLI_EXEC,
    async (job: Job<CliExecQueuePayload>) => {
      const db = getDb();
      if (job.name === CLI_EXEC_JOB_NAMES.INVOKE) {
        await handleCliExecJob(db, job.data as CliExecJobPayload, deps);
        return;
      }
      if (job.name === CLI_EXEC_JOB_NAMES.PROBE) {
        return handleProbeJob(db, job.data as CliProbeJobPayload);
      }
      throw new Error(`unknown cli-exec job ${job.name}`);
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
