import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  type CliProviderName,
  type RefreshCliVersionsJobPayload,
  type RefreshCliVersionsJobResult,
  type SandboxImageBuildJobPayload,
  type SandboxImageBuildResult,
  type TaskJobPayload,
} from '@haive/shared';
import { refreshAllCliVersions } from '../cli-versions/index.js';
import { defaultDockerRunner } from '../sandbox/docker-runner.js';
import { renderDockerfile, resolveImageTag } from '../sandbox/image-cache.js';
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

type CliExecQueuePayload =
  | CliExecJobPayload
  | CliProbeJobPayload
  | SandboxImageBuildJobPayload
  | RefreshCliVersionsJobPayload;

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
      const { wrapperContent, sandboxImage } = await loadProviderRuntimeConfig(
        db,
        payload.cliProviderId,
      );
      return executeCliSpec(
        payload.spec as CliCommandSpec,
        deps,
        payload.timeoutMs,
        secrets,
        wrapperContent,
        sandboxImage,
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

interface ProviderRuntimeConfig {
  wrapperContent: string | null;
  sandboxImage: string | null;
}

async function loadProviderRuntimeConfig(
  db: Database,
  providerId?: string | null,
): Promise<ProviderRuntimeConfig> {
  if (!providerId) return { wrapperContent: null, sandboxImage: null };
  const row = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, providerId),
  });
  if (!row) return { wrapperContent: null, sandboxImage: null };
  const sandboxImage = await ensureProviderSandboxImage(db, row);
  return {
    wrapperContent: row.wrapperContent ?? null,
    sandboxImage,
  };
}

async function ensureProviderSandboxImage(
  db: Database,
  provider: {
    id: string;
    userId: string;
    name: string;
    cliVersion: string | null;
    sandboxDockerfileExtra: string | null;
  },
): Promise<string | null> {
  const resolution = resolveImageTag({
    name: provider.name as CliProviderName,
    cliVersion: provider.cliVersion?.trim() || null,
    providerId: provider.id,
    sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
  });
  if (!resolution) return null;

  const existing = await defaultDockerRunner.inspect(resolution.tag);
  if (existing.exists) return resolution.tag;

  log.info(
    { providerId: provider.id, tag: resolution.tag },
    'sandbox image cache miss, building inline',
  );
  const result = await handleBuildSandboxImageJob(db, {
    providerId: provider.id,
    userId: provider.userId,
  });
  if (!result.ok) {
    throw new Error(`sandbox image build failed: ${result.error ?? 'unknown'}`);
  }
  return result.imageTag ?? null;
}

async function executeCliSpec(
  spec: CliCommandSpec,
  deps: CliExecDeps,
  timeoutMs?: number,
  secrets: Record<string, string> = {},
  wrapperContent: string | null = null,
  sandboxImage: string | null = null,
): Promise<ExecutionOutcome> {
  const mergedSpec: CliCommandSpec = {
    ...spec,
    env: { ...spec.env, ...secrets },
  };
  const spawner: CliSpawner = createSandboxSpawner(wrapperContent, sandboxImage);
  const result = await spawner(mergedSpec, { timeoutMs });
  void deps;
  return {
    exitCode: result.exitCode,
    rawOutput: result.stdout,
    parsedOutput: tryJsonParse(result.stdout),
    errorMessage: result.error ?? (result.exitCode !== 0 ? result.stderr.slice(0, 2000) : null),
  };
}

function createSandboxSpawner(
  wrapperContent: string | null | undefined,
  sandboxImage: string | null = null,
): CliSpawner {
  return async (spec, opts: SpawnOptions = {}): Promise<CliExecutionResult> => {
    const result = await runInSandbox(
      {
        command: spec.command,
        args: spec.args,
        env: spec.env,
        wrapperContent: wrapperContent ?? undefined,
        timeoutMs: opts.timeoutMs,
        onStdoutChunk: opts.onStdoutChunk,
        onStderrChunk: opts.onStderrChunk,
        signal: opts.signal,
      },
      sandboxImage ? { image: sandboxImage } : undefined,
    );
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
  const sandboxImage = await ensureProviderSandboxImage(db, provider);
  return executeCliSpec(
    spec,
    deps,
    payload.timeoutMs,
    secrets,
    provider.wrapperContent,
    sandboxImage,
  );
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

  const sandboxImage = await ensureProviderSandboxImage(db, provider);
  const spawner = createSandboxSpawner(provider.wrapperContent, sandboxImage);
  const result: SubAgentRunResult = await runSequentialSubAgent(
    invocation,
    (prompt) =>
      adapter.buildCliInvocation(provider, prompt, { cwd: undefined, extraEnv: secrets }),
    spawner,
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
    result.cli = await probeCliPath(db, adapter, provider);
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
  db: Database,
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
): Promise<CliProbePathResult> {
  const startedAt = Date.now();
  const resolvedCommand = resolveProviderExecutable(adapter, provider);
  let sandboxImage: string | null;
  try {
    sandboxImage = await ensureProviderSandboxImage(db, provider);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
  const spawner = createSandboxSpawner(provider.wrapperContent, sandboxImage);
  try {
    const result = await spawner(
      {
        command: resolvedCommand,
        args: ['--version'],
        env: provider.envVars ?? {},
      },
      { timeoutMs: 15_000 },
    );
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

async function markProvidersReady(
  db: Database,
  imageTag: string,
  providerId: string,
  shared: boolean,
): Promise<void> {
  const now = new Date();
  if (shared) {
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageTag: imageTag,
        sandboxImageBuildStatus: 'ready',
        sandboxImageBuildError: null,
        sandboxImageBuiltAt: now,
        updatedAt: now,
      })
      .where(eq(schema.cliProviders.sandboxImageTag, imageTag));
  }
  await db
    .update(schema.cliProviders)
    .set({
      sandboxImageTag: imageTag,
      sandboxImageBuildStatus: 'ready',
      sandboxImageBuildError: null,
      sandboxImageBuiltAt: now,
      updatedAt: now,
    })
    .where(eq(schema.cliProviders.id, providerId));
}

export async function handleBuildSandboxImageJob(
  db: Database,
  payload: SandboxImageBuildJobPayload,
): Promise<SandboxImageBuildResult> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
  });
  if (!provider) {
    return { ok: false, providerId: payload.providerId, error: 'provider not found' };
  }

  const cliVersion = provider.cliVersion?.trim() || null;
  const resolution = resolveImageTag({
    name: provider.name as CliProviderName,
    cliVersion,
    providerId: provider.id,
    sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
  });

  if (!resolution) {
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageTag: null,
        sandboxImageBuildStatus: 'idle',
        sandboxImageBuildError: null,
        sandboxImageBuiltAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
    log.info(
      { providerId: provider.id },
      'sandbox image build skipped (no install lines, no extras)',
    );
    return { ok: true, providerId: provider.id };
  }

  const { tag: imageTag, shared } = resolution;

  await db
    .update(schema.cliProviders)
    .set({
      sandboxImageTag: imageTag,
      sandboxImageBuildStatus: 'building',
      sandboxImageBuildError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.cliProviders.id, provider.id));

  if (!payload.force) {
    const existing = await defaultDockerRunner.inspect(imageTag);
    if (existing.exists) {
      await markProvidersReady(db, imageTag, provider.id, shared);
      log.info(
        { providerId: provider.id, imageTag, shared },
        'sandbox image cache hit',
      );
      return { ok: true, providerId: provider.id, imageTag };
    }
  }

  const dockerfileContent = renderDockerfile(resolution);
  const buildDir = join(tmpdir(), `haive-sandbox-build-${randomUUID()}`);
  const dockerfilePath = join(buildDir, 'Dockerfile');

  try {
    await mkdir(buildDir, { recursive: true });
    await writeFile(dockerfilePath, dockerfileContent, 'utf8');

    log.info({ providerId: provider.id, imageTag, shared }, 'building sandbox image');
    const result = await defaultDockerRunner.build({
      contextDir: buildDir,
      dockerfilePath,
      tag: imageTag,
      timeoutMs: 20 * 60 * 1000,
    });

    if (result.exitCode === 0) {
      await markProvidersReady(db, imageTag, provider.id, shared);
      log.info(
        { providerId: provider.id, imageTag, durationMs: result.durationMs },
        'sandbox image build succeeded',
      );
      return {
        ok: true,
        providerId: provider.id,
        imageTag,
        durationMs: result.durationMs,
      };
    }

    const errMsg = (result.error ?? result.stderr ?? `exit ${result.exitCode}`).slice(-4000);
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageBuildStatus: 'failed',
        sandboxImageBuildError: errMsg,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
    log.warn(
      { providerId: provider.id, imageTag, exitCode: result.exitCode },
      'sandbox image build failed',
    );
    return {
      ok: false,
      providerId: provider.id,
      error: errMsg,
      durationMs: result.durationMs,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageBuildStatus: 'failed',
        sandboxImageBuildError: errMsg,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
    log.error({ err, providerId: provider.id }, 'sandbox image build threw');
    return { ok: false, providerId: provider.id, error: errMsg };
  } finally {
    rm(buildDir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn({ err, buildDir }, 'failed to cleanup sandbox build dir');
    });
  }
}

export async function handleRefreshCliVersionsJob(
  db: Database,
): Promise<RefreshCliVersionsJobResult> {
  return refreshAllCliVersions(db);
}

const VERSION_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const VERSION_REFRESH_JOB_ID = 'cli-refresh-versions-repeatable';

export async function scheduleCliVersionRefresh(): Promise<void> {
  const queue = getCliExecQueue();
  await queue.add(
    CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
    { force: false } satisfies RefreshCliVersionsJobPayload,
    {
      repeat: { every: VERSION_REFRESH_INTERVAL_MS },
      jobId: VERSION_REFRESH_JOB_ID,
      removeOnComplete: true,
      removeOnFail: 10,
    },
  );
  await queue.add(
    CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
    { force: true } satisfies RefreshCliVersionsJobPayload,
    { removeOnComplete: true, removeOnFail: 10 },
  );
}

export function startCliExecWorker(
  deps: CliExecDeps = defaultDeps,
): Worker<
  CliExecQueuePayload,
  CliProbeResult | SandboxImageBuildResult | RefreshCliVersionsJobResult | void
> {
  const worker = new Worker<
    CliExecQueuePayload,
    CliProbeResult | SandboxImageBuildResult | RefreshCliVersionsJobResult | void
  >(
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
      if (job.name === CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE) {
        return handleBuildSandboxImageJob(db, job.data as SandboxImageBuildJobPayload);
      }
      if (job.name === CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS) {
        return handleRefreshCliVersionsJob(db);
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
