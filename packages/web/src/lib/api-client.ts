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
  /** The parsed error body, verbatim. Kept so an endpoint can hand the UI
   *  structured detail its message cannot carry — the plan delete's 409 names
   *  the tasks blocking it, and a list of links beats a sentence telling the
   *  user to go find them. Callers that do not need it ignore it. */
  body?: unknown;
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

/**
 * Rotate the access cookie via /auth/refresh, deduped so concurrent callers share
 * ONE in-flight request. The server rotates (and revokes) the refresh token on
 * each call, so two overlapping refreshes would invalidate each other; the shared
 * promise guarantees the 401-retry path and the keepalive timer never collide.
 */
export function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = tryRefresh().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
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
    const ok = await refreshSession();
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
    error.body = body;
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
  /** `body` is optional and rarely wanted — a DELETE says everything by its
   *  URL. It exists for the plan delete, which carries a typed confirmation the
   *  server re-checks; that belongs in a body rather than a query string, where
   *  it would land in every access log along the way. */
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'DELETE',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
};

/** Post an increment of a step's user-active time. Uses `keepalive` so the
 *  final flush survives a tab close / navigation, and bypasses the `request`
 *  wrapper (no 401-refresh/throw): this is best-effort telemetry, so failures
 *  are swallowed rather than surfaced. */
export function postUserActive(taskId: string, stepRowId: string, deltaMs: number): void {
  if (deltaMs <= 0) return;
  void fetch(`${API_BASE}/tasks/${taskId}/steps/${stepRowId}/user-active`, {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deltaMs }),
  }).catch(() => {});
}

/** Best-effort: ask the API to release the Global KB embedding model from the GPU
 *  (Ollama keep_alive:0) when the user leaves the Global KB settings page. Uses
 *  `keepalive` so it survives a tab close / navigation, and swallows errors — the
 *  server gates the eviction (resident + unused) and the worker-boot reconciler is
 *  the durable backstop, so a missed call is harmless. Mirrors `postUserActive`. */
export function releaseGlobalKbEmbedModel(): void {
  void fetch(`${API_BASE}/global-kb/release-embed-model`, {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
  }).catch(() => {});
}

/** A user-uploaded reference file attached to a task. Mirrors the shared
 *  TaskAttachment shape locally to keep the @haive/shared barrel out of the
 *  browser bundle. */
export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  sizeBytes: number;
  contentType: string | null;
  description: string | null;
  createdAt: string;
}

/** Upload one file as a task attachment. Posts the raw file body (streamed
 *  server-side, cap-enforced) with metadata in the query string, bypassing the
 *  JSON `request` wrapper. */
export async function uploadTaskAttachment(
  taskId: string,
  file: File,
  description?: string,
): Promise<TaskAttachment> {
  const params = new URLSearchParams({ filename: file.name });
  if (description) params.set('description', description);
  const res = await fetch(`${API_BASE}/tasks/${taskId}/attachments?${params.toString()}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `Failed to upload ${file.name} (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { attachment: TaskAttachment };
  return data.attachment;
}

export async function listTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
  const data = await api.get<{ attachments: TaskAttachment[] }>(`/tasks/${taskId}/attachments`);
  return data.attachments;
}

export async function deleteTaskAttachment(taskId: string, attachmentId: string): Promise<void> {
  await api.delete(`/tasks/${taskId}/attachments/${attachmentId}`);
}

/** One completed task's AI-estimate-vs-actual-effort accuracy (estimation dashboard). */
export interface EstimationAccuracyRow {
  taskId: string;
  title: string;
  completedAt: string | null;
  /** RAW AI estimate (decimal hours). */
  aiEstimatedHours: number;
  /** Human-confirmed estimate (decimal hours), for reference. */
  confirmedHours: number | null;
  /** MEASURED actual effort (work + user-active, decimal hours). */
  actualHours: number;
  /** Signed % error of the AI estimate vs actual ((actual-ai)/actual*100); positive means
   *  the AI under-estimated (task took longer than predicted). */
  signedErrorPct: number;
  absErrorPct: number;
}

export interface EstimationAccuracySummary {
  taskCount: number;
  /** Mean Absolute Percentage Error of the AI estimate vs actual effort. */
  mapePct: number;
  /** Median actual/ai ratio: > 1 => the estimator ran under across the repo. */
  medianBiasFactor: number | null;
  underestimateCount: number;
  overestimateCount: number;
}

export async function getEstimationAccuracy(
  repositoryId: string,
): Promise<{ rows: EstimationAccuracyRow[]; summary: EstimationAccuracySummary }> {
  return api.get<{ rows: EstimationAccuracyRow[]; summary: EstimationAccuracySummary }>(
    `/tasks/estimation-accuracy?repositoryId=${encodeURIComponent(repositoryId)}`,
  );
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
  writable: boolean;
  localPath: string | null;
  remoteUrl: string | null;
  branch: string | null;
  status: 'cloning' | 'ready' | 'error';
  statusMessage: string | null;
  detectedFramework: string | null;
  detectedLanguages: Record<string, number> | null;
  /** Top-level dir/file names only (server-derived). The full fileTree is no
   *  longer shipped in the list payload. Absent on the single-repo detail
   *  endpoint, which has no consumer that renders it. */
  topLevelPaths?: string[];
  /** Onboarding/RAG scope deny list (repositories.scope_exclude_globs). NULL when
   *  onboarding has not produced a scope yet — the repos-page exclusions editor
   *  stays hidden until then. */
  scopeExcludeGlobs: string[] | null;
  /** True once all onboarding markers exist on disk (.claude/agents, skills,
   *  workflow-config.json, .haive-data/knowledge_base). Sent by the list endpoint only
   *  (undefined on the single-repo detail payload); false for non-ready repos. */
  onboarded?: boolean;
  /** The repo holds nothing an onboarding run could learn from — a project
   *  created empty, scaffolded but with no source yet. Distinct from
   *  `onboarded`: there is no knowledge base, and there is nothing to build one
   *  from either, so offering to onboard would offer an action that cannot
   *  accomplish anything. Flips back on its own once the repo has code. */
  nothingToOnboard?: boolean;
  sizeBytes: number | null;
  openTaskCount: number;
  activeTaskCount: number;
  createdAt: string;
}

/** A reusable, per-repository snapshot of an env-replicate step's form inputs
 *  (`stepId` = `01-declare-deps` deps or `02-generate-dockerfile` Dockerfile).
 *  `values` is the raw FormValues object the step's form produced; it re-seeds
 *  that step's form when applied. */
export interface EnvDepPreset {
  id: string;
  /** Null for a global preset (reusable across all the user's repos). */
  repositoryId: string | null;
  stepId: string;
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

export type CliProviderName =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'amp'
  | 'zai'
  | 'antigravity'
  | 'ollama'
  | 'muse'
  | 'grok'
  | 'openrouter';

export type CliAuthMode = 'subscription' | 'api_key';
export type CliSandboxBuildStatus = 'idle' | 'building' | 'ready' | 'failed';
export type CliModelProvisionStatus = 'idle' | 'provisioning' | 'ready' | 'failed';

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
  ollama: ['ollama.com', '*.ollama.com'],
  muse: ['api.meta.ai'],
  grok: ['api.x.ai', 'accounts.x.ai', 'auth.x.ai', 'grok.com'],
  openrouter: ['openrouter.ai'],
};

/** One entry of the cached OpenRouter model catalog, as served by
 *  GET /cli-providers/openrouter/models. Local mirror of the shared
 *  `OpenRouterModelEntry` — web keeps its own copies of API response types rather
 *  than importing the @haive/shared barrel (which drags ioredis/dns into the
 *  bundle). Keep the two in sync. */
export interface OpenRouterModelEntry {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  /** Drives whether the effort selector is worth offering. Display-only: OpenRouter
   *  validates the effort parameter globally, so a model without reasoning still
   *  accepts every level and normalizes it away. */
  supportsReasoning: boolean;
  /** Load-bearing: Claude Code cannot run a step without native tool use, so a
   *  model without this cannot be selected. */
  supportsTools: boolean;
  supportsImages: boolean;
}

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
  supportsLsp: boolean;
  defaultAuthMode: CliAuthMode;
  apiKeyEnvName: string | null;
  defaultModel: string | null;
  /** Whether the adapter actually reads `model` and passes it to the CLI. When
   *  false the form must not offer the field — the value could never take effect. */
  supportsModelSelection: boolean;
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

export interface CliModelLimits {
  /** The `model` string these limits were learned for. */
  model: string;
  /** Present and false when the model rejects image input. */
  vision?: false;
  /** Output-token ceiling the worker settled on for this model. */
  maxOutputTokens?: number;
  /** The ceiling ladder is spent (or the provider rejected a raise). */
  maxOutputTokensExhausted?: true;
  learnedAt: string;
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
  /** The adapter's effort scale (reasoning levels), or null for CLIs with no effort
   *  knob. Attached by GET /cli-providers so the task UI can build the per-step
   *  effort dropdown and hide it for knob-less CLIs. */
  effortScale: EffortScaleMetadata | null;
  model: string | null;
  modelfile: string | null;
  modelProvisionStatus: CliModelProvisionStatus;
  modelProvisionError: string | null;
  /** Limitations the worker LEARNED from a failed invocation (the model rejects images,
   *  the output-token ceiling it needs). Applied automatically on the next dispatch.
   *  Keyed by the model string it was learned for, so it stops applying by itself when
   *  `model` changes. Null when nothing has been learned. */
  modelLimits: CliModelLimits | null;
  sandboxDockerfileExtra: string | null;
  sandboxImageTag: string | null;
  sandboxImageBuildStatus: CliSandboxBuildStatus;
  sandboxImageBuildError: string | null;
  sandboxImageBuiltAt: string | null;
  enabled: boolean;
  isolateAuth: boolean;
  disableThinking: boolean;
  authStatus: CliAuthStatus;
  authMessage: string | null;
  authLastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UsageWindow {
  usedPct: number;
  resetsAt: string | null;
}

/** A provider's latest subscription usage-window snapshot (worker-polled). `usedPct` is
 *  0-100 CONSUMED; the header chip shows remaining = 100 - usedPct (matching each
 *  vendor's own "% left" view). Absent window fields = that provider has no such window. */
export interface UsageWindowSnapshot {
  providerId: string;
  providerName: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  daily?: UsageWindow;
  fetchedAt: string;
  stale: boolean;
  /** 'needs_reconnect' = the usage token was rejected and only a re-auth fixes it;
   *  the header chip prompts a reconnect instead of hiding. 'pending' = that re-auth
   *  already happened and the poller has not caught up, so the chip says it is waiting
   *  instead of asking for a reconnect the user just performed. */
  status: 'ok' | 'error' | 'needs_reconnect' | 'pending';
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

/** Task types the browser can encounter. A superset of the ones the create-task
 *  form offers: kb_author and the three plan types are spawned by their own
 *  endpoints (they need context the generic form has no field for) but still
 *  appear in the task list and detail views. */
export type WorkflowType =
  | 'onboarding'
  | 'workflow'
  | 'onboarding_upgrade'
  | 'run_app'
  | 'kb_author'
  | 'plan_build'
  | 'plan_chat'
  | 'advisory'
  | 'plan_sequence';

/** Execution path chosen at the 00-triage step (workflow tasks). Mirrors
 *  ExecutionPath in @haive/shared; redefined here so the browser bundle never
 *  imports the server-only package barrel. */
export type ExecutionPath = 'quick_bugfix' | 'plan_tasklist' | 'full_workflow';

export interface OnboardingStatus {
  onboarded: boolean;
  /** See Repository.nothingToOnboard. */
  nothingToOnboard: boolean;
  present: string[];
  missing: string[];
}

export interface RepoFile {
  path: string;
  size: number;
  binary: boolean;
  /** True when the file was longer than the read cap; `content` holds the head. */
  truncated: boolean;
  content: string | null;
}

export function getRepoFile(repositoryId: string, path: string): Promise<RepoFile> {
  return api.get<RepoFile>(
    `/repos/${encodeURIComponent(repositoryId)}/file?path=${encodeURIComponent(path)}`,
  );
}

export function getRepoOnboardingStatus(repositoryId: string): Promise<OnboardingStatus> {
  return api.get<OnboardingStatus>(`/repos/${encodeURIComponent(repositoryId)}/onboarding-status`);
}

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_pr'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  'pending' | 'running' | 'waiting_form' | 'waiting_cli' | 'done' | 'failed' | 'skipped';

/** Which capacity cap a running-but-queued task is parked behind: 'runtime' = the runtime
 *  admission gate (no free DDEV/app runner slot), 'agent' = its CLI job is enqueued but no
 *  parallel-agent slot has picked it up. Local mirror of @haive/shared's SlotWait — the web
 *  package intentionally keeps its own copies of API types. */
export type SlotWaitKind = 'runtime' | 'agent';

export interface SlotWait {
  kind: SlotWaitKind;
  /** ISO time the wait began. */
  since: string | null;
  stepId: string;
  /** The worker's own queue copy (position, pool size). Display only. */
  message: string | null;
  /** The park's heartbeat went cold — the task is wedged, not queued. */
  stale: boolean;
}

export interface NotificationSettings {
  soundEnabled: boolean;
  /** Per-user opt-out for subscription usage-depletion alerts. The global enable and
   *  the remaining-% threshold are admin config; this only removes the user from them. */
  usageAlertEnabled: boolean;
  hasCustomSound: boolean;
  soundFilename: string | null;
}

export interface Task {
  id: string;
  userId: string;
  /** Human name of the step the task sits on ("Phase 4: Implementation validation
   *  (fix loop 7)"), derived server-side from `currentStepId` + `currentRound` and served
   *  by BOTH the listing and the detail endpoint. Rendered verbatim on both surfaces so the
   *  list badge and the task header can never name the same step differently. Absent on an
   *  older api; callers fall back to the step id. */
  currentStepLabel?: string | null;
  repositoryId: string | null;
  /** The completed task this bug fix belongs to (one level; null otherwise). Set
   *  by the create form for workflow bug fixes; the API flattens so it never
   *  points at another linked bug fix. */
  parentTaskId?: string | null;
  cliProviderId: string | null;
  /** Every CLI provider the task's CURRENT step will actually spend, resolved server-side:
   *  an explicit per-step (or per-seat) preference wins, `cliProviderId` is only the
   *  fallback. The usage strip meters THESE — keying on the task column alone showed no
   *  meter for a task whose steps run on a different CLI. Listing endpoint only; absent on
   *  an older api, where callers fall back to `cliProviderId`. */
  currentStepCliProviderIds?: string[];
  type: WorkflowType;
  /** Execution path chosen at the 00-triage step (workflow tasks only). null until
   *  triage records it, and on non-workflow tasks. */
  executionPath?: ExecutionPath | null;
  title: string;
  description: string | null;
  /** Developer's estimated completion time in decimal hours (set on the new-task
   *  form; null when not given). Compared against actual effort in the task UI. */
  estimatedTimeHours?: number | null;
  /** The AI's learned effort estimate (decimal hours) from the 00b-estimate step, kept
   *  separate from the confirmed estimatedTimeHours so AI accuracy stays visible against
   *  actual effort. null on tasks that never ran the estimate step. */
  aiEstimatedTimeHours?: number | null;
  /** Low/high effort band (decimal hours) around the AI estimate, from the spread of the
   *  anchor tasks' actual effort. Both null until 00b-estimate has enough anchors. */
  aiEstimateLowHours?: number | null;
  aiEstimateHighHours?: number | null;
  status: TaskStatus;
  /** Auto-continue: the runner auto-submits info-only forms and gate-1
   *  pre-answers so the workflow runs hands-free between gates. Toggleable
   *  from the task header. */
  autoContinue: boolean;
  currentStepId: string | null;
  currentStepIndex: number;
  /** ISO time the current gate began waiting (the waiting_form step's
   *  waitingStartedAt), or null when the task is not parked at a gate. Tags the
   *  wait occurrence so the notifier re-fires when a task re-enters the same gate
   *  after a restart. List endpoint only. */
  currentWaitStartedAt?: string | null;
  /** Set while the task's status is `running` but its current step is parked waiting for
   *  capacity — the badge distinguishes "actually working" from "queued in line". Derived
   *  server-side on every request (both the listing and the detail endpoint), never stored. */
  slotWait?: SlotWait | null;
  /** ISO time the user paused this task, or null. NOT a status: the row keeps `running` /
   *  `waiting_user` / … so every server-side guard and reaper still sees it, and "paused" is
   *  derived here for the badge and the ?status=paused filter — same shape as slotWait, which
   *  is suppressed while this is set. */
  pausedAt?: string | null;
  /** Up/down vote score in [-5, +5], 0 by default. Shifts this task's fair-scheduling band
   *  so its AI agents are picked up sooner (or later) when slots are scarce; it is not a
   *  priority class, so an unvoted task still makes progress. Also the listing's primary
   *  sort key. Optional so an older api that omits it renders as 0. */
  voteScore?: number;
  /** Which model actually ran this task, captured by the 00-model-health canary from its
   *  own CLI stream. `requested` is what we asked for, `served` is what answered, and they
   *  can disagree (measured: a provider configured for glm-5.2[1m] was served glm-5.3).
   *  `served` is null for CLIs that report no model at all — codex and amp — which is what
   *  `match: 'unknown'` means. Detail endpoint only; optional so an older api renders as
   *  absent rather than throwing. */
  modelIdentity?: {
    requested: string | null;
    served: string | null;
    billed: string[];
    source: 'stream-json' | 'gemini-stats' | 'antigravity-log' | 'provider-config' | null;
    match: 'exact' | 'differs' | 'unknown';
  } | null;
  /** ISO time the provider-outage watch was marked recovered (list endpoint only). Null
   *  until a task that failed on a provider rate-limit or 5xx has that provider come back;
   *  the notifier diffs its null->set flip to fire the "provider is back" notification. */
  allowanceReplenishedAt?: string | null;
  /** ISO time the poller AUTO-resumed this task after its provider returned (list endpoint
   *  only; set only in ALLOWANCE_WATCH_MODE 'auto'). The notifier diffs its null->set
   *  flip to fire the "auto-resumed" notification. */
  allowanceAutoResumedAt?: string | null;
  /** Name of the CLI provider the outage watch is/was on (list endpoint only), so the
   *  recovery notification can name it. Null when no watch is set. */
  allowanceProviderName?: string | null;
  /** Which fatal class armed the outage watch: 'rate_limit' or 'server_error' (list endpoint
   *  only). Null when no watch is set or the row predates the column. */
  allowanceWatchReason?: string | null;
  containerId: string | null;
  worktreePath: string | null;
  /** PR close-out (workflow tasks that chose create_pr at step 12). All null until a PR
   *  is opened; the poller keeps prState/prMergedAt/prPollError live while the task parks
   *  in waiting_pr. Spread straight off the task row by GET /tasks/:id. */
  prProvider?: string | null;
  prUrl?: string | null;
  prNumber?: string | null;
  prState?: 'open' | 'merged' | 'closed' | null;
  prMergedAt?: string | null;
  prFinalizeMode?: 'auto' | 'manual' | null;
  prPollError?: string | null;
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
  /** Summed CLI token usage across the task's non-superseded invocations,
   *  attached by the list endpoint (GET /tasks). Matches the sum of the per-step
   *  token badges on the detail page. A snapshot at request time; the listing's
   *  3s poll keeps running tasks current. null when the task ran no token-bearing
   *  CLI. Absent on the create response. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  } | null;
}

/** GET /tasks response: one page of tasks plus the totals and repo facet that
 *  drive the listing's infinite scroll and repository dropdown. */
export interface TaskListResponse {
  tasks: Task[];
  total: number;
  page: number;
  pageSize: number;
  repositories: { id: string; name: string }[];
  /** The admin global pause switch is on: no task is being advanced and no queued CLI
   *  invocation is being picked up anywhere. Optional so an older api response still parses. */
  globalPause?: boolean;
}

/** GET /system/pause — the global switch, readable by any signed-in user (the admin config
 *  route is admin-gated, and the app-wide banner has to render for everyone). */
export interface SystemPauseResponse {
  globalPause: boolean;
}

/** A CLI step the run has not reached yet: no `task_steps` row, so no card and no CLI
 *  picker on it. Served by GET /tasks/:id so the CLIs tab can set its provider before
 *  dispatch — the only window for a step that never pauses (its form auto-submits, or it
 *  has none and the task is on auto-continue). Carries the same preference fields a real
 *  step row does, so one picker component renders both. */
export interface UpcomingCliStep {
  stepId: string;
  /** StepMetadata.title, from the shared CLI dispatch catalog (the step has no row to
   *  read a title from yet). */
  title: string;
  preferredCliProviderId: string | null;
  preferredEffortLevel: string | null;
  cliRoles?: { id: string; label: string }[];
  cliRoleProviders?: Record<string, string | null>;
  cliRoleEfforts?: Record<string, string | null>;
  miningSeats?: { id: string; label: string }[];
  miningSeatProviders?: Record<string, string | null>;
  miningSeatEfforts?: Record<string, string | null>;
}

export interface TaskStep {
  id: string;
  taskId: string;
  stepId: string;
  stepIndex: number;
  /** buildRunList position — the TRUE run-order key. step_index is a static
   *  per-workflow-type offset and is NOT run-monotonic when step families interleave
   *  (env-replicate prelude spliced into a workflow). Null for legacy rows predating
   *  run_seq; the task-detail endpoint sorts by it. */
  runSeq: number | null;
  /** Fix-loop round (0 = original pass). The same stepId recurs once per round. */
  round: number;
  title: string;
  status: StepStatus;
  detectOutput: unknown;
  formSchema: unknown;
  formValues: Record<string, unknown> | null;
  output: unknown;
  statusMessage: string | null;
  /** Non-fatal advisory shown as a standalone amber banner (e.g. RAG embeddings
   *  running on CPU because the GPU is unavailable). Null = no warning. */
  warningMessage: string | null;
  /** Human-readable recap of what this step's LLM agent did — shown as the
   *  collapsible "What the agent did" panel. Null on deterministic-only steps
   *  or before the async summarizer fills it. */
  summary: string | null;
  errorMessage: string | null;
  errorHint: StepErrorHint | null;
  /** Non-fatal advisory: the step's LLM output could not be parsed and it fell back
   *  to a deterministic stub. Status stays 'done'; shown as an amber banner. */
  degradedNote: string | null;
  /** Surface B: context-window usage frozen at step completion (display-only audit
   *  trail). contextLeftPercent = 100 - round(peak prompt tokens / window * 100). Null
   *  on deterministic steps and rows finished before this feature shipped. */
  contextLeftPercent: number | null;
  contextTokens: number | null;
  contextWindowSize: number | null;
  /** Surface B audit trail: subscription-allowance USED% (0-100) frozen at step
   *  completion from the step provider's usage snapshot (UI shows remaining =
   *  100 - used). Null on deterministic steps / when usage tracking isn't connected. */
  usageFiveHourPct: number | null;
  usageSevenDayPct: number | null;
  usageDailyPct: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Per-(user, step) CLI preference. Set when the user picks a CLI for
   *  this step from the dropdown, or when the runner records the actually-
   *  used provider after dispatch. The dropdown defaults to this when
   *  present; falls back to the task-level cliProviderId otherwise. */
  preferredCliProviderId: string | null;
  /** Per-(user, step) effort override (null = use the provider's configured
   *  effort); drives the per-step effort dropdown's selected value. */
  preferredEffortLevel: string | null;
  /** Multi-CLI steps (e.g. spec-quality) expose role descriptors and the
   *  currently-selected provider per role; the step card renders one dropdown
   *  per role instead of the single CLI dropdown. */
  cliRoles?: { id: string; label: string }[];
  cliRoleProviders?: Record<string, string | null>;
  /** Per-role effort override for multi-CLI steps; parallels cliRoleProviders. */
  cliRoleEfforts?: Record<string, string | null>;
  /** Fan-out steps (08c review, 08d adversarial QA) expose one seat per agent in the
   *  fan-out, so each reviewer/adversary/refuter-lens can run on a different model.
   *  Kept separate from cliRoles: that field's presence and length drive LOOP display
   *  (round badges, Resume), which a parallel fan-out must not inherit. */
  miningSeats?: { id: string; label: string }[];
  miningSeatProviders?: Record<string, string | null>;
  /** Per-seat effort override; parallels miningSeatProviders. */
  miningSeatEfforts?: Record<string, string | null>;
  /** True iff this step was skipped via the user-clicked "Skip" action.
   *  Auto-skipped steps (shouldRun → false, or detect setting skipReason)
   *  have this as false. Used to hide the retry button on auto-skips. */
  manuallySkipped: boolean;
  /** True when the step opts into the user-facing Skip action (server-enforced
   *  via SKIPPABLE_STEP_IDS). Drives whether the Skip button is shown. */
  canSkip: boolean;
  /** True when this step ever dispatches a CLI (llm | agentMining | dagExecute),
   *  from CLI_DISPATCH_STEP_IDS. Deterministic steps (false) never consume a
   *  per-step provider, so the step card hides the CLI picker for them and shows
   *  a "runs without an AI CLI" note instead. */
  usesCli: boolean;
  /** Number of non-superseded CLI invocations attached to this step. Drives
   *  whether the inline terminal toggle is rendered — 0 means the step has
   *  no terminal output to show (deterministic-only or pending steps). */
  cliInvocationCount: number;
  /** Non-superseded, non-agent_mining CLI invocations = LLM run attempts. >1 on a
   *  non-loop step (iterationCount === 0) means the step auto-retried (form-aware /
   *  retry-then-degrade) because an earlier attempt's output couldn't be used. */
  attemptCount: number;
  /** Role id of the step's LIVE cli invocation (e.g. 'tester' | 'fixer' for the
   *  browser-test loop), reverse-looked-up from the invocation label; null when not
   *  waiting on a role-bearing CLI. Drives UI that reacts to the active pass — e.g.
   *  hiding the browser panel during 08a's fixer pass. */
  activeRole: string | null;
  /** Summed token usage across this step's non-superseded CLI invocations
   *  (provider-native semantics; same filter as cliInvocationCount, so it
   *  reconciles with the per-invocation terminal panel). null when the step
   *  ran no token-bearing CLI (deterministic-only / pending steps). */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  } | null;
  /** Number of completed loop passes for steps that declare a loop hook
   *  (e.g. spec-quality review). Always 0 for non-loop steps. The step
   *  card surfaces this as an "iteration N/M" badge while the step is
   *  active so the user sees progress through the loop budget. */
  iterationCount: number;
  /** How this step's CONCURRENT agent terminals ended — 08c runs a peer reviewer, a
   *  security reviewer and extra lenses side by side. All 0 for a step with no fan-out,
   *  so a sequential loop step simply reports nothing to re-run. Counted server-side from
   *  the mining rows' status column, never from their error text. `failed > 0` is what
   *  offers "re-run only the terminals that failed" — but only once `inFlight === 0`,
   *  because until then the fan-out is still in progress and `done + failed` is a subset
   *  of it rather than the whole. */
  agentCounts: { done: number; failed: number; inFlight: number };
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
  /** Work / idle / user-active (ms) carried over from PRIOR runs of this step
   *  (folded in by a retry/reset). Added on top of the current run so the per-step
   *  and task-level timers report the full step across restarts. 0 when never reset. */
  carriedWorkMs: number;
  carriedIdleMs: number;
  carriedUserActiveMs: number;
}

export type StepErrorHint =
  | {
      type: 'cli_login_required';
      providerId: string;
      providerName: string;
    }
  | {
      type: 'local_model_destructive';
      stepId: string;
      providerName: string;
    }
  | {
      type: 'provider_unavailable';
      /** Mirrors StepErrorHint in @haive/shared. `content_filter` is NOT an outage — the
       *  provider refused this prompt, so waiting changes nothing. */
      reason: 'rate_limit' | 'auth' | 'server_error' | 'content_filter';
      providerName?: string;
    }
  | {
      /** Mirrors StepErrorHint in @haive/shared — the step's CLI was SIGKILLed at its
       *  budget on every rung of the escalating timeout ladder. Drives the "Retry with
       *  longer timeout" button. */
      type: 'cli_timeout';
      stepId: string;
      lastBudgetMinutes: number;
      attempts: number;
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
  runbookHits: number;
  learningHits: number;
  maxRrf: number;
  maxDense: number;
  createdAt: string;
}

export interface GlobalKbFacets {
  framework?: string[];
  frameworkMajor?: string[];
  language?: string[];
  phpMajor?: string[];
  nodeMajor?: string[];
  packages?: string[];
  tags?: string[];
}

/** A global (cross-repository) knowledge base entry. Admin-managed; retrieved by
 *  tasks via rag_search, version-scoped by `facets`. */
export interface GlobalKbEntry {
  id: string;
  namespace: string;
  userId: string | null;
  title: string;
  seedText: string | null;
  body: string;
  category: 'general' | 'tech_pattern' | 'anti_pattern' | 'best_practice' | 'quick_reference';
  facets: GlobalKbFacets;
  status: 'skeleton' | 'enriching' | 'draft' | 'active' | 'archived' | 'failed';
  source: 'user' | 'promoted';
  sourceTaskId: string | null;
  sourceRepoId: string | null;
  contentHash: string | null;
  embedStatus: 'pending' | 'embedded' | 'failed' | 'stale';
  createdAt: string;
  updatedAt: string;
  /** When set, this draft proposes to update the entry with this id; on activation
   *  that entry is archived. Used to show an "updates existing" diff in review. */
  supersedesEntryId: string | null;
  supersededAt: string | null;
}

export type CliInvocationMode =
  'cli' | 'agent_mining' | 'dag_parallel' | 'subagent_native' | 'subagent_sequential';

export interface CliInvocationSummary {
  id: string;
  mode: CliInvocationMode;
  exitCode: number | null;
  durationMs: number | null;
  /** Actual hard process budget resolved for this run. Null for a queued or legacy row. */
  timeoutMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  isActive: boolean;
  /** Label + name of the CLI provider that ran this invocation (null for legacy
   *  rows / deleted providers). Shown on the terminal badge. */
  providerLabel: string | null;
  providerName: string | null;
  /** For agent-mining invocations, the persona running this terminal (e.g.
   *  "accessibility-specialist"); null for non-mining invocations. */
  agentTitle: string | null;
  /** This terminal's own latest activity line (per-invocation), shown as its live
   *  status. Null until the first line / for non-streaming invocations. */
  statusMessage: string | null;
  /** Token usage extracted from the CLI's structured output. Null for plain
   *  CLIs (antigravity), failed extractions, and rows written before capture
   *  existed. Semantics are provider-native. */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  } | null;
  /** The reasoning-effort level this run actually got. `source` distinguishes a deliberate
   *  setting from an adapter default that happens to be the same level — the level alone
   *  cannot, which is the whole reason it is recorded. A null level is either 'none' (the CLI
   *  has no effort knob) or 'dropped' (a level was configured that the adapter does not have,
   *  so the CLI used its own default). Null on rows written before this was recorded. */
  effort: {
    level: string | null;
    source: 'step' | 'provider' | 'scale_max' | 'dropped' | 'none';
  } | null;
  /** Why a FAILED run failed, as a structural verdict (cli_invocations.provider_fatal_class):
   *  'auth' | 'rate_limit' | 'server_error' | 'content_filter'. Drives the persistent
   *  provider-verdict banner below the terminal (only 'content_filter' surfaces there; the
   *  others are shown at the step level). Null for a success, a running row, or a genuine code
   *  error. Optional so an older api renders absent. */
  providerFatalClass?: string | null;
  /** This invocation's own model identity (cli_invocations.model_identity) — requested vs
   *  served. `match: 'differs'` means the provider swapped the served model (measured: a Claude
   *  Code fable request served claude-opus-4-8 on a security prompt). Optional so an older api
   *  renders absent; distinct from the TASK-level modelIdentity, which is the canary's copy. */
  modelIdentity?: {
    requested: string | null;
    served: string | null;
    match: 'exact' | 'differs' | 'unknown';
  } | null;
  /** This run's 1-based position in the step's whole ordering, assigned by the api over
   *  every non-superseded row. Not derivable client-side: the loaded window is bounded and
   *  is not even a contiguous newest-suffix, since every ACTIVE run is returned whatever
   *  its age. Optional so an older api simply renders no run label. */
  runNumber?: number | null;
}

/** One page of a step's CLI invocations.
 *
 *  `invocations` always carries EVERY active run (a live terminal is never paged away)
 *  plus one bounded page of completed runs, walked oldest-ward with `historyCursor`.
 *  `historyTotal` is the step's full completed count, so the caller can size the
 *  "load older" affordance and number runs correctly without holding the whole list. */
export interface CliInvocationListResponse {
  invocations: CliInvocationSummary[];
  /** Total COMPLETED (ended) invocations on the step, ignoring the page limit.
   *  Optional so a web build talking to an older api degrades to "no older runs"
   *  rather than rendering a load button that fetches nothing. */
  historyTotal?: number;
  /** Every non-superseded invocation on the step, active ones included — the denominator
   *  for "Run 7 of 156" and the test for whether run labels are worth showing at all. */
  totalCount?: number;
}

export interface CliInvocationOutput {
  id: string;
  /** Raw live-stream transcript for the Raw tab (header + NDJSON + stderr). */
  streamLog: string;
  /** Parsed model prose for the Clean tab (assistant text / agent_message). */
  cleanOutput: string;
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

/** `pause` holds a task so its CLI subscription budget goes to the other tasks — the run in
 *  flight finishes, then the orchestrator stops handing it work. `resume` clears it. Neither
 *  is terminal and neither touches the environment.
 *
 *  `start` enqueues a task that was created and deliberately never started, so its
 *  attachments could be uploaded first. Idempotent server-side. */
export type TaskAction = 'cancel' | 'retry' | 'pause' | 'resume' | 'start';

export type StepAction = 'retry' | 'retry_ai' | 'resume' | 'skip' | 'abort';

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

export interface AuditEvent {
  id: string;
  actorUserId: string;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditListResponse {
  events: AuditEvent[];
  total: number;
  facets: { actions: string[]; targetTypes: string[] };
}

export interface AuditListParams {
  action?: string;
  targetType?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function listAuditEvents(params: AuditListParams): Promise<AuditListResponse> {
  const qs = new URLSearchParams();
  if (params.action) qs.set('action', params.action);
  if (params.targetType) qs.set('targetType', params.targetType);
  if (params.actorUserId) qs.set('actorUserId', params.actorUserId);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return api.get<AuditListResponse>(`/admin/audit${query ? `?${query}` : ''}`);
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

/* ------------------------------------------------------------------ */
/* Plan canvas                                                         */
/* ------------------------------------------------------------------ */

/** Mirrors the plan enums in @haive/shared; redefined here so the browser bundle
 *  never imports the server-only package barrel. */
export type PlanNodeKind = 'component' | 'decision' | 'research' | 'external';
export type PlanNodeStatus = 'todo' | 'in_progress' | 'blocked_human' | 'done' | 'not_applicable';
export type PlanEdgeKind = 'depends_on' | 'affects' | 'implements';
export type PlanNodeOrigin = 'user' | 'llm' | 'import';

export interface PlanNode {
  id: string;
  parentId: string | null;
  path: string;
  ordinal: number;
  title: string;
  kind: PlanNodeKind;
  body: string | null;
  status: PlanNodeStatus;
  taskable: boolean;
  version: number;
  createdBy: PlanNodeOrigin;
  sourceTaskId: string | null;
  directChildren: number;
  totalDescendants: number;
  /** Status after roll-up against descendants — what the card actually renders.
   *  Server-derived; the client never has the subtree to compute it from. */
  rolledStatus: PlanNodeStatus;
  /** 1-based position in build order: every descendant is numbered before its
   *  container, so following the numbers builds the plan bottom-up. Derived
   *  server-side from the tree plus `ordinal`, never stored.
   *
   *  A POSITION, not an id. Inserting a node shifts every number after it, so
   *  never persist one and never use one to refer to a node across time. */
  sequence: number;
  /** This node's own unmet prerequisites, lowest number first — empty when it is
   *  ready to start. Direct only: a child of a blocked node is not itself
   *  blocked. Server-derived; `PlanEdge` carries no status, so the client could
   *  not work this out from the edges it is sent. */
  blockedBy: PlanBlocker[];
  createdAt: string;
  updatedAt: string;
}

/** One unmet prerequisite of a node, named the way a person reads it. */
export interface PlanBlocker {
  nodeId: string;
  sequence: number;
  title: string;
}

/** A node named in a plan defect report. */
export interface PlanDefectNode {
  nodeId: string;
  sequence: number;
  title: string;
}

/** Dependency knots that can NEVER resolve, as distinct from work that is
 *  merely waiting. A property of the plan rather than of any one node, so it
 *  arrives with the overview. */
export interface PlanDefects {
  /** `depends_on` loops: every member permanently blocks the others. */
  cycles: PlanDefectNode[][];
  /** A node depending on its own ancestor — unsatisfiable in both directions. */
  ancestorDeps: { from: PlanDefectNode; to: PlanDefectNode }[];
}

export interface PlanCrumb {
  id: string;
  title: string;
}

export interface PlanEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: PlanEdgeKind;
  note: string | null;
  fromTitle?: string | null;
  toTitle?: string | null;
}

export interface PlanCodeLink {
  id: string;
  nodeId: string;
  repoPath: string;
  symbol: string | null;
  evidence: string | null;
  derivedAtCommit: string | null;
  confidence: number | null;
  stale: boolean;
}

export interface PlanNodeTask {
  taskId: string;
  title: string;
  status: TaskStatus;
  type: WorkflowType;
  createdAt: string;
}

export interface PlanOverview {
  repositoryName: string;
  root: PlanNode | null;
  children: PlanNode[];
  nodeCount: number;
  defects: PlanDefects;
}

export interface PlanSnapshotHealth {
  revision: number;
  writtenRevision: number;
  snapshotWritten: boolean;
  lastError: string | null;
  filesExist: boolean;
  gitAvailable: boolean;
  tracked: boolean;
  uncommitted: boolean;
  committed: boolean;
  /** null = no/freshly unknown upstream; false = local commits are ahead. */
  pushed: boolean | null;
  branch: string | null;
}

export interface PlanSnapshotSaveResult {
  repositoryId: string;
  revision: number;
  writtenRevision: number;
  files: string[];
  committed: boolean;
  commitSha: string | null;
  pushed: boolean;
  branch: string | null;
  /** Pull only. */
  pulled?: PlanPullOutcome;
}

/** What a pulled snapshot did to the local plan. `keptLocal` is the one to read:
 *  nodes that exist here and not in the snapshot are KEPT, because "added
 *  locally" and "deleted over there" look identical from the file and only one
 *  of those is reversible. */
export interface PlanPullOutcome {
  previousCommit: string | null;
  fastForwarded: boolean;
  nodesCreated: number;
  nodesUpdated: number;
  keptLocal: string[];
  edgesAdded: number;
  codeLinksAdded: number;
  skipped: string | null;
}

export interface PlanTreeNode {
  id: string;
  parentId: string | null;
  title: string;
  kind: PlanNodeKind;
  status: PlanNodeStatus;
  rolledStatus: PlanNodeStatus;
  taskable: boolean;
  directChildren: number;
  totalDescendants: number;
  sequence: number;
  /** How many unmet prerequisites this node has — the COUNT, not the list. This
   *  payload is the whole plan (4106 nodes on the dev install); the names ride
   *  the detail read for the one node a person is looking at. */
  blockedCount: number;
}

export interface PlanNodeDetail {
  node: PlanNode;
  ancestry: PlanCrumb[];
  children: PlanNode[];
  edges: PlanEdge[];
  codeLinks: PlanCodeLink[];
  tasks: PlanNodeTask[];
}

export interface PlanSearchMatch extends PlanNode {
  ancestry: PlanCrumb[];
}

export interface PlanMessage {
  id: string;
  nodeId: string;
  taskId: string | null;
  role: 'user' | 'assistant';
  body: string;
  patch: unknown;
  /** The CLI that produced this turn, when it was recorded. Null on user turns
   *  and on turns written before the provider was stored — unknown, not
   *  guessed from whatever the conversation uses now. */
  cliLabel: string | null;
  createdAt: string;
}

export interface PlanImpactHop {
  nodeId: string;
  depth: number;
  viaNodeId: string;
  viaKind: PlanEdgeKind;
  reversed: boolean;
  title: string | null;
  status: PlanNodeStatus | null;
}

export interface PlanImpact {
  origin: { id: string; title: string | null };
  hops: PlanImpactHop[];
  /** Non-null when a cap stopped the walk. Must be SHOWN — a truncated impact
   *  list read as "nothing else is affected" is the failure this view exists to
   *  prevent. */
  truncated: null | { reason: 'depth' | 'nodes'; limit: number };
  mermaid: string;
  /** Nodes in `hops` the DIAGRAM does not draw. The diagram is bounded so it
   *  stays readable; this is what lets the panel say so instead of letting a
   *  partial picture read as the whole radius. */
  mermaidOmitted: number;
  codeLinks: PlanCodeLink[];
}

const planBase = (repositoryId: string) => `/repositories/${encodeURIComponent(repositoryId)}/plan`;

export function getPlanOverview(repositoryId: string): Promise<PlanOverview> {
  return api.get<PlanOverview>(planBase(repositoryId));
}

export function getPlanSnapshot(repositoryId: string): Promise<PlanSnapshotHealth> {
  return api.get<PlanSnapshotHealth>(`${planBase(repositoryId)}/snapshot`);
}

export function savePlanSnapshot(
  repositoryId: string,
  body: { push?: boolean; commitMessage?: string } = {},
): Promise<PlanSnapshotSaveResult> {
  return api.post<PlanSnapshotSaveResult>(`${planBase(repositoryId)}/snapshot/save`, body);
}

/** Fast-forward the checkout from origin and reconcile the committed plan onto
 *  the local one. The only direction that reads the repository into the plan. */
export function pullPlanSnapshot(repositoryId: string): Promise<PlanSnapshotSaveResult> {
  return api.post<PlanSnapshotSaveResult>(`${planBase(repositoryId)}/snapshot/pull`, {});
}

export function getPlanTree(repositoryId: string): Promise<{ nodes: PlanTreeNode[] }> {
  return api.get<{ nodes: PlanTreeNode[] }>(`${planBase(repositoryId)}/tree`);
}

export function getPlanNode(repositoryId: string, nodeId: string): Promise<PlanNodeDetail> {
  return api.get<PlanNodeDetail>(`${planBase(repositoryId)}/nodes/${nodeId}`);
}

export function searchPlan(
  repositoryId: string,
  q: string,
): Promise<{ matches: PlanSearchMatch[] }> {
  return api.get<{ matches: PlanSearchMatch[] }>(
    `${planBase(repositoryId)}/search?q=${encodeURIComponent(q)}`,
  );
}

export function createPlanNode(
  repositoryId: string,
  body: {
    parentId?: string | null;
    title: string;
    kind?: PlanNodeKind;
    body?: string;
    taskable?: boolean;
  },
): Promise<{ node: PlanNode }> {
  return api.post<{ node: PlanNode }>(`${planBase(repositoryId)}/nodes`, body);
}

/** `expectedVersion` is REQUIRED: a plan chat can patch any node at any time, so
 *  every UI write states which version it read. A 409 comes back when it lost. */
export function updatePlanNode(
  repositoryId: string,
  nodeId: string,
  body: {
    expectedVersion: number;
    title?: string;
    body?: string | null;
    kind?: PlanNodeKind;
    status?: PlanNodeStatus;
    taskable?: boolean;
    parentId?: string | null;
    ordinal?: number;
  },
): Promise<{ node: PlanNode }> {
  return api.patch<{ node: PlanNode }>(`${planBase(repositoryId)}/nodes/${nodeId}`, body);
}

/** Open plan task blocking a delete, as named by the 409. */
export interface OpenPlanTask {
  id: string;
  title: string;
  type: string;
}

/**
 * Delete a repository's whole plan.
 *
 * `confirm` must equal the repository name; the server re-checks it, so this is
 * not a client-side-only guard. Throws with `code: 'plan_tasks_open'` and a
 * `tasks` list when a plan task is still running.
 */
export function deletePlan(
  repositoryId: string,
  confirm: string,
): Promise<{ deletedNodes: number; mirrorRemoved: boolean }> {
  return api.delete<{ deletedNodes: number; mirrorRemoved: boolean }>(planBase(repositoryId), {
    confirm,
  });
}

export function deletePlanNode(
  repositoryId: string,
  nodeId: string,
): Promise<{ deleted: string[] }> {
  return api.delete<{ deleted: string[] }>(`${planBase(repositoryId)}/nodes/${nodeId}`);
}

export function createPlanEdge(
  repositoryId: string,
  body: { fromNodeId: string; toNodeId: string; kind: PlanEdgeKind; note?: string },
): Promise<{ edge: PlanEdge | null }> {
  return api.post<{ edge: PlanEdge | null }>(`${planBase(repositoryId)}/edges`, body);
}

export function deletePlanEdge(repositoryId: string, edgeId: string): Promise<{ deleted: string }> {
  return api.delete<{ deleted: string }>(`${planBase(repositoryId)}/edges/${edgeId}`);
}

export function getPlanImpact(
  repositoryId: string,
  nodeId: string,
  maxDepth?: number,
): Promise<PlanImpact> {
  const qs = maxDepth ? `?maxDepth=${maxDepth}` : '';
  return api.get<PlanImpact>(`${planBase(repositoryId)}/impact/${nodeId}${qs}`);
}

/** One plan_chat task's state, sent with the transcript so the chat panel can
 *  tell a live conversation from a finished or cancelled one without a request
 *  per group. */
export interface PlanConversation {
  taskId: string;
  status: TaskStatus;
  completedAt: string | null;
}

export function getPlanMessages(
  repositoryId: string,
  nodeId: string,
): Promise<{ messages: PlanMessage[]; conversations: PlanConversation[] }> {
  return api.get<{ messages: PlanMessage[]; conversations: PlanConversation[] }>(
    `${planBase(repositoryId)}/nodes/${nodeId}/messages`,
  );
}

/** The step id every plan_chat task cycles on. Its revise loop re-targets
 *  itself, so a conversation is ONE row at round 0 — submitting by step id is
 *  unambiguous. */
export const PLAN_CHAT_STEP_ID = '01-plan-chat';

/** Unread assistant turns per node, keyed by node id. Nodes with nothing unread
 *  are absent rather than zero, so the map is small on a plan nobody chats on. */
export function getPlanUnread(repositoryId: string): Promise<{ counts: Record<string, number> }> {
  return api.get<{ counts: Record<string, number> }>(`${planBase(repositoryId)}/unread`);
}

/** Mark one node's chat read up to now. */
export function markPlanNodeRead(
  repositoryId: string,
  nodeId: string,
): Promise<{ ok: boolean; lastReadAt: string }> {
  return api.put<{ ok: boolean; lastReadAt: string }>(
    `${planBase(repositoryId)}/nodes/${nodeId}/read`,
    {},
  );
}

/** Continue a conversation by submitting the turn the step is parked on. The
 *  STEP records the message, so this must not also post to the chat endpoint —
 *  that would insert the turn twice and spawn a second task. */
export function submitPlanChatTurn(taskId: string, message: string): Promise<unknown> {
  return api.post(`/tasks/${taskId}/steps/${PLAN_CHAT_STEP_ID}/submit`, {
    values: { message },
  });
}

/** End a conversation: the same form, submitted blank, which is what the step
 *  reads as "no further turn". */
export function endPlanChat(taskId: string): Promise<unknown> {
  return submitPlanChatTurn(taskId, '');
}

/** Point a live conversation at a different CLI. Refused by the API while the
 *  step is running or waiting on a CLI. */
export function setPlanChatProvider(taskId: string, cliProviderId: string): Promise<unknown> {
  return api.patch(`/tasks/${taskId}/steps/${PLAN_CHAT_STEP_ID}/cli-provider`, { cliProviderId });
}

export function buildPlan(
  repositoryId: string,
  body: {
    mode: 'from_repo' | 'greenfield';
    cliProviderId?: string;
    title?: string;
    description?: string;
    /** Create the task WITHOUT starting it, so attachments can be uploaded
     *  first. Finalize with `startTask` once every file has landed — the worker
     *  picks a job up immediately, so uploading afterwards would race the first
     *  step's detect. */
    deferStart?: boolean;
  },
): Promise<{ taskId: string; deferred: boolean }> {
  return api.post<{ taskId: string; deferred: boolean }>(`${planBase(repositoryId)}/build`, body);
}

/** Enqueue a task that was created but never started. Idempotent server-side, so
 *  a double-click cannot start it twice. */
export function startTask(taskId: string): Promise<{ ok: true; started: boolean; status: string }> {
  return api.post<{ ok: true; started: boolean; status: string }>(`/tasks/${taskId}/action`, {
    action: 'start',
  });
}

/** Put an existing plan into build order: the declared dependencies first, then
 *  a model for every group of siblings they leave undecided. */
export function startPlanSequence(
  repositoryId: string,
  body: { cliProviderId?: string } = {},
): Promise<{ taskId: string }> {
  return api.post<{ taskId: string }>(`${planBase(repositoryId)}/sequence`, body);
}

export function startPlanChat(
  repositoryId: string,
  nodeId: string,
  body: { message: string; cliProviderId?: string },
): Promise<{ taskId: string }> {
  return api.post<{ taskId: string }>(`${planBase(repositoryId)}/nodes/${nodeId}/chat`, body);
}

export function startPlanAdvisory(
  repositoryId: string,
  nodeId: string,
  body: { question?: string; cliProviderId?: string },
): Promise<{ taskId: string }> {
  return api.post<{ taskId: string }>(`${planBase(repositoryId)}/nodes/${nodeId}/advisory`, body);
}

/* ------------------------------------------------------------------ */
/* Per-user UI preferences                                             */
/* ------------------------------------------------------------------ */

/** Server-persisted UI prefs (plan-canvas view + pane split). Web-owned keys —
 *  the server stores the blob verbatim. Follows the account across browsers. */
export interface UiPrefs {
  /** 'tree' | 'tiles' — which plan-canvas view the user chose. */
  planView?: 'tree' | 'tiles';
  /** Left-pane width as a percentage for the plan canvas. Clamped 20-80 on
   *  both read and write by the page that owns it. */
  planSplitPct?: number;
  /** Which detail-panel tab the plan canvas opens on. Persisted like the other
   *  two: a person reading links across nodes is still doing that after a
   *  reload. Costs nothing on load — the panel only mounts once a node is
   *  selected, so no tab fetches anything until it is asked for. */
  planTab?: 'details' | 'links' | 'chat' | 'impact';
}

export function getUiPrefs(): Promise<UiPrefs> {
  return api
    .get<{ settingsJson: string }>('/user-settings/ui-prefs')
    .then((res) => JSON.parse(res.settingsJson) as UiPrefs)
    .catch(() => ({}));
}

export function putUiPrefs(prefs: UiPrefs): Promise<void> {
  return api
    .put('/user-settings/ui-prefs', { settingsJson: JSON.stringify(prefs) })
    .then(() => undefined);
}
