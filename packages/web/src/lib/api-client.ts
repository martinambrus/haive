const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const API_BASE_URL = API_BASE;

export function apiWebSocketUrl(path: string): string {
  const url = new URL(path, API_BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export interface ApiError extends Error {
  status: number;
  code?: string;
  issues?: { path: string; message: string }[];
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

  let res = await doFetch();

  // On 401, attempt one silent refresh then retry the original request
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (!refreshing) refreshing = tryRefresh();
    const ok = await refreshing;
    refreshing = null;
    if (ok) {
      res = await doFetch();
    }
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      issues?: { path: string; message: string }[];
    };
    const baseMsg = body.error ?? `HTTP ${res.status}`;
    const issuesMsg =
      body.issues && body.issues.length > 0
        ? `: ${body.issues.map((i) => `${i.path || '(root)'} — ${i.message}`).join('; ')}`
        : '';
    const error = new Error(baseMsg + issuesMsg) as ApiError;
    error.status = res.status;
    if (body.code) error.code = body.code;
    if (body.issues) error.issues = body.issues;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Post an increment of a step's user-active time. Uses `keepalive` so the
 *  final flush survives a tab close / navigation, and bypasses the `request`
 *  wrapper (no 401-refresh/throw): this is best-effort telemetry, so failures
 *  are swallowed rather than surfaced. */
export function postUserActive(taskId: string, stepId: string, deltaMs: number): void {
  if (deltaMs <= 0) return;
  void fetch(`${API_BASE}/tasks/${taskId}/steps/${stepId}/user-active`, {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deltaMs }),
  }).catch(() => {});
}

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'deactivated';
  createdAt: string;
}

export interface Repository {
  id: string;
  name: string;
  source: string;
  localPath: string | null;
  remoteUrl: string | null;
  branch: string | null;
  status: 'cloning' | 'ready' | 'error';
  statusMessage: string | null;
  detectedFramework: string | null;
  detectedLanguages: Record<string, number> | null;
  fileTree: string[] | null;
  excludedPaths: string[] | null;
  selectedPaths: string[] | null;
  sizeBytes: number | null;
  openTaskCount: number;
  activeTaskCount: number;
  createdAt: string;
}

/** A reusable, per-repository snapshot of the env-replicate step-1
 *  (`01-declare-deps`) form inputs. `values` is the raw FormValues object the
 *  step's form produced; it re-seeds the dependency form when applied. */
export interface EnvDepPreset {
  id: string;
  name: string;
  values: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FilesystemEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hasGit: boolean;
  hidden: boolean;
}

export interface FilesystemListing {
  path: string;
  parent: string | null;
  root: string;
  entries: FilesystemEntry[];
}

export type CliProviderName = 'claude-code' | 'codex' | 'gemini' | 'amp' | 'zai' | 'antigravity';

export type CliAuthMode = 'subscription' | 'api_key';
export type CliSandboxBuildStatus = 'idle' | 'building' | 'ready' | 'failed';

export type CliNetworkMode = 'none' | 'full' | 'allowlist';

export interface CliNetworkPolicy {
  mode: CliNetworkMode;
  domains: string[];
  ips: string[];
}

export const DEFAULT_CLI_NETWORK_POLICY: CliNetworkPolicy = {
  mode: 'full',
  domains: [],
  ips: [],
};

/** Display-only mirror of each adapter's BaseCliAdapter.defaultEgressDomains
 *  (the worker is authoritative and re-merges these server-side regardless).
 *  Shown in the provider form so users see which model/auth hosts are
 *  auto-allowed under network policy `none`/`allowlist`. Keep in sync with the
 *  worker cli-adapters when default domains change. */
export const CLI_DEFAULT_EGRESS_DOMAINS: Record<CliProviderName, string[]> = {
  'claude-code': ['api.anthropic.com'],
  codex: ['api.openai.com', 'chatgpt.com'],
  gemini: ['generativelanguage.googleapis.com', 'oauth2.googleapis.com'],
  amp: ['ampcode.com', '*.ampcode.com'],
  zai: ['api.z.ai'],
  antigravity: [],
};

export interface EffortScaleMetadata {
  values: readonly string[];
  max: string;
}

export interface CliProviderMetadata {
  name: CliProviderName;
  displayName: string;
  description: string;
  defaultExecutable: string;
  supportsSubagents: boolean;
  supportsCliAuth: boolean;
  supportsMcp: boolean;
  supportsPlugins: boolean;
  defaultAuthMode: CliAuthMode;
  apiKeyEnvName: string | null;
  defaultModel: string | null;
  authConfigPaths: string[];
  docsUrl?: string;
  effortScale: EffortScaleMetadata | null;
}

export interface CliPackageVersionsEntry {
  name: CliProviderName;
  versions: string[];
  latestVersion: string | null;
  fetchedAt: string | null;
  fetchError: string | null;
}

export interface CliProviderCatalogEntry extends CliProviderMetadata {
  versionPinnable: boolean;
  installSupported: boolean;
  versionCache: CliPackageVersionsEntry | null;
}

export interface CliProvider {
  id: string;
  userId: string;
  name: CliProviderName;
  label: string;
  executablePath: string | null;
  wrapperPath: string | null;
  wrapperContent: string | null;
  envVars: Record<string, string> | null;
  cliArgs: string[] | null;
  rulesContent: string;
  supportsSubagents: boolean;
  networkPolicy: CliNetworkPolicy;
  egressDomains: string[];
  authMode: CliAuthMode;
  cliVersion: string | null;
  effortLevel: string | null;
  sandboxDockerfileExtra: string | null;
  sandboxImageTag: string | null;
  sandboxImageBuildStatus: CliSandboxBuildStatus;
  sandboxImageBuildError: string | null;
  sandboxImageBuiltAt: string | null;
  enabled: boolean;
  isolateAuth: boolean;
  authStatus: CliAuthStatus;
  authMessage: string | null;
  authLastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CliProviderSecret {
  id: string;
  secretName: string;
  fingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CliProbeTargetMode = 'cli' | 'api' | 'both';

export type CliAuthStatus =
  | 'unknown'
  | 'ok'
  | 'auth_expired'
  | 'auth_denied'
  | 'rate_limited'
  | 'network_error'
  | 'timeout'
  | 'unknown_error';

export interface CliProbePathResult {
  ok: boolean;
  detail?: string;
  error?: string;
  durationMs?: number;
  authStatus?: CliAuthStatus;
  authMessage?: string;
  // Non-blocking advisory surfaced even when authStatus is `ok` (e.g. amp with
  // $0 balance — authenticated, but cannot run the non-interactive `amp -x`).
  warning?: string;
}

export interface CliProbeResult {
  ok: boolean;
  providerId: string;
  targetMode: CliProbeTargetMode;
  cli?: CliProbePathResult;
  api?: CliProbePathResult;
}

export type ContainerStatus = 'creating' | 'running' | 'stopped' | 'destroyed' | 'error';

export interface Container {
  id: string;
  taskId: string;
  runtime: 'clawker' | 'dockerode';
  dockerContainerId: string | null;
  name: string | null;
  status: ContainerStatus;
  attachedWsCount: number;
  createdAt: string;
  destroyedAt: string | null;
}

export type WorkflowType = 'onboarding' | 'workflow';

export interface OnboardingStatus {
  onboarded: boolean;
  present: string[];
  missing: string[];
}

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_form'
  | 'waiting_cli'
  | 'done'
  | 'failed'
  | 'skipped';

export interface Task {
  id: string;
  userId: string;
  repositoryId: string | null;
  cliProviderId: string | null;
  type: WorkflowType;
  title: string;
  description: string | null;
  status: TaskStatus;
  currentStepId: string | null;
  currentStepIndex: number;
  containerId: string | null;
  worktreePath: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Joined on the list and detail endpoints so the UI can show which repo a
   *  task belongs to. Null when the task has no repository (or it was deleted).
   *  Absent on the create response, which returns only the raw inserted row. */
  repository?: { id: string; name: string } | null;
  /** Set on GET /tasks/:id when a CLI invocation is currently in flight
   *  (started, not ended, not superseded). Drives the Terminal tab and the
   *  live cli-stream WebSocket. Always null on the list endpoint. */
  activeCliInvocationId?: string | null;
  activeCliStepId?: string | null;
  /** Per-task time breakdown attached by the list endpoint (GET /tasks): wall
   *  clock, agent work, idle (time waiting on you), and your active time at
   *  gates. A snapshot at request time; the listing's poll keeps running tasks
   *  current. Absent on the create response. The detail page ignores this and
   *  computes its own live figures from the steps it already holds. */
  timing?: {
    wallMs: number;
    workMs: number;
    idleMs: number;
    userActiveMs: number;
  } | null;
}

export interface TaskStep {
  id: string;
  taskId: string;
  stepId: string;
  stepIndex: number;
  title: string;
  status: StepStatus;
  detectOutput: unknown;
  formSchema: unknown;
  formValues: Record<string, unknown> | null;
  output: unknown;
  statusMessage: string | null;
  errorMessage: string | null;
  errorHint: StepErrorHint | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Per-(user, step) CLI preference. Set when the user picks a CLI for
   *  this step from the dropdown, or when the runner records the actually-
   *  used provider after dispatch. The dropdown defaults to this when
   *  present; falls back to the task-level cliProviderId otherwise. */
  preferredCliProviderId: string | null;
  /** Multi-CLI steps (e.g. spec-quality) expose role descriptors and the
   *  currently-selected provider per role; the step card renders one dropdown
   *  per role instead of the single CLI dropdown. */
  cliRoles?: { id: string; label: string }[];
  cliRoleProviders?: Record<string, string | null>;
  /** True iff this step was skipped via the user-clicked "Skip" action.
   *  Auto-skipped steps (shouldRun → false, or detect setting skipReason)
   *  have this as false. Used to hide the retry button on auto-skips. */
  manuallySkipped: boolean;
  /** Number of non-superseded CLI invocations attached to this step. Drives
   *  whether the inline terminal toggle is rendered — 0 means the step has
   *  no terminal output to show (deterministic-only or pending steps). */
  cliInvocationCount: number;
  /** Number of completed loop passes for steps that declare a loop hook
   *  (e.g. spec-quality review). Always 0 for non-loop steps. The step
   *  card surfaces this as an "iteration N/M" badge while the step is
   *  active so the user sees progress through the loop budget. */
  iterationCount: number;
  /** Accumulated idle time (ms) the step spent waiting for user input,
   *  excluded from the active-work timer. */
  idleMs: number;
  /** Start of the current open idle period while the step is waiting for
   *  input (waiting_form); null otherwise. */
  waitingStartedAt: string | null;
  /** Focused-and-visible time (ms) the user actively spent on this step while
   *  it waited for input — the active-viewing subset of idleMs, measured in the
   *  browser and posted in increments. Pauses while the agent works. */
  userActiveMs: number;
}

export type StepErrorHint = {
  type: 'cli_login_required';
  providerId: string;
  providerName: string;
};

/** One rag_search call's telemetry, surfaced in the discovery step's RAG stats
 *  panel. `codeHits` is the headline signal — whether code (not just KB) is
 *  being retrieved. */
export interface RagQueryEntry {
  id: string;
  query: string;
  topK: number | null;
  hitCount: number;
  kbHits: number;
  codeHits: number;
  maxRrf: number;
  maxDense: number;
  createdAt: string;
}

export type CliInvocationMode = 'cli' | 'agent_mining' | 'subagent_native' | 'subagent_sequential';

export interface CliInvocationSummary {
  id: string;
  mode: CliInvocationMode;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  isActive: boolean;
  /** Label + name of the CLI provider that ran this invocation (null for legacy
   *  rows / deleted providers). Shown on the terminal badge. */
  providerLabel: string | null;
  providerName: string | null;
}

export interface CliInvocationOutput {
  id: string;
  rawOutput: string;
  exitCode: number | null;
  errorMessage: string | null;
  durationMs: number | null;
  isActive: boolean;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  taskStepId: string | null;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export type TaskAction = 'cancel' | 'retry';

export type StepAction = 'retry' | 'resume';

export interface StepActionResponse {
  ok: boolean;
  status: string;
  nextStepId?: string | null;
}

export interface TaskFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hidden: boolean;
  size: number | null;
}

export interface TaskFileListing {
  path: string;
  parent: string | null;
  root: string;
  entries: TaskFileEntry[];
}

export interface TaskFileContent {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'deactivated';
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type AdminUserAction = 'deactivate' | 'activate' | 'reset_password' | 'set_role';

export interface AdminUserActionRequest {
  action: AdminUserAction;
  role?: 'admin' | 'user';
}

export interface AdminUserActionResponse {
  ok: boolean;
  action: AdminUserAction;
  temporaryPassword?: string;
  role?: 'admin' | 'user';
}

export interface AdminHealthResponse {
  users: { total: number; active: number; deactivated: number; admins: number };
  tasks: Record<string, number>;
  containers: Record<string, number>;
  recentFailures: {
    id: string;
    title: string;
    status: string;
    updatedAt: string;
  }[];
  timestamp: string;
}

export interface TerminalSessionSummary {
  id: string;
  containerId: string;
  startedAt: string;
  endedAt: string | null;
  byteCount: number;
  truncated: boolean;
}

export interface TerminalSessionDetail extends TerminalSessionSummary {
  fullLog: string;
}
