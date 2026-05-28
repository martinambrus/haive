import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  type CliExecJobPayload,
  type CliNetworkPolicy,
  type CliProviderName,
  type TaskJobPayload,
  TASK_JOB_NAMES,
} from '@haive/shared';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import {
  SANDBOX_WORKDIR,
  SANDBOX_USER_HOME,
  type SandboxExtraFile,
} from '../../sandbox/sandbox-runner.js';
import {
  buildDefaultMcpServers,
  buildMcpConfigForCli,
  serversToJsonObject,
} from '../../sandbox/mcp-config.js';
import { RAG_MCP_SERVER_JS, RAG_MCP_SERVER_PATH } from '../../sandbox/rag-mcp-server.js';
import { signRagToken } from '@haive/shared/rag';
import type { CliProviderRecord } from '../../cli-adapters/types.js';
import {
  ensureTaskAuthVolumes,
  mergeGeminiMcpIntoSettings,
  resolveTaskAuthMounts,
  resolveTaskSkillMounts,
  seedRtkInTaskVolume,
  userAuthVolumeExists,
} from '../../sandbox/task-auth-volume.js';
import { getDb } from '../../db.js';
import { getTaskQueue } from '../task-queue.js';
import { CliLoginRequiredError, log } from './_shared.js';
import { resolveSandboxImageTag } from './images.js';

export async function resolveProviderNameForPayload(
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

interface ProviderRuntimeConfig {
  wrapperContent: string | null;
  sandboxImage: string | null;
  networkPolicy: CliNetworkPolicy | null;
}

export async function loadProviderRuntimeConfig(
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

export interface McpResolution {
  files: SandboxExtraFile[];
  /** CLI args the caller must append to spec.args so the binary actually
   *  loads the bind-mounted MCP config (e.g. claude-code's `--mcp-config`). */
  extraArgs: string[];
}

/** Resolve whether the haive-rag MCP server should be wired for this task,
 *  and mint its task-scoped token. Gated on the step-04 ragMode (independent of
 *  the chrome-devtools/envTemplate path), so RAG retrieval is available to
 *  agents whenever the project has a populated index. */
async function resolveRagMcpConfig(
  db: Database,
  taskId: string,
): Promise<{ enabled: boolean; apiUrl: string; token: string }> {
  const disabled = { enabled: false, apiUrl: '', token: '' };
  const toolingStep = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
    ),
    columns: { output: true },
  });
  const ragMode = (toolingStep?.output as { tooling?: { ragMode?: string } } | null)?.tooling
    ?.ragMode;
  if (!ragMode || ragMode === 'none') return disabled;

  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret) {
    log.warn({ taskId }, 'CONFIG_ENCRYPTION_KEY unset; haive-rag MCP disabled');
    return disabled;
  }
  // Sandbox -> API base URL. Defaults to the compose service name; override via
  // RAG_API_INTERNAL_URL when the sandbox reaches the API by another route
  // (e.g. host.docker.internal). Under networkPolicy 'allowlist' this host must
  // be allowlisted; under 'none' the proxy cannot reach the API and rag_search
  // will report a request failure (agents then fall through to KB/LSP/GREP).
  const apiUrl = process.env.RAG_API_INTERNAL_URL || 'http://api:3001';
  return { enabled: true, apiUrl, token: signRagToken(taskId, secret) };
}

/** Load the user's custom MCP servers (the `mcpServers` object from the repo's
 *  `.claude/mcp_settings.json`) so they can be merged additively into the
 *  generated runtime config. Sourced from the step-04 tooling output — this
 *  task's own if present, else the repository's most recent onboarding run —
 *  which is the canonical record of what was written to mcp_settings.json. */
async function loadUserMcpServers(db: Database, taskId: string): Promise<Record<string, unknown>> {
  const parse = (output: unknown): Record<string, unknown> | null => {
    const raw = (output as { tooling?: { mcpSettingsJson?: string } } | null)?.tooling
      ?.mcpSettingsJson;
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
      const obj = JSON.parse(raw) as { mcpServers?: unknown };
      return obj && typeof obj.mcpServers === 'object' && obj.mcpServers
        ? (obj.mcpServers as Record<string, unknown>)
        : {};
    } catch {
      return null;
    }
  };

  const own = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
    ),
    columns: { output: true },
  });
  const fromOwn = parse(own?.output);
  if (fromOwn) return fromOwn;

  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  if (!task?.repositoryId) return {};
  const rows = await db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.taskSteps.taskId, schema.tasks.id))
    .where(
      and(
        eq(schema.tasks.repositoryId, task.repositoryId),
        eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
      ),
    )
    .orderBy(desc(schema.taskSteps.createdAt))
    .limit(1);
  return parse(rows[0]?.output) ?? {};
}

export async function resolveMcpExtraFiles(
  db: Database,
  taskId: string,
  providerName: CliProviderName,
  sandboxWorkdir: string,
): Promise<McpResolution> {
  const empty: McpResolution = { files: [], extraArgs: [] };

  // chrome-devtools is gated on a ready envTemplate with browserTesting.
  let includeChromeDevtools = false;
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true },
  });
  if (task?.envTemplateId) {
    const envTemplate = await db.query.envTemplates.findFirst({
      where: eq(schema.envTemplates.id, task.envTemplateId),
      columns: { declaredDeps: true, status: true },
    });
    if (envTemplate && envTemplate.status === 'ready') {
      const deps = envTemplate.declaredDeps as Record<string, unknown> | null;
      includeChromeDevtools = !!deps?.browserTesting;
    }
  }

  const rag = await resolveRagMcpConfig(db, taskId);

  const servers = buildDefaultMcpServers({
    repoPath: sandboxWorkdir,
    includeChromeDevtools,
    includeRagSearch: rag.enabled,
    ragServerPath: RAG_MCP_SERVER_PATH,
    ragApiUrl: rag.apiUrl,
    ragToken: rag.token,
  });

  // User's custom MCP servers (.claude/mcp_settings.json) merged additively so
  // the generated --strict-mcp-config bundle doesn't shadow them. Haive's
  // reserved servers win on name collision (see serversToJsonObject).
  const userServers = await loadUserMcpServers(db, taskId);

  if (servers.length === 0 && Object.keys(userServers).length === 0) return empty;

  // The haive-rag proxy is a bind-mounted script run via `node`; ship it
  // whenever rag is enabled so the MCP server command resolves.
  const ragFiles: SandboxExtraFile[] = rag.enabled
    ? [{ containerPath: RAG_MCP_SERVER_PATH, content: RAG_MCP_SERVER_JS }]
    : [];

  // Gemini reads MCP servers from the SAME settings.json that holds
  // `selectedAuthType`. Bind-mounting an MCP-only file at that path
  // overlays — and obscures — the auth volume's settings.json, leaving
  // the CLI without an auth method. Merge the MCP servers into the
  // task auth volume in-place instead, so the auth fields survive.
  if (providerName === 'gemini') {
    await mergeGeminiMcpIntoSettings(taskId, serversToJsonObject(servers, userServers));
    return { files: ragFiles, extraArgs: [] };
  }

  const config = buildMcpConfigForCli(providerName, servers, SANDBOX_USER_HOME, userServers);
  if (!config) return empty;

  return {
    files: [{ containerPath: config.path, content: config.content }, ...ragFiles],
    extraArgs: config.cliArgs ?? [],
  };
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

const WORKER_REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
const CHOWN_MARKER_REL = '.haive/.chowned-1000';

/** chown the repo-volume subpath for a task to 1000:1000 (the `node` user
 *  the sandbox CLI runs as). Named volumes default to root-owned content,
 *  and the sandbox runs CLIs as `node` (sandbox-runner.ts), so any LLM that
 *  tries to write into `.claude/`, `.gemini/`, `.codex/`, etc. inside the
 *  workdir fails with EACCES and may pivot to writing under `/tmp/` instead,
 *  losing the artifacts. Idempotent: writes a marker file at
 *  `.haive/.chowned-1000` and skips on subsequent invocations. Bind-mounted
 *  local-path repos are skipped — they're mounted read-only and chowning
 *  would mutate the user's host filesystem. */
export async function ensureRepoMountWritable(repoMount: DockerVolumeMount | null): Promise<void> {
  if (!repoMount) return;
  if (repoMount.source !== REPO_VOLUME_NAME) return;
  if (!repoMount.subpath) return;

  const workerVolumePath = join(WORKER_REPO_STORAGE_ROOT, repoMount.subpath);
  const markerPath = join(workerVolumePath, CHOWN_MARKER_REL);

  try {
    await access(markerPath);
    return;
  } catch {
    // not yet chowned — fall through
  }

  try {
    await execFileAsync('chown', ['-R', '1000:1000', workerVolumePath]);
    await mkdir(join(workerVolumePath, '.haive'), { recursive: true });
    await writeFile(markerPath, '', 'utf8');
    await execFileAsync('chown', ['1000:1000', join(workerVolumePath, '.haive'), markerPath]);
    log.info({ workerVolumePath }, 'chowned repo volume to node user (1000:1000)');
  } catch (err) {
    log.warn(
      { err, workerVolumePath },
      'failed to chown repo volume to node user — CLI writes to .claude/.gemini/ may fail',
    );
  }
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

export function createStepStatusUpdater(
  db: Database,
  taskStepId: string,
): (message: string) => void {
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

export async function resolveAuthMounts(
  db: Database,
  provider: CliProviderRecord,
  taskId: string,
): Promise<DockerVolumeMount[]> {
  const providerName = provider.name as CliProviderName;
  await assertUserAuthReady(db, provider);
  await ensureTaskAuthVolumes(
    {
      userId: provider.userId,
      providerId: provider.id,
      providerName,
      isolateAuth: provider.isolateAuth,
    },
    taskId,
  );

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
async function assertUserAuthReady(db: Database, provider: CliProviderRecord): Promise<void> {
  if (provider.authMode !== 'subscription') return;
  const providerName = provider.name as CliProviderName;
  const hasVolume = await userAuthVolumeExists({
    userId: provider.userId,
    providerId: provider.id,
    providerName,
    isolateAuth: provider.isolateAuth,
  });
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

export function tryJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export async function resumeStepIfLinked(
  payload: CliExecJobPayload,
  _success: boolean,
  _errorMessage: string | null,
): Promise<void> {
  if (!payload.taskStepId) return;
  const db = getDb();
  // If this cli_invocation was superseded (retry-cascade reset the step
  // mid-CLI), do NOT enqueue an advance — the step has already been reset
  // and is being driven by the retry's own enqueue. Spurious advances here
  // re-run detect/form on the freshly-reset step, leaving it in
  // `waiting_form` alongside the retried-from step (visual "two active
  // steps" glitch).
  const inv = await db.query.cliInvocations.findFirst({
    where: eq(schema.cliInvocations.id, payload.invocationId),
    columns: { supersededAt: true },
  });
  if (inv?.supersededAt) {
    log.info(
      { invocationId: payload.invocationId, taskStepId: payload.taskStepId },
      'cli invocation superseded, skipping resumeStepIfLinked',
    );
    return;
  }
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
