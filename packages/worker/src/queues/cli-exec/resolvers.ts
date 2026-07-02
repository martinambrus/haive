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
  isReadOnlyLocalRepo,
  CONFIG_KEYS,
  configService,
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
import { DDEV_MCP_SERVER_JS, DDEV_MCP_SERVER_PATH } from '../../sandbox/ddev-mcp-server.js';
import { runnerBrowserCdpUrl } from '../../sandbox/ddev-runner.js';
import { appRunnerBrowserCdpUrl } from '../../sandbox/app-runner.js';
import { signRagToken } from '@haive/shared/rag';
import { cliAdapterRegistry } from '../../cli-adapters/registry.js';
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
  /** Effective egress allow-set for the CLI's own model/auth servers: the
   *  adapter's declared defaults ∪ the provider's user-added extras. */
  egressDomains: string[];
}

/** Effective egress = adapter-declared model/auth domains ∪ the provider's
 *  user-added extras. Defaults are always re-applied, so a future default
 *  addition auto-applies and clearing the extras can't strand the CLI from its
 *  model. Shared by the cli/agent_mining path and both sub-agent paths. */
export function resolveEffectiveEgressDomains(provider: {
  name: CliProviderName;
  egressDomains?: string[] | null;
}): string[] {
  const defaults = cliAdapterRegistry.has(provider.name)
    ? cliAdapterRegistry.get(provider.name).defaultEgressDomains
    : [];
  return [...new Set([...defaults, ...(provider.egressDomains ?? [])])];
}

export async function loadProviderRuntimeConfig(
  db: Database,
  providerId?: string | null,
  taskId?: string | null,
): Promise<ProviderRuntimeConfig> {
  if (!providerId) {
    return { wrapperContent: null, sandboxImage: null, networkPolicy: null, egressDomains: [] };
  }
  const row = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, providerId),
  });
  if (!row) {
    return { wrapperContent: null, sandboxImage: null, networkPolicy: null, egressDomains: [] };
  }
  const sandboxImage = await resolveSandboxImageTag(db, taskId ?? null, row);
  return {
    wrapperContent: row.wrapperContent ?? null,
    sandboxImage,
    networkPolicy: await resolveTaskEgressOverride(db, taskId, row.networkPolicy),
    egressDomains: resolveEffectiveEgressDomains(row),
  };
}

/** Per-task egress override (plan §5.3). A task may carry `metadata.egress` (a
 *  CliNetworkPolicy) to override its provider's default network policy for THIS
 *  task only — used by kb_author enrichment so the author picks repo-only /
 *  specific-domains / full web access per article. Strictly opt-in: when absent,
 *  the provider policy is returned unchanged, so no other task's behaviour
 *  shifts. The provider's egressDomains (model/auth) are still applied on top, so
 *  the CLI can always reach its own model even under a 'none' override. */
async function resolveTaskEgressOverride(
  db: Database,
  taskId: string | null | undefined,
  providerPolicy: CliNetworkPolicy | null,
): Promise<CliNetworkPolicy | null> {
  if (!taskId) return providerPolicy;
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { metadata: true },
  });
  const override = (task?.metadata as { egress?: CliNetworkPolicy } | null)?.egress;
  return override ?? providerPolicy;
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
  const readRagMode = (output: unknown): string | undefined =>
    (output as { tooling?: { ragMode?: string } } | null)?.tooling?.ragMode;

  // ragMode from the task's OWN step-04 output, else the repo's most recent
  // onboarding step-04 output. Workflow tasks have no 04-tooling-infrastructure
  // step of their own, so without this fallback RAG retrieval would never be
  // wired for them even when onboarding configured it (mirrors the repo
  // fallback in loadUserMcpServers below).
  const ownStep = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
    ),
    columns: { output: true },
  });
  let ragMode = readRagMode(ownStep?.output);
  if (!ragMode) {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true },
    });
    if (task?.repositoryId) {
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
      ragMode = readRagMode(rows[0]?.output);
    }
  }
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

const CDP_PROBE_ATTEMPTS = 3;
const CDP_PROBE_RETRY_MS = 2_000;

/** Resolve the task runner's live headed-browser CDP URL, retrying briefly so a
 *  runner whose desktop is still finishing bring-up (e.g. just recovered after a
 *  worker restart) is connected to rather than prematurely abandoned to the headless
 *  fallback. Returns the first URL that answers, or undefined. Each probe is a single
 *  fast docker-exec curl and only the runner type the task actually has can answer,
 *  so once the desktop is up this returns on the first attempt with no added latency. */
async function resolveRunnerBrowserCdpUrl(taskId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < CDP_PROBE_ATTEMPTS; attempt += 1) {
    const url = (await runnerBrowserCdpUrl(taskId)) ?? (await appRunnerBrowserCdpUrl(taskId));
    if (url) return url;
    if (attempt < CDP_PROBE_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, CDP_PROBE_RETRY_MS));
    }
  }
  return undefined;
}

export async function resolveMcpExtraFiles(
  db: Database,
  taskId: string,
  providerName: CliProviderName,
  sandboxWorkdir: string,
  /** Restrict the MCP surface to the haive-rag server only — no chrome-devtools
   *  and no user MCP servers. Used for knowledge-mining invocations, which are
   *  read-only analysis and should reach nothing but rag_search. */
  ragOnly = false,
): Promise<McpResolution> {
  const empty: McpResolution = { files: [], extraArgs: [] };

  // chrome-devtools is gated on a ready envTemplate with browserTesting.
  let includeChromeDevtools = false;
  let chromeDevtoolsMcpVersion: string | null = null;
  // ddev-control is gated on the task being a DDEV task (declared container tool).
  let isDdevTask = false;
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true },
  });
  if (!ragOnly && task?.envTemplateId) {
    const envTemplate = await db.query.envTemplates.findFirst({
      where: eq(schema.envTemplates.id, task.envTemplateId),
      columns: { declaredDeps: true, status: true },
    });
    if (envTemplate && envTemplate.status === 'ready') {
      const deps = envTemplate.declaredDeps as Record<string, unknown> | null;
      includeChromeDevtools = !!deps?.browserTesting;
      isDdevTask = deps?.containerTool === 'ddev';
      // Operative chrome-devtools-mcp pin for this repo (null = latest).
      chromeDevtoolsMcpVersion =
        (deps?.chromeDevtoolsMcpVersion as string | null | undefined) ?? null;
    }
  }

  // ddev-control MCP: enabled for a DDEV task when the global kill-switch is on and a
  // secret is present to mint the task token. Not for rag-only (mining) invocations —
  // isDdevTask is only set inside the !ragOnly branch above.
  const ddevSecret = process.env.CONFIG_ENCRYPTION_KEY;
  const ddevControlEnabled =
    isDdevTask &&
    !!ddevSecret &&
    (await configService.getBoolean(CONFIG_KEYS.DDEV_CONTROL_MCP_ENABLED, true));
  const ddevToken = ddevControlEnabled ? signRagToken(taskId, ddevSecret as string) : '';
  const ddevApiUrl =
    process.env.DDEV_API_INTERNAL_URL || process.env.RAG_API_INTERNAL_URL || 'http://api:3001';

  const rag = await resolveRagMcpConfig(db, taskId);

  // When chrome-devtools is on AND the task's runner has a live headed browser
  // (interactive/mcp testing), connect the agent to THAT visible browser instead
  // of self-launching an isolated headless one — so it co-drives what the user
  // watches in the VNC panel.
  const chromeDevtoolsBrowserUrl = includeChromeDevtools
    ? await resolveRunnerBrowserCdpUrl(taskId)
    : undefined;

  const servers = buildDefaultMcpServers({
    repoPath: sandboxWorkdir,
    includeChromeDevtools,
    chromeDevtoolsBrowserUrl,
    chromeDevtoolsMcpVersion,
    includeRagSearch: rag.enabled,
    ragServerPath: RAG_MCP_SERVER_PATH,
    ragApiUrl: rag.apiUrl,
    ragToken: rag.token,
    includeDdevControl: ddevControlEnabled,
    ddevControlServerPath: DDEV_MCP_SERVER_PATH,
    ddevApiUrl,
    ddevToken,
  });

  // User's custom MCP servers (.claude/mcp_settings.json) merged additively so
  // the generated --strict-mcp-config bundle doesn't shadow them. Haive's
  // reserved servers win on name collision (see serversToJsonObject). Skipped
  // entirely for rag-only (mining) invocations so they reach nothing but RAG.
  const userServers = ragOnly ? {} : await loadUserMcpServers(db, taskId);

  if (servers.length === 0 && Object.keys(userServers).length === 0) return empty;

  // The haive-rag proxy is a bind-mounted script run via `node`; ship it
  // whenever rag is enabled so the MCP server command resolves.
  const ragFiles: SandboxExtraFile[] = rag.enabled
    ? [{ containerPath: RAG_MCP_SERVER_PATH, content: RAG_MCP_SERVER_JS }]
    : [];
  const ddevFiles: SandboxExtraFile[] = ddevControlEnabled
    ? [{ containerPath: DDEV_MCP_SERVER_PATH, content: DDEV_MCP_SERVER_JS }]
    : [];

  // Gemini reads MCP servers from the SAME settings.json that holds
  // `selectedAuthType`. Bind-mounting an MCP-only file at that path
  // overlays — and obscures — the auth volume's settings.json, leaving
  // the CLI without an auth method. Merge the MCP servers into the
  // task auth volume in-place instead, so the auth fields survive.
  if (providerName === 'gemini') {
    await mergeGeminiMcpIntoSettings(taskId, serversToJsonObject(servers, userServers));
    return { files: [...ragFiles, ...ddevFiles], extraArgs: [] };
  }

  const config = buildMcpConfigForCli(providerName, servers, SANDBOX_USER_HOME, userServers);
  if (!config) return empty;

  return {
    files: [{ containerPath: config.path, content: config.content }, ...ragFiles, ...ddevFiles],
    extraArgs: config.cliArgs ?? [],
  };
}

const REPO_VOLUME_NAME = 'haive_repos';
const REPO_MOUNT_TARGET = SANDBOX_WORKDIR;
export const HOST_REPO_ROOT = process.env.HOST_REPO_ROOT ?? '/host-fs';
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

/** Resolve the workdir mount for a standalone (taskless) repository terminal.
 *  Mirrors resolveTaskRepoMount but keyed on a repositoryId and mounted
 *  WRITABLE so the user can edit/commit/push. Returns null when the repo is not
 *  owned by the user, isn't ready, or is a read-only local-path repo — those
 *  are bound read-only end to end (host fs is `:ro` in the worker) so they
 *  cannot support a write/commit terminal. Writable-local repos live in the
 *  volume and DO get a mount. The caller rejects on null. */
export async function resolveRepoMount(
  db: Database,
  repositoryId: string,
  userId: string,
): Promise<DockerVolumeMount | null> {
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: {
      userId: true,
      source: true,
      status: true,
      storagePath: true,
      localPath: true,
      writable: true,
    },
  });
  if (!repo) return null;
  if (repo.userId !== userId) return null;
  if (repo.status !== 'ready') return null;
  if (isReadOnlyLocalRepo(repo)) return null;

  // Defensive: a non-local repo whose storage still resolves under the host
  // bind root would also be read-only — treat it as unsupported.
  const storagePath = repo.storagePath ?? repo.localPath;
  if (storagePath && storagePath.startsWith(HOST_REPO_ROOT + '/')) return null;

  return {
    source: REPO_VOLUME_NAME,
    target: REPO_MOUNT_TARGET,
    subpath: `${userId}/${repositoryId}`,
    readOnly: false,
  };
}

export const WORKER_REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
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
export const STATUS_DEFAULT_MESSAGE = 'Waiting for AI analysis...';

export function createStepStatusUpdater(
  db: Database,
  taskStepId: string,
  invocationId?: string | null,
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
    // Also stamp THIS invocation's own status so each terminal shows what its own
    // agent is doing — the step status is shared/last-writer-wins (fine for the
    // step header, useless per-terminal when agents mine in parallel).
    if (invocationId) {
      db.update(schema.cliInvocations)
        .set({ statusMessage: truncated })
        .where(eq(schema.cliInvocations.id, invocationId))
        .catch((err: unknown) => {
          log.warn({ err, invocationId }, 'failed to update invocation status');
        });
    }
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
    columns: { stepId: true, round: true },
  });
  const taskPayload: TaskJobPayload = {
    taskId: payload.taskId,
    userId: payload.userId,
    stepId: stepRow?.stepId,
    // Carry the step's round so the resume advances the SAME round. Without it the
    // advance defaults to round 0 (handleAdvanceStep: `payload.round ?? 0`), so a
    // fix-loop step (round > 0) that finishes its CLI never gets resumed: its
    // round-0 sibling is re-processed (→ waiting_form) while the real round stays
    // stuck in waiting_cli, unconsumed.
    round: stepRow?.round,
  };
  const queue = getTaskQueue();
  await queue.add(TASK_JOB_NAMES.ADVANCE_STEP, taskPayload, {
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}
