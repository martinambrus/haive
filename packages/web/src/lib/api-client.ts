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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      issues?: { path: string; message: string }[];
    };
    const error = new Error(body.error ?? `HTTP ${res.status}`) as ApiError;
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
  createdAt: string;
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

export type CliProviderName =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'amp'
  | 'grok'
  | 'qwen'
  | 'kiro'
  | 'zai';

export type CliAuthMode = 'subscription' | 'api_key' | 'mixed';
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

export interface CliProviderMetadata {
  name: CliProviderName;
  displayName: string;
  description: string;
  defaultExecutable: string;
  supportsSubagents: boolean;
  supportsApi: boolean;
  supportsCliAuth: boolean;
  defaultAuthMode: CliAuthMode;
  apiKeyEnvName: string | null;
  defaultModel: string | null;
  authConfigPaths: string[];
  docsUrl?: string;
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
  supportsSubagents: boolean;
  networkPolicy: CliNetworkPolicy;
  authMode: CliAuthMode;
  cliVersion: string | null;
  sandboxDockerfileExtra: string | null;
  sandboxImageTag: string | null;
  sandboxImageBuildStatus: CliSandboxBuildStatus;
  sandboxImageBuildError: string | null;
  sandboxImageBuiltAt: string | null;
  enabled: boolean;
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

export interface CliProbePathResult {
  ok: boolean;
  detail?: string;
  error?: string;
  durationMs?: number;
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

export type WorkflowType = 'onboarding' | 'workflow' | 'env_replicate';

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'paused'
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
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  taskStepId: string | null;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export type TaskAction = 'pause' | 'resume' | 'cancel' | 'retry';

export type StepAction = 'retry' | 'skip';

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
