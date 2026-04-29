import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue, Worker, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
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
  type CliLoginCreateJobPayload,
  type CliLoginCreateResult,
  type CliNetworkPolicy,
  type CliProbeJobPayload,
  type CliProbePathResult,
  type CliProbeResult,
  type CliProviderName,
  type RefreshCliVersionsJobPayload,
  type RefreshCliVersionsJobResult,
  type SandboxImageBuildJobPayload,
  type SandboxImageBuildResult,
  type StepErrorHint,
  type TaskJobPayload,
} from '@haive/shared';
import { refreshAllCliVersions } from '../cli-versions/index.js';
import {
  defaultDockerRunner,
  type DockerRunner,
  type DockerVolumeMount,
} from '../sandbox/docker-runner.js';
import { renderDockerfile, resolveImageTag } from '../sandbox/image-cache.js';
import { ensureComposedImage } from '../sandbox/composed-image-cache.js';
import {
  SANDBOX_WORKDIR,
  SANDBOX_USER_HOME,
  type SandboxExtraFile,
} from '../sandbox/sandbox-runner.js';
import { buildDefaultMcpServers, buildMcpConfigForCli } from '../sandbox/mcp-config.js';
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
import { resolveUserGitEnv } from '../secrets/user-git-identity.js';
import { runInSandbox } from '../sandbox/sandbox-runner.js';
import { resolveCliAuthMounts } from '../sandbox/cli-auth-volume.js';
import {
  ensureTaskAuthVolumes,
  resolveTaskAuthMounts,
  resolveTaskSkillMounts,
  seedRtkInTaskVolume,
  userAuthVolumeExists,
} from '../sandbox/task-auth-volume.js';
import {
  buildAuthProbeCommand,
  classifyAuthProbeOutput,
  isAuthProbeSupported,
} from '../cli-adapters/auth-probe.js';
import { createSandboxLoginContainer } from '../sandbox/login-container.js';
import { buildSetupTokenCommand } from '../cli-adapters/setup-token-command.js';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { getTaskQueue } from './task-queue.js';

const log = logger.child({ module: 'cli-exec-queue' });

type CliExecQueuePayload =
  | CliExecJobPayload
  | CliProbeJobPayload
  | SandboxImageBuildJobPayload
  | RefreshCliVersionsJobPayload
  | CliLoginCreateJobPayload;

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

  const providerSecrets = payload.cliProviderId
    ? await resolveProviderSecrets(db, payload.cliProviderId)
    : {};
  const gitEnv = await resolveUserGitEnv(db, payload.userId);
  const secrets: Record<string, string> = { ...gitEnv, ...providerSecrets };

  const startedAt = Date.now();
  try {
    const result = await executeByKind(db, payload, deps, secrets);
    const durationMs = Date.now() - startedAt;

    const providerName = await resolveProviderNameForPayload(db, payload);
    const finalErrorMessage = interpretCliFailure(result, providerName);

    await db
      .update(schema.cliInvocations)
      .set({
        exitCode: result.exitCode,
        rawOutput: result.rawOutput,
        parsedOutput: result.parsedOutput as unknown,
        durationMs,
        errorMessage: finalErrorMessage,
        endedAt: new Date(),
      })
      .where(eq(schema.cliInvocations.id, row.id));

    await resumeStepIfLinked(payload, result.exitCode === 0, finalErrorMessage);
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
    if (err instanceof CliLoginRequiredError && payload.taskStepId) {
      await db
        .update(schema.taskSteps)
        .set({ errorHint: err.hint, updatedAt: new Date() })
        .where(eq(schema.taskSteps.id, payload.taskStepId));
    }
    await resumeStepIfLinked(payload, false, message);
    throw err;
  }
}

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /\b401\b/,
  /authentication_error/i,
  /invalid authentication credentials/i,
  /\bunauthorized\b/i,
  /\bunauthenticated\b/i,
  /please log.?in/i,
  /not authenticated/i,
  /token.*(expired|invalid)/i,
];

const PROVIDER_LOGIN_HINTS: Record<string, string> = {
  'claude-code': 'claude /login',
  codex: 'codex login',
  gemini: 'gemini auth login',
  amp: 'amp login',
  zai: 'zai login',
};

export function interpretCliFailure(
  result: ExecutionOutcome,
  providerName: string | null,
): string | null {
  const existing = result.errorMessage ?? null;
  if (result.exitCode === 0) return existing;

  const haystack = [existing ?? '', result.rawOutput ?? ''].join('\n');
  const looksLikeAuth = AUTH_FAILURE_PATTERNS.some((p) => p.test(haystack));
  if (!looksLikeAuth) return existing;

  const loginCmd = providerName ? PROVIDER_LOGIN_HINTS[providerName] : null;
  const hint = loginCmd
    ? `run \`${loginCmd}\` in your terminal and then retry this step`
    : 're-authenticate your CLI in your terminal and then retry this step';
  const detail = existing && existing.trim().length > 0 ? ` (${existing.trim()})` : '';
  return `CLI authentication failed — ${hint}.${detail}`;
}

async function resolveProviderNameForPayload(
  db: Database,
  payload: CliExecJobPayload,
): Promise<string | null> {
  if (!payload.cliProviderId) return null;
  const row = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.cliProviderId),
    columns: { name: true },
  });
  return row?.name ?? null;
}

export interface ExecutionOutcome {
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
  const repoMount = await resolveTaskRepoMount(db, payload.taskId);
  const sandboxWorkdir = await resolveTaskSandboxWorkdir(db, payload.taskId);
  switch (payload.kind) {
    case 'cli': {
      const { wrapperContent, sandboxImage, networkPolicy } = await loadProviderRuntimeConfig(
        db,
        payload.cliProviderId,
        payload.taskId,
      );
      const providerRow = payload.cliProviderId
        ? await db.query.cliProviders.findFirst({
            where: eq(schema.cliProviders.id, payload.cliProviderId),
          })
        : null;
      let authMounts: DockerVolumeMount[] = [];
      if (providerRow && cliAdapterRegistry.has(providerRow.name)) {
        authMounts = await resolveAuthMounts(db, providerRow, payload.taskId);
      }
      const mcpFiles = providerRow
        ? await resolveMcpExtraFiles(
            db,
            payload.taskId,
            providerRow.name as CliProviderName,
            sandboxWorkdir,
          )
        : [];
      const statusUpdater = payload.taskStepId
        ? createStepStatusUpdater(db, payload.taskStepId)
        : undefined;
      return executeCliSpec(
        payload.spec as CliCommandSpec,
        deps,
        payload.timeoutMs,
        secrets,
        wrapperContent,
        sandboxImage,
        repoMount,
        sandboxWorkdir,
        networkPolicy,
        mcpFiles,
        authMounts,
        statusUpdater,
      );
    }
    case 'api':
      return executeApiSpec(db, payload, secrets);
    case 'subagent_sequential':
      return executeSubAgentSequential(db, payload, secrets, repoMount, sandboxWorkdir);
    case 'subagent_native':
      return executeSubAgentNative(db, payload, deps, secrets, repoMount, sandboxWorkdir);
    default:
      throw new Error(
        `unknown cli exec kind: ${(payload as { kind: CliExecInvocationKind }).kind}`,
      );
  }
}

interface ProviderRuntimeConfig {
  wrapperContent: string | null;
  sandboxImage: string | null;
  networkPolicy: CliNetworkPolicy | null;
}

async function loadProviderRuntimeConfig(
  db: Database,
  providerId?: string | null,
  taskId?: string | null,
): Promise<ProviderRuntimeConfig> {
  if (!providerId) {
    return { wrapperContent: null, sandboxImage: null, networkPolicy: null };
  }
  const row = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, providerId),
  });
  if (!row) return { wrapperContent: null, sandboxImage: null, networkPolicy: null };
  const sandboxImage = await resolveSandboxImageTag(db, taskId ?? null, row);
  return {
    wrapperContent: row.wrapperContent ?? null,
    sandboxImage,
    networkPolicy: row.networkPolicy,
  };
}

export async function resolveMcpExtraFiles(
  db: Database,
  taskId: string,
  providerName: CliProviderName,
  sandboxWorkdir: string,
): Promise<SandboxExtraFile[]> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true },
  });
  if (!task?.envTemplateId) return [];

  const envTemplate = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.id, task.envTemplateId),
    columns: { declaredDeps: true, status: true },
  });
  if (!envTemplate || envTemplate.status !== 'ready') return [];

  const deps = envTemplate.declaredDeps as Record<string, unknown> | null;
  const servers = buildDefaultMcpServers({
    repoPath: sandboxWorkdir,
    includeChromeDevtools: !!deps?.browserTesting,
  });
  if (servers.length === 0) return [];

  const config = buildMcpConfigForCli(providerName, servers, SANDBOX_USER_HOME);
  if (!config) return [];

  return [{ containerPath: config.path, content: config.content }];
}

const REPO_VOLUME_NAME = 'haive_repos';
const REPO_MOUNT_TARGET = SANDBOX_WORKDIR;
const HOST_REPO_ROOT = process.env.HOST_REPO_ROOT ?? '/host-fs';
const HOST_REPO_ROOT_REAL = process.env.HOST_REPO_ROOT_REAL ?? process.env.HOME ?? '/';

export async function resolveTaskRepoMount(
  db: Database,
  taskId: string,
): Promise<DockerVolumeMount | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, repositoryId: true },
  });
  if (!task?.repositoryId) return null;

  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { source: true, storagePath: true, localPath: true },
  });
  if (!repo) return null;

  const storagePath = repo.storagePath ?? repo.localPath;

  // Local-path repos: storagePath starts with HOST_REPO_ROOT (e.g. /host-fs/...).
  // For Docker-in-Docker the sandbox needs a bind mount from the real host path.
  if (storagePath && storagePath.startsWith(HOST_REPO_ROOT + '/')) {
    const relativePart = storagePath.slice(HOST_REPO_ROOT.length);
    const hostPath = HOST_REPO_ROOT_REAL + relativePart;
    return {
      source: hostPath,
      target: REPO_MOUNT_TARGET,
      readOnly: true,
    };
  }

  // Volume-based repos (uploaded / cloned): use named volume with subpath
  return {
    source: REPO_VOLUME_NAME,
    target: REPO_MOUNT_TARGET,
    subpath: `${task.userId}/${task.repositoryId}`,
  };
}

export async function resolveTaskSandboxWorkdir(db: Database, taskId: string): Promise<string> {
  const row = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '01-worktree-setup'),
    ),
    columns: { output: true },
  });
  const output = row?.output as { sandboxWorktreePath?: string } | null;
  return output?.sandboxWorktreePath ?? SANDBOX_WORKDIR;
}

const STATUS_THROTTLE_MS = 2_000;
const STATUS_STALE_MS = 30_000;
const STATUS_DEFAULT_MESSAGE = 'Waiting for AI analysis...';

function createStepStatusUpdater(db: Database, taskStepId: string): (message: string) => void {
  let lastFlush = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMessage = '';

  const writeStatus = (message: string): void => {
    const truncated = message.length > 200 ? message.slice(0, 200) + '...' : message;
    lastFlush = Date.now();
    db.update(schema.taskSteps)
      .set({ statusMessage: truncated, updatedAt: new Date() })
      .where(eq(schema.taskSteps.id, taskStepId))
      .catch((err: unknown) => {
        log.warn({ err, taskStepId }, 'failed to update step status');
      });
  };

  const flush = (): void => {
    if (!lastMessage) return;
    writeStatus(lastMessage);
  };

  const resetStaleTimer = (): void => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      staleTimer = null;
      writeStatus(STATUS_DEFAULT_MESSAGE);
    }, STATUS_STALE_MS);
  };

  return (message: string): void => {
    lastMessage = message;
    resetStaleTimer();
    const now = Date.now();
    if (now - lastFlush >= STATUS_THROTTLE_MS) {
      if (pending) clearTimeout(pending);
      pending = null;
      flush();
    } else if (!pending) {
      pending = setTimeout(
        () => {
          pending = null;
          flush();
        },
        STATUS_THROTTLE_MS - (now - lastFlush),
      );
    }
  };
}

/* ------------------------------------------------------------------ */
/* NDJSON stream-json parser for Claude Code / Zai                     */
/* ------------------------------------------------------------------ */

interface StreamJsonCollector {
  /** Feed raw stdout chunks. Parses NDJSON lines, emits progress, collects result. */
  onChunk: (chunk: string) => void;
  /** Final result text extracted from the result/success event, or null. */
  getResult: () => string | null;
  /** Whether the stream contained valid NDJSON events (vs plain JSON output). */
  isStreamJson: () => boolean;
  /** Human-readable reason when the stream ended without a success result. */
  getNoResultReason: () => string | null;
}

export function createStreamJsonCollector(
  onProgress?: (message: string) => void,
): StreamJsonCollector {
  let buffer = '';
  let resultText: string | null = null;
  let eventCount = 0;
  let lastResultSubtype: string | null = null;
  let lastRateLimit: {
    status?: string;
    overageStatus?: string;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
  } | null = null;

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event.type !== 'string') return;
    eventCount++;

    const type = event.type as string;
    const subtype = event.subtype as string | undefined;

    if (type === 'rate_limit_event') {
      const info = event.rate_limit_info as typeof lastRateLimit;
      if (info) lastRateLimit = info;
    }

    // Extract final result
    if (type === 'result') {
      if (typeof subtype === 'string') lastResultSubtype = subtype;
      if (subtype === 'success' && typeof event.result === 'string') {
        resultText = event.result;
        return;
      }
    }

    if (!onProgress) return;

    // Extract progress from assistant messages (tool_use blocks)
    if (type === 'assistant') {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = msg?.content as unknown[] | undefined;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use') {
          const toolName = b.name as string;
          const input = b.input as Record<string, unknown> | undefined;
          const desc = describeToolUse(toolName, input);
          if (desc) onProgress(desc);
        }
        // Skip text blocks — they're final output, not progress.
        // For tool_use sessions, tool_use blocks provide the real progress.
      }
    }
  }

  return {
    onChunk(chunk: string): void {
      buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
      }
    },
    getResult(): string | null {
      // Process any remaining buffer content
      if (buffer.trim()) {
        processLine(buffer);
        buffer = '';
      }
      return resultText;
    },
    isStreamJson(): boolean {
      return eventCount > 0;
    },
    getNoResultReason(): string | null {
      if (resultText !== null) return null;
      if (eventCount === 0) return null;
      if (lastResultSubtype && lastResultSubtype !== 'success') {
        return `LLM stream ended with result subtype "${lastResultSubtype}"`;
      }
      if (lastRateLimit?.overageStatus === 'rejected' && lastRateLimit.isUsingOverage) {
        return `LLM blocked by rate limit (${lastRateLimit.overageDisabledReason ?? 'overage rejected'})`;
      }
      return 'LLM emitted no result event (stream ended prematurely — likely timeout, session abort, or quota rejection)';
    },
  };
}

function describeToolUse(name: string, input?: Record<string, unknown>): string | null {
  switch (name) {
    case 'Read':
    case 'read_file': {
      const filePath = (input?.file_path ?? input?.path) as string | undefined;
      return filePath ? `Reading ${filePath}` : `Reading file...`;
    }
    case 'Grep':
    case 'grep':
    case 'search': {
      const pattern = input?.pattern as string | undefined;
      return pattern ? `Searching for "${pattern}"` : 'Searching codebase...';
    }
    case 'Glob':
    case 'glob':
    case 'list_files': {
      const pat = input?.pattern as string | undefined;
      return pat ? `Finding files: ${pat}` : 'Finding files...';
    }
    case 'Write':
    case 'write_file':
    case 'Edit':
    case 'edit_file': {
      const filePath = (input?.file_path ?? input?.path) as string | undefined;
      return filePath ? `Editing ${filePath}` : 'Editing file...';
    }
    case 'Bash':
    case 'bash':
    case 'execute_command': {
      const cmd = input?.command as string | undefined;
      if (!cmd) return 'Running command...';
      const short = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
      return `Running: ${short}`;
    }
    default:
      return `Using ${name}...`;
  }
}

export async function resolveAuthMounts(
  db: Database,
  provider: CliProviderRecord,
  taskId: string,
): Promise<DockerVolumeMount[]> {
  const providerName = provider.name as CliProviderName;
  await assertUserAuthReady(db, provider);
  await ensureTaskAuthVolumes(provider.userId, providerName, taskId);

  // RTK seeding: when this task's repo opted into the token-saving proxy,
  // run rtk's own init flow inside the per-task auth volume so its hook
  // entries land in /home/node/.<cli>/settings.json (and the matching
  // RTK.md / @-ref artifacts). Best-effort — failures are logged inside
  // the seeder and don't block CLI execution. Project-level files written
  // by step 07 cover the case where the user's CLI ignores home settings.
  const taskRow = await db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  const repoId = taskRow[0]?.repositoryId ?? null;
  if (repoId) {
    const repoRow = await db
      .select({ rtkEnabled: schema.repositories.rtkEnabled })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repoId))
      .limit(1);
    if (repoRow[0]?.rtkEnabled) {
      await seedRtkInTaskVolume(taskId, providerName);
    }
  }

  return [...resolveTaskAuthMounts(providerName, taskId), ...resolveTaskSkillMounts(providerName)];
}

/**
 * Block CLI execution when a subscription-mode provider has no populated user
 * auth volume. Since the host `~/.<cli>` is no longer mounted into sandboxes,
 * an absent user volume means no credentials — the CLI would silently 401.
 *
 * When blocking, also flip a stale `auth_status=ok` row to `unknown` so the UI
 * prompts the user to run the Haive CLI login flow instead of silently failing
 * future runs.
 */
/**
 * Thrown by `assertUserAuthReady` when a subscription-auth CLI has no
 * populated user auth volume. Carries a structured hint so the UI can render
 * an inline "Log in to <provider>" button that triggers the Haive login flow
 * and auto-retries the step after successful login.
 */
export class CliLoginRequiredError extends Error {
  readonly hint: StepErrorHint;
  constructor(message: string, hint: StepErrorHint) {
    super(message);
    this.name = 'CliLoginRequiredError';
    this.hint = hint;
  }
}

async function assertUserAuthReady(db: Database, provider: CliProviderRecord): Promise<void> {
  if (provider.authMode !== 'subscription') return;
  const providerName = provider.name as CliProviderName;
  const hasVolume = await userAuthVolumeExists(provider.userId, providerName);
  if (hasVolume) return;

  if (provider.authStatus === 'ok') {
    await db
      .update(schema.cliProviders)
      .set({
        authStatus: 'unknown',
        authMessage: 'User auth volume missing — log in to this CLI from the Haive providers page.',
        authLastCheckedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
  }

  throw new CliLoginRequiredError(
    `${provider.name}: not logged in — click "Log in to ${provider.name}" to populate the auth volume and retry.`,
    {
      type: 'cli_login_required',
      providerId: provider.id,
      providerName,
    },
  );
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

  const fresh = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, provider.id),
    columns: { sandboxImageBuildStatus: true },
  });
  if (fresh?.sandboxImageBuildStatus === 'building') {
    throw new Error('sandbox image build is in progress, please wait for it to finish and retry');
  }

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

export async function resolveSandboxImageTag(
  db: Database,
  taskId: string | null,
  provider: {
    id: string;
    userId: string;
    name: string;
    cliVersion: string | null;
    sandboxDockerfileExtra: string | null;
  },
): Promise<string | null> {
  if (taskId) {
    const composedTag = await ensureComposedImage(db, taskId, {
      name: provider.name as CliProviderName,
      cliVersion: provider.cliVersion?.trim() || null,
      sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
    });
    if (composedTag) return composedTag;
  }
  return ensureProviderSandboxImage(db, provider);
}

async function executeCliSpec(
  spec: CliCommandSpec,
  deps: CliExecDeps,
  timeoutMs?: number,
  secrets: Record<string, string> = {},
  wrapperContent: string | null = null,
  sandboxImage: string | null = null,
  repoMount: DockerVolumeMount | null = null,
  sandboxWorkdir: string = SANDBOX_WORKDIR,
  networkPolicy: CliNetworkPolicy | null = null,
  extraFiles: SandboxExtraFile[] = [],
  authMounts: DockerVolumeMount[] = [],
  statusCallback?: (message: string) => void,
): Promise<ExecutionOutcome> {
  const mergedSpec: CliCommandSpec = {
    ...spec,
    env: { ...spec.env, ...secrets },
  };
  const spawner: CliSpawner = createSandboxSpawner(
    wrapperContent,
    sandboxImage,
    repoMount,
    sandboxWorkdir,
    networkPolicy,
    extraFiles,
    authMounts,
  );

  // Hook stdout for NDJSON stream-json parsing (Claude Code / Zai)
  const collector = createStreamJsonCollector(statusCallback);
  const result = await spawner(mergedSpec, {
    timeoutMs,
    onStdoutChunk: collector.onChunk,
  });
  void deps;

  const streamResult = collector.getResult();
  if (collector.isStreamJson() && streamResult !== null) {
    return {
      exitCode: result.exitCode,
      rawOutput: streamResult,
      parsedOutput: tryJsonParse(streamResult),
      errorMessage: formatCliErrorMessage(
        result.exitCode,
        result.stderr,
        streamResult,
        result.error,
      ),
    };
  }

  if (collector.isStreamJson() && streamResult === null) {
    const reason = collector.getNoResultReason() ?? 'LLM emitted no result event';
    return {
      exitCode: result.exitCode,
      rawOutput: result.stdout,
      parsedOutput: null,
      errorMessage:
        result.error ??
        formatCliErrorMessage(result.exitCode, result.stderr, result.stdout, undefined) ??
        reason,
    };
  }

  return {
    exitCode: result.exitCode,
    rawOutput: result.stdout,
    parsedOutput: tryJsonParse(result.stdout),
    errorMessage: formatCliErrorMessage(
      result.exitCode,
      result.stderr,
      result.stdout,
      result.error,
    ),
  };
}

/**
 * Build a user-facing error message for a CLI invocation.
 *
 * Surfaces content in priority order: spawn error (timeout, crash) → stderr tail
 * → stdout tail. Stdout fallback catches cases where CLIs like Claude Code or
 * Z.AI emit the API error on stdout (e.g. "API Error: {...code:500}") and exit
 * non-zero with empty stderr.
 */
export function formatCliErrorMessage(
  exitCode: number | null,
  stderr: string,
  stdout: string,
  spawnError: string | undefined,
): string | null {
  if (spawnError) return spawnError;
  if (exitCode === 0) return null;
  const stderrTail = stderr.trim();
  if (stderrTail.length > 0) return stderrTail.slice(-2000);
  const stdoutTail = stdout.trim();
  if (stdoutTail.length > 0) return stdoutTail.slice(-2000);
  return `cli exited with code ${exitCode ?? 'unknown'}`;
}

function createSandboxSpawner(
  wrapperContent: string | null | undefined,
  sandboxImage: string | null = null,
  repoMount: DockerVolumeMount | null = null,
  sandboxWorkdir: string = SANDBOX_WORKDIR,
  networkPolicy: CliNetworkPolicy | null = null,
  extraFiles: SandboxExtraFile[] = [],
  authMounts: DockerVolumeMount[] = [],
): CliSpawner {
  return async (spec, opts: SpawnOptions = {}): Promise<CliExecutionResult> => {
    const allMounts: DockerVolumeMount[] = [...authMounts];
    if (repoMount) allMounts.push(repoMount);
    const runnerOptions: Parameters<typeof runInSandbox>[1] = { workdir: sandboxWorkdir };
    if (sandboxImage) runnerOptions.image = sandboxImage;
    if (allMounts.length > 0) runnerOptions.extraMounts = allMounts;
    if (networkPolicy) runnerOptions.networkPolicy = networkPolicy;
    const result = await runInSandbox(
      {
        command: spec.command,
        args: spec.args,
        env: spec.env,
        wrapperContent: wrapperContent ?? undefined,
        extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
        timeoutMs: opts.timeoutMs,
        onStdoutChunk: opts.onStdoutChunk,
        onStderrChunk: opts.onStderrChunk,
        signal: opts.signal,
      },
      runnerOptions,
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
  repoMount: DockerVolumeMount | null,
  sandboxWorkdir: string,
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
    cwd: sandboxWorkdir,
    extraEnv: secrets,
  });
  const sandboxImage = await resolveSandboxImageTag(db, payload.taskId, provider);
  const mcpFiles = await resolveMcpExtraFiles(
    db,
    payload.taskId,
    provider.name as CliProviderName,
    sandboxWorkdir,
  );
  const authMounts = await resolveAuthMounts(db, provider, payload.taskId);
  return executeCliSpec(
    spec,
    deps,
    payload.timeoutMs,
    secrets,
    provider.wrapperContent,
    sandboxImage,
    repoMount,
    sandboxWorkdir,
    provider.networkPolicy,
    mcpFiles,
    authMounts,
  );
}

async function executeSubAgentSequential(
  db: Database,
  payload: CliExecJobPayload,
  secrets: Record<string, string>,
  repoMount: DockerVolumeMount | null,
  sandboxWorkdir: string,
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

  const sandboxImage = await resolveSandboxImageTag(db, payload.taskId, provider);
  const mcpFiles = await resolveMcpExtraFiles(
    db,
    payload.taskId,
    provider.name as CliProviderName,
    sandboxWorkdir,
  );
  const authMounts = await resolveAuthMounts(db, provider, payload.taskId);
  const spawner = createSandboxSpawner(
    provider.wrapperContent,
    sandboxImage,
    repoMount,
    sandboxWorkdir,
    provider.networkPolicy,
    mcpFiles,
    authMounts,
  );
  const result: SubAgentRunResult = await runSequentialSubAgent(
    invocation,
    (prompt) =>
      adapter.buildCliInvocation(provider, prompt, {
        cwd: sandboxWorkdir,
        extraEnv: secrets,
      }),
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
  _success: boolean,
  _errorMessage: string | null,
): Promise<void> {
  if (!payload.taskStepId) return;
  const db = getDb();
  const stepRow = await db.query.taskSteps.findFirst({
    where: eq(schema.taskSteps.id, payload.taskStepId),
    columns: { stepId: true },
  });
  const taskPayload: TaskJobPayload = {
    taskId: payload.taskId,
    userId: payload.userId,
    stepId: stepRow?.stepId,
  };
  const queue = getTaskQueue();
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
    result.cli = await probeCliPath(db, adapter, provider, secrets);
  }

  if (wantApi) {
    result.api = await probeApiPath(adapter, provider, secrets);
  }

  const cliOk = !wantCli || result.cli?.ok === true;
  const apiOk = !wantApi || result.api?.ok === true;
  result.ok = cliOk && apiOk;

  if (wantCli && result.cli?.authStatus) {
    await db
      .update(schema.cliProviders)
      .set({
        authStatus: result.cli.authStatus,
        authMessage: result.cli.authMessage ?? null,
        authLastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
  }

  return result;
}

async function probeCliPath(
  db: Database,
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  secrets: Record<string, string> = {},
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
  let authMounts: Awaited<ReturnType<typeof resolveCliAuthMounts>> = [];
  if (isAuthProbeSupported(provider.name)) {
    authMounts = resolveCliAuthMounts(provider.userId, provider.name, { writable: true });
  }
  const spawner = createSandboxSpawner(
    provider.wrapperContent,
    sandboxImage,
    null,
    SANDBOX_WORKDIR,
    null,
    [],
    authMounts,
  );
  try {
    const versionResult = await spawner(
      {
        command: resolvedCommand,
        args: ['--version'],
        env: provider.envVars ?? {},
      },
      { timeoutMs: 15_000 },
    );
    if (versionResult.exitCode !== 0) {
      const error =
        versionResult.error ??
        (versionResult.stderr.trim() ||
          `exit ${versionResult.exitCode ?? 'unknown'} from sandbox probe`);
      return { ok: false, error, durationMs: Date.now() - startedAt };
    }
    const versionDetail =
      versionResult.stdout.trim() || versionResult.stderr.trim() || 'binary reachable';

    if (!isAuthProbeSupported(provider.name)) {
      return { ok: true, detail: versionDetail, durationMs: Date.now() - startedAt };
    }

    const authSpec = buildAuthProbeCommand(provider, resolvedCommand);
    const authResult = await spawner(
      {
        command: authSpec.command,
        args: authSpec.args,
        env: { ...authSpec.env, ...secrets },
      },
      { timeoutMs: 25_000 },
    );
    const classification = classifyAuthProbeOutput({
      stdout: authResult.stdout,
      stderr: authResult.stderr,
      exitCode: authResult.exitCode ?? -1,
      timedOut: authResult.timedOut,
    });
    const durationMs = Date.now() - startedAt;
    if (classification.status === 'ok') {
      return {
        ok: true,
        detail: versionDetail,
        durationMs,
        authStatus: 'ok',
        authMessage: classification.message,
      };
    }
    return {
      ok: false,
      detail: versionDetail,
      error: classification.message,
      durationMs,
      authStatus: classification.status,
      authMessage: classification.message,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

function resolveProviderExecutable(adapter: BaseCliAdapter, provider: CliProviderRecord): string {
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

export async function removeOrphanedPreviousImage(
  db: Database,
  args: { providerId: string; previousDbTag: string | null; newTag: string },
  runner: DockerRunner = defaultDockerRunner,
): Promise<{
  removed: boolean;
  reason: 'no-previous' | 'same-tag' | 'still-in-use' | 'missing' | 'remove-failed' | 'removed';
}> {
  const { previousDbTag, newTag, providerId } = args;
  if (!previousDbTag) return { removed: false, reason: 'no-previous' };
  if (previousDbTag === newTag) return { removed: false, reason: 'same-tag' };
  const stillInUse = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.sandboxImageTag, previousDbTag),
    columns: { id: true },
  });
  if (stillInUse) {
    log.info(
      { providerId, previousDbTag, newTag, otherProviderId: stillInUse.id },
      'keeping previous sandbox image, still referenced by another provider',
    );
    return { removed: false, reason: 'still-in-use' };
  }
  const inspected = await runner.inspect(previousDbTag);
  if (!inspected.exists) return { removed: false, reason: 'missing' };
  const removeResult = await runner.remove(previousDbTag);
  if (removeResult.ok) {
    log.info({ providerId, previousDbTag, newTag }, 'removed orphaned previous sandbox image');
    return { removed: true, reason: 'removed' };
  }
  log.warn(
    {
      providerId,
      previousDbTag,
      newTag,
      stderr: removeResult.stderr,
      error: removeResult.error,
    },
    'failed to remove orphaned previous sandbox image',
  );
  return { removed: false, reason: 'remove-failed' };
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
  const previousDbTag = provider.sandboxImageTag;

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
      await removeOrphanedPreviousImage(db, {
        providerId: provider.id,
        previousDbTag,
        newTag: imageTag,
      });
      log.info({ providerId: provider.id, imageTag, shared }, 'sandbox image cache hit');
      return { ok: true, providerId: provider.id, imageTag };
    }
  }

  const previousInspect = await defaultDockerRunner.inspect(imageTag);
  const previousImageId = previousInspect.exists ? previousInspect.imageId : null;

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
      await removeOrphanedPreviousImage(db, {
        providerId: provider.id,
        previousDbTag,
        newTag: imageTag,
      });
      if (previousImageId && result.imageId && previousImageId !== result.imageId) {
        const removeResult = await defaultDockerRunner.remove(previousImageId);
        if (!removeResult.ok) {
          log.warn(
            {
              providerId: provider.id,
              imageTag,
              previousImageId,
              stderr: removeResult.stderr,
              error: removeResult.error,
            },
            'failed to remove previous sandbox image',
          );
        } else {
          log.info(
            { providerId: provider.id, imageTag, previousImageId },
            'removed previous sandbox image',
          );
        }
      }
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

export async function handleLoginCreateJob(
  db: Database,
  payload: CliLoginCreateJobPayload,
): Promise<CliLoginCreateResult> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
  });
  if (!provider) return { ok: false, error: 'provider not found' };
  if (provider.userId !== payload.userId) {
    return { ok: false, error: 'provider not owned by user' };
  }
  if (!cliAdapterRegistry.has(provider.name)) {
    return { ok: false, error: `no adapter registered for ${provider.name}` };
  }

  const adapter = cliAdapterRegistry.get(provider.name);
  const executable =
    provider.wrapperPath?.trim() || provider.executablePath?.trim() || adapter.defaultExecutable;

  let commandSpec;
  try {
    commandSpec = buildSetupTokenCommand(provider, executable);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const Docker = (await import('dockerode')).default;
    const docker = new Docker();
    const created = await createSandboxLoginContainer(db, {
      provider,
      commandSpec,
      docker,
    });
    return {
      ok: true,
      containerRowId: created.containerRowId,
      dockerContainerId: created.dockerContainerId,
    };
  } catch (err) {
    log.error({ err, providerId: provider.id }, 'login container create failed');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
  | CliProbeResult
  | SandboxImageBuildResult
  | RefreshCliVersionsJobResult
  | CliLoginCreateResult
  | void
> {
  const worker = new Worker<
    CliExecQueuePayload,
    | CliProbeResult
    | SandboxImageBuildResult
    | RefreshCliVersionsJobResult
    | CliLoginCreateResult
    | void
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
      if (job.name === CLI_EXEC_JOB_NAMES.LOGIN_CREATE) {
        return handleLoginCreateJob(db, job.data as CliLoginCreateJobPayload);
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
