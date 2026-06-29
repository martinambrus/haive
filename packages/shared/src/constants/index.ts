export * from './default-agent-rules.js';

export const APP_NAME = 'Haive';
export const APP_VERSION = '0.1.0';

/**
 * Current Haive release version. Prefer `HAIVE_VERSION` env when set (CI
 * release builds stamp this) so staging/prod images can advertise a newer
 * version than the source-tree default. Callers should use `getHaiveVersion`
 * rather than reading process.env directly so web/API/worker stay aligned.
 */
export function getHaiveVersion(): string {
  if (typeof process !== 'undefined' && process.env && process.env.HAIVE_VERSION) {
    return process.env.HAIVE_VERSION;
  }
  return APP_VERSION;
}

export const QUEUE_NAMES = {
  TASK: 'haive-task',
  CLI_EXEC: 'haive-cli-exec',
  ENV_REPLICATE: 'haive-env-replicate',
  REPO: 'haive-repo',
  BUNDLE: 'haive-bundle',
  GLOBAL_KB_SYNC: 'haive-global-kb-sync',
  RUNTIME_ENSURE: 'haive-runtime-ensure',
  IDE_ENSURE: 'haive-ide-ensure',
} as const;

export const REPO_JOB_NAMES = {
  CLONE: 'clone-repo',
  SCAN: 'scan-repo',
  EXTRACT: 'extract-repo',
  /** Copy a writable-local repo's working tree from the host bind (/host-fs)
   *  into the haive_repos volume so the workflow can write against a snapshot. */
  COPY: 'copy-repo',
} as const;

export const BUNDLE_JOB_NAMES = {
  INGEST_ZIP: 'ingest-bundle-zip',
  INGEST_GIT: 'ingest-bundle-git',
  RESYNC_GIT: 'resync-bundle-git',
  /** Daily fetch tick. Runs `git fetch` against every active git bundle and
   *  updates `last_sync_commit` so the upgrade-status banner can detect
   *  upstream drift without the user pulling manually. Read-only — pulls
   *  + re-parses only happen during an explicit upgrade task. */
  GIT_SYNC_TICK: 'bundle-git-sync-tick',
} as const;

export const GLOBAL_KB_JOB_NAMES = {
  SYNC_ENTRY: 'sync-global-kb-entry',
  PURGE_ARCHIVED: 'purge-archived-global-kb',
} as const;

/** Payload for `GLOBAL_KB_JOB_NAMES.SYNC_ENTRY`. The worker reconciles the global
 *  vector store to the entry's current state: `upsert` re-embeds an active entry
 *  (or removes its chunks if it is no longer active), `delete` removes the
 *  entry's chunks (used when the source row itself is gone). */
export interface GlobalKbSyncJobPayload {
  entryId: string;
  namespace: string;
  reason: 'upsert' | 'delete';
}

export const RUNTIME_ENSURE_JOB_NAMES = {
  ENSURE: 'ensure-runtime',
} as const;

/** Payload for `RUNTIME_ENSURE_JOB_NAMES.ENSURE`. The api enqueues this (e.g. when
 *  the live Browser/VNC panel opens) and the worker ensures the task's app is
 *  serving — boots DDEV / relaunches a restart-killed app-runner dev server — then
 *  starts the headed-browser desktop the VNC bridge attaches to. The api can't do
 *  this itself: spawning task containers is worker-only. */
export interface RuntimeEnsurePayload {
  taskId: string;
  userId: string;
}

/** Result the worker returns for a runtime-ensure job. `mode='none'` means no
 *  runtime is recorded for the task (nothing to bring up). */
export interface RuntimeEnsureResult {
  ok: boolean;
  url: string | null;
  mode: 'ddev' | 'app-runner' | 'host' | 'none';
  /** Ways the user can reach the app from their own browser (the fast alternative
   *  to the VNC pixel stream), computed by the worker from the live runner's
   *  published ports. Empty/absent when direct access is disabled or no port is
   *  published. See `TaskAccessEndpoint`. */
  accessUrls?: TaskAccessEndpoint[];
}

export const IDE_ENSURE_JOB_NAMES = {
  ENSURE: 'ensure-ide',
} as const;

/** Payload for `IDE_ENSURE_JOB_NAMES.ENSURE`. The api enqueues this when the user
 *  opens the Editor tab; the worker lazily launches the task's code-server
 *  container (spawning task containers is worker-only). */
export interface IdeEnsurePayload {
  taskId: string;
  userId: string;
}

/** Result the worker returns for an ide-ensure job. `ok=false` with a `reason`
 *  when the IDE can't be started (e.g. the task has no editable volume-backed
 *  repo, or the global IDE kill-switch is off). */
export interface IdeEnsureResult {
  ok: boolean;
  reason?: string;
}

export const TASK_JOB_NAMES = {
  START: 'start-task',
  ADVANCE_STEP: 'advance-step',
  CANCEL: 'cancel-task',
  /** Drops the per-project internal RAG database after a repository is
   *  deleted. Skipped for project names that any surviving repo's tasks still
   *  reference with ragMode='internal'. External / ddev RAG modes are never
   *  touched — they live on infra Haive does not own. */
  CLEANUP_REPO_RAG: 'cleanup-repo-rag',
  /** Tears down the Docker resources + on-disk workspace a deleted repository
   *  left behind: DDEV/app runners (incl. failed tasks kept for recovery), env
   *  images no longer referenced by a surviving task, and haive_repos files. */
  CLEANUP_REPO_RESOURCES: 'cleanup-repo-resources',
} as const;

export interface TaskJobPayload {
  taskId: string;
  userId: string;
  stepId?: string;
  /** Fix-loop round to materialize/advance the step at (default 0 = original pass). */
  round?: number;
  formValues?: Record<string, unknown>;
  /** Orchestration epoch this job was enqueued under. handleAdvanceStep skips the
   *  job when it is older than the task's current epoch (a retry/reset bumped it). */
  epoch?: number;
}

/** Payload for `TASK_JOB_NAMES.CLEANUP_REPO_RAG`. The worker drops every
 *  per-project RAG database matching one of `projectNames` UNLESS another
 *  surviving task (different repository) targets the same project name with
 *  `ragMode='internal'`. */
export interface RepoRagCleanupPayload {
  repositoryId: string;
  userId: string;
  projectNames: string[];
}

/** Payload for `TASK_JOB_NAMES.CLEANUP_REPO_RESOURCES`. Tears down what a deleted
 *  repository leaves behind: each task's DDEV/app runners (incl. failed tasks
 *  whose runners were kept for recovery), env images no longer referenced by any
 *  task outside `taskIds` (ref-counted so shared/global images survive), and the
 *  repo's haive_repos files. Captured before the delete because `repository_id`
 *  cascades to NULL, so the worker could not trace these afterward. `storagePath`
 *  is only removed when it lives under the worker's repo-storage root (never a
 *  `/host-fs` local-path repo). */
export interface RepoResourceCleanupPayload {
  userId: string;
  repositoryId: string;
  taskIds: string[];
  envTemplateIds: string[];
  storagePath: string | null;
}

export const CLI_EXEC_JOB_NAMES = {
  INVOKE: 'cli-invoke',
  PROBE: 'cli-probe',
  BUILD_SANDBOX_IMAGE: 'cli-build-sandbox-image',
  REFRESH_VERSIONS: 'cli-refresh-versions',
  LOGIN_CREATE: 'cli-login-create',
  SIGN_OUT: 'cli-sign-out',
  /** Pull (or build, when a Modelfile is set) a provider's in-stack Ollama model
   *  after a create/edit, so a new model is ready without a worker restart. */
  PROVISION_OLLAMA_MODEL: 'cli-provision-ollama-model',
} as const;

export interface CliSignOutJobPayload {
  providerId: string;
  userId: string;
}

export interface CliSignOutJobResult {
  ok: boolean;
  removed: string[];
  failed: { name: string; stderr: string }[];
}

export interface RefreshCliVersionsJobPayload {
  force?: boolean;
}

export interface RefreshCliVersionsJobResult {
  ok: boolean;
  refreshed: { name: string; count: number; latest: string | null }[];
  errors: { name: string; error: string }[];
}

export type CliExecInvocationKind =
  | 'cli'
  | 'subagent_native'
  | 'subagent_sequential'
  | 'agent_mining';

export interface CliExecJobPayload {
  invocationId: string;
  taskId: string;
  taskStepId: string | null;
  userId: string;
  cliProviderId: string | null;
  /** Per-step effort/reasoning override resolved alongside cliProviderId. For
   *  kind='cli'/'agent_mining' it is already baked into spec; the sub-agent kinds
   *  rebuild the spec worker-side and read this to honor the step's effort. */
  effortLevel?: string;
  kind: CliExecInvocationKind;
  spec: unknown;
  timeoutMs?: number;
  /** For kind='agent_mining': the task_step_agent_minings.id row to update with results. */
  agentMiningId?: string;
  /** Marks a best-effort per-step summarizer invocation: its completion writes
   *  task_steps.summary (for summaryForStepId) and does NOT resume the step machine. */
  purpose?: 'step_summary';
  /** Target task_steps.id for purpose='step_summary'. The invocation itself is
   *  unlinked (taskStepId=null) so it stays out of the step terminal and token totals. */
  summaryForStepId?: string;
}

export type CliProbeTargetMode = 'cli';

export interface CliProbeJobPayload {
  providerId: string;
  userId: string;
  targetMode: CliProbeTargetMode;
}

export interface SandboxImageBuildJobPayload {
  providerId: string;
  userId: string;
  force?: boolean;
}

export interface SandboxImageBuildResult {
  ok: boolean;
  providerId: string;
  imageTag?: string;
  durationMs?: number;
  error?: string;
}

export interface OllamaProvisionJobPayload {
  providerId: string;
  userId: string;
}

export interface OllamaProvisionResult {
  ok: boolean;
  providerId: string;
  model?: string;
  error?: string;
}

/** Provisioning lifecycle of a provider's in-stack Ollama model (pull, or build
 *  when a Modelfile is set), surfaced in the CLI provider form so a save shows
 *  progress without a worker restart. Cloud / remote / non-ollama providers
 *  stay 'idle' (nothing to provision locally). */
export type CliModelProvisionStatus = 'idle' | 'provisioning' | 'ready' | 'failed';

export type CliAuthStatus =
  | 'unknown'
  | 'ok'
  | 'auth_expired'
  | 'auth_denied'
  | 'rate_limited'
  | 'network_error'
  | 'timeout'
  | 'unknown_error';

export const CLI_AUTH_STATUS_VALUES: readonly CliAuthStatus[] = [
  'unknown',
  'ok',
  'auth_expired',
  'auth_denied',
  'rate_limited',
  'network_error',
  'timeout',
  'unknown_error',
] as const;

export interface CliProbePathResult {
  ok: boolean;
  detail?: string;
  error?: string;
  durationMs?: number;
  authStatus?: CliAuthStatus;
  authMessage?: string;
  // Non-blocking advisory: credentials are valid (authStatus stays `ok`) but the
  // provider will fail at run time for a reason the probe can foresee — e.g. an
  // amp account with $0 spendable balance, which can't run `amp -x`.
  warning?: string;
}

export interface CliProbeResult {
  ok: boolean;
  providerId: string;
  targetMode: CliProbeTargetMode;
  cli?: CliProbePathResult;
}

export interface CliLoginCreateJobPayload {
  providerId: string;
  userId: string;
}

export interface CliLoginCreateResult {
  ok: boolean;
  containerRowId?: string;
  dockerContainerId?: string;
  error?: string;
}

export const PUBSUB_CHANNELS = {
  TASK_PROGRESS: 'haive:task-progress',
  CLI_OUTPUT: 'haive:cli-output',
  TERMINAL: 'haive:terminal',
} as const;

/** Interactive terminal channels.
 *
 *  Architecture: API holds the WebSocket but no docker socket. Worker owns
 *  docker — it subscribes to TERMINAL_REQUEST_CHANNEL for open/close, spawns
 *  the per-(user,task,provider) container + PTY, and pipes bytes through
 *  per-session pub/sub channels. Keeps the project's "single docker-
 *  privileged service" property intact (see worker README).
 *
 *  Channels (sessionId = user_task_provider triple, sanitised):
 *    terminal:in:{sid}   — browser → shell stdin (raw bytes)
 *    terminal:out:{sid}  — shell stdout/stderr → browser (raw bytes)
 *    terminal:ctl:{sid}  — control frames (resize, signal) as JSON
 *
 *  Registry (Redis hash, one entry per session):
 *    terminal:session:{userId}:{taskId}:{providerId} — JSON
 *      { containerName, sessionId, refcount, lastSeenAt, startedAt }
 *
 *  Idle policy: refcount==0 && now-lastSeenAt > TERMINAL_IDLE_GRACE_MS
 *  → reaper kills container and deletes registry entry. */
export const TERMINAL_SESSION_PREFIX = 'terminal:session:';
export const TERMINAL_REQUEST_CHANNEL = 'terminal:request';
export const TERMINAL_IN_CHANNEL_PREFIX = 'terminal:in:';
export const TERMINAL_OUT_CHANNEL_PREFIX = 'terminal:out:';
export const TERMINAL_CTL_CHANNEL_PREFIX = 'terminal:ctl:';
/** Pub/sub channel the api publishes a user's mid-run steering message to, keyed
 *  by cli invocation id. The worker's cli-exec forwarder subscribes for the life
 *  of a steerable invocation and writes each message to the running CLI's stdin
 *  as an NDJSON user-message (applied at the next tool-call boundary). Body is
 *  the raw steer text. */
export const STEER_IN_CHANNEL_PREFIX = 'steer:in:';
/** Pub/sub channel the api publishes to when MAX_PARALLEL_AGENTS changes, so the
 *  worker live-retunes the cli-exec queue concurrency without a restart. Body is
 *  the new clamped integer as a string. */
export const CONFIG_CONCURRENCY_CHANNEL = 'config:concurrency:changed';
/** Name of a task's per-task DDEV runner container (the nested-Docker DDEV
 *  environment the worker launches). Shared because the api dials the runner by
 *  this DNS name on the internal sandbox network (browser-VNC bridge) while the
 *  worker creates/destroys it. */
export function ddevRunnerName(taskId: string): string {
  return `haive-ddev-${taskId.slice(0, 8)}`;
}
/** VNC (RFB) port of the headed-browser desktop inside the DDEV runner. */
export const DDEV_RUNNER_VNC_PORT = 5900;
/** Name of a task's per-task app-runner container — the non-DDEV runtime that
 *  runs the app AND hosts the headed-browser desktop, built from the repo's
 *  env-replicate image. Shared because the api dials it by this DNS name on the
 *  internal sandbox network (browser-VNC bridge) while the worker creates and
 *  destroys it. */
export function appRunnerName(taskId: string): string {
  return `haive-app-${taskId.slice(0, 8)}`;
}
/** Docker label marking a container as a per-task app-runner, so task-end
 *  cleanup can find and remove it (mirrors the DDEV runner's haive.ddev label). */
export const APP_RUNNER_LABEL = 'haive.apprunner';

/** Name of a task's per-task browser-IDE (code-server) container. Shared because
 *  the api reverse-proxies the editor by this DNS name on the internal sandbox
 *  network (the /ide HTTP+WS proxy) while the worker creates and destroys it. */
export function ideRunnerName(taskId: string): string {
  return `haive-ide-${taskId.slice(0, 8)}`;
}
/** Docker label marking a container as a per-task browser-IDE, so task-end
 *  cleanup finds it and the worker-boot reaper spares it while a session is live
 *  (mirrors the app-runner's haive.apprunner label). */
export const IDE_RUNNER_LABEL = 'haive.ide';
/** Port code-server binds inside the IDE container (its default). Reached by the
 *  api proxy over the sandbox network by container name; never host-published. */
export const IDE_INTERNAL_PORT = 8080;
/** Pinned code-server image. Defaults to the Open VSX extension gallery (the
 *  Microsoft Marketplace is licensed to MS products only). Bump deliberately. */
export const CODE_SERVER_IMAGE = 'codercom/code-server:4.126.0';
/** Grace after the editor tab closes (the last proxied connection drops) before
 *  the IDE container is gracefully stopped + removed. Long, because an open editor
 *  must never be reaped and a brief nav-away should survive; the per-task
 *  user-data volume persists across the reap so unsaved (hot-exit) buffers live. */
export const IDE_IDLE_GRACE_MS = 30 * 60_000;
/** Per-USER volume holding code-server extensions: install once, mounted into
 *  every task's IDE for that user. userSlug mirrors the cli-auth volume slug. */
export function ideExtensionsVolumeName(userId: string): string {
  const userSlug = userId.replace(/-/g, '').slice(0, 12);
  return `haive_ide_ext_${userSlug}`;
}
/** Per-TASK volume holding code-server user-data: the global settings.json seeded
 *  at launch, workbench state, and hot-exit backups. Persists across the idle-grace
 *  container reap so reopening restores unsaved work; destroyed only at task end. */
export function ideUserDataVolumeName(taskId: string): string {
  const taskSlug = taskId.replace(/-/g, '').slice(0, 12);
  return `haive_ide_udata_${taskSlug}`;
}
/** True for any IDE-owned Docker volume (extensions or user-data), so cleanup can
 *  target them precisely without touching unrelated volumes. */
export function isIdeVolume(name: string): boolean {
  return name.startsWith('haive_ide_ext_') || name.startsWith('haive_ide_udata_');
}
/** Redis hash key for a task's IDE session. The api owns refcount + lastSeenAt as
 *  proxied connections open/close; the worker's idle reaper reads them to grace-
 *  stop the container. One per task (the IDE has a single workspace = the task). */
export const IDE_SESSION_PREFIX = 'ide:session:';
export function ideSessionKey(taskId: string): string {
  return `${IDE_SESSION_PREFIX}${taskId}`;
}

/** A single way a user can reach a task's running web app from their OWN browser —
 *  the fast alternative to the VNC pixel stream. The worker emits these after it
 *  ensures the runtime (it alone can read the runner's live published ports); the
 *  web "Open in your browser" card renders them as links. `kind` discriminates the
 *  exposure mechanism:
 *   - `localhost`     a host-published loopback port (app-runner, and the DDEV http
 *                     fallback): `http://localhost:<port>`.
 *   - `ddev-http` / `ddev-https`  the project's `*.ddev.site` name on its published
 *                     port; the only form that routes correctly for DDEV apps that
 *                     hard-code their hostname.
 *   - `proxy-subdomain`  RESERVED for future REMOTE access via an authed api reverse
 *                     proxy (`<task>.apps.<haive-domain>`). No worker emits this yet
 *                     — it marks the seam so the remote build slots in without a
 *                     shape change.
 *   - `database`      a DDEV project's database on a published loopback port (opt-in
 *                     per task). `url` is a ready connection URI; engine/host/port/
 *                     user/password/database carry the parts a local DB client needs.
 *                     Remote DB access will ride the same `proxy-subdomain` seam. */
export interface TaskAccessEndpoint {
  kind: 'localhost' | 'ddev-http' | 'ddev-https' | 'proxy-subdomain' | 'database';
  /** Short link label, e.g. "Localhost" or "DDEV (HTTPS)". */
  label: string;
  /** Absolute URL the user opens in their browser. For `database` this is a ready
   *  connection URI (e.g. `mysql://db:db@127.0.0.1:<port>/db`), not a browser link. */
  url: string;
  /** True when the browser trusts the TLS cert without a warning (the stable baked
   *  CA covers `ddev-https` once the user installs it); omitted for plain http. */
  trusted?: boolean;
  /** Database-endpoint parts (kind `database` only), rendered as copyable fields.
   *  `engine` is the DDEV db type: `mysql` | `mariadb` | `postgres`. */
  engine?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

/** Deterministic loopback host port for publishing a task's runtime to the user's
 *  browser (direct browser access). Keyed on the taskId so a task's URL stays
 *  stable across runner restarts, drawn from the ephemeral range 49152–65535.
 *  `slot` separates a DDEV runner's https (0) and http (1) ports; `attempt` shifts
 *  the candidate when a host-port bind collides (the worker retries with the next
 *  attempt). Pure (FNV-1a) so the worker and any caller derive the same value. */
export function taskHostPort(taskId: string, slot = 0, attempt = 0): number {
  const RANGE_START = 49152;
  const RANGE_SIZE = 65536 - RANGE_START; // 16384 ephemeral ports
  let h = 2166136261; // FNV-1a offset basis
  const key = `${taskId}:${slot}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const base = (h >>> 0) % RANGE_SIZE;
  return RANGE_START + ((base + attempt * 257) % RANGE_SIZE);
}
/** Two minutes of grace after the last WS disconnect before a session's
 *  container is reaped. Long enough to survive a tab nav-away-and-return,
 *  short enough that abandoned sessions don't pile up under WSL's container
 *  ceiling. */
export const TERMINAL_IDLE_GRACE_MS = 120_000;

/** Reply channel for an open request. API publishes to TERMINAL_REQUEST_CHANNEL
 *  with a correlationId, then BLPOPs / SUBSCRIBEs this channel for the worker's
 *  ack. We use a dedicated reply channel rather than reusing TERMINAL_OUT_*
 *  because the latter is per-session and the sessionId isn't known until the
 *  worker has minted it. */
export const TERMINAL_REPLY_CHANNEL_PREFIX = 'terminal:reply:';

/** Wire types for the request channel. The worker dispatches on `op`. */
export interface TerminalOpenRequest {
  op: 'open';
  correlationId: string;
  userId: string;
  cliProviderId: string;
  /** Session scope. Omitted is treated as 'task' for backward compatibility. */
  scope?: 'task' | 'repo';
  /** Present for task scope (the per-task sandbox shell). */
  taskId?: string;
  /** Present for repo scope (the standalone per-repository shell). */
  repositoryId?: string;
}

/** Redis registry key for an interactive terminal session. Task scope keeps the
 *  original `{userId}:{id}:{providerId}` shape; repo scope inserts a `repo:`
 *  infix so the per-task reaper pattern (`*:{taskId}:*`) can never match a repo
 *  session. Shared so the API (refcount owner) and the worker (metadata writer)
 *  cannot drift on the key. */
export function terminalSessionKey(
  userId: string,
  scope: 'task' | 'repo',
  scopeId: string,
  providerId: string,
): string {
  const mid = scope === 'repo' ? `repo:${scopeId}` : scopeId;
  return `${TERMINAL_SESSION_PREFIX}${userId}:${mid}:${providerId}`;
}

export interface TerminalCloseRequest {
  op: 'close';
  sessionId: string;
}

export type TerminalRequest = TerminalOpenRequest | TerminalCloseRequest;

export interface TerminalOpenReply {
  ok: true;
  sessionId: string;
  containerName: string;
  shell: 'bash' | 'sh';
}

export interface TerminalOpenError {
  ok: false;
  error: string;
}

export type TerminalOpenResult = TerminalOpenReply | TerminalOpenError;

/** Control frame published by API to terminal:ctl:{sid}. xterm fires resize
 *  on window resize; the worker forwards new dimensions to the PTY via
 *  TIOCSWINSZ-equivalent (we just stream the cols/rows to docker exec stdin
 *  via SIGWINCH on the child). */
export interface TerminalResizeFrame {
  type: 'resize';
  cols: number;
  rows: number;
}

export type TerminalControlFrame = TerminalResizeFrame;

export const FRAMEWORK_PATTERNS = {
  wordpress: {
    indicators: ['wp-content/', 'wp-admin/', 'wp-includes/'],
    excludePaths: ['wp-admin/', 'wp-includes/', 'wp-content/plugins/', 'wp-content/themes/'],
    customPaths: ['wp-content/themes/'],
  },
  drupal: {
    indicators: ['core/', 'modules/', 'themes/', 'sites/'],
    excludePaths: ['core/', 'modules/contrib/', 'themes/contrib/', 'vendor/'],
    customPaths: ['modules/custom/', 'themes/custom/'],
  },
  drupal7: {
    indicators: ['sites/all/modules/', 'sites/all/themes/', 'includes/bootstrap.inc'],
    excludePaths: ['sites/all/libraries/', 'sites/default/files/', 'includes/'],
    customPaths: ['sites/all/modules/custom/', 'sites/all/themes/custom/'],
  },
  rails: {
    indicators: ['Gemfile', 'app/', 'config/', 'db/'],
    excludePaths: ['vendor/', 'tmp/', 'log/'],
    customPaths: ['app/', 'lib/', 'config/'],
  },
  laravel: {
    indicators: ['artisan', 'composer.json', 'app/', 'routes/'],
    excludePaths: ['vendor/', 'storage/', 'bootstrap/cache/'],
    customPaths: ['app/', 'routes/', 'resources/', 'config/', 'database/'],
  },
  nodejs: {
    indicators: ['package.json', 'node_modules/'],
    excludePaths: ['node_modules/', 'dist/', 'build/', '.next/', 'coverage/'],
    customPaths: ['src/', 'lib/', 'app/'],
  },
  nextjs: {
    indicators: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'app/', 'pages/'],
    excludePaths: ['node_modules/', '.next/', 'out/', 'coverage/'],
    customPaths: ['src/', 'app/', 'pages/', 'components/'],
  },
  python: {
    indicators: ['requirements.txt', 'setup.py', 'pyproject.toml'],
    excludePaths: ['venv/', '.venv/', 'site-packages/', '__pycache__/', '.tox/'],
    customPaths: ['src/', 'app/', 'lib/'],
  },
  django: {
    indicators: ['manage.py', 'settings.py', 'wsgi.py'],
    excludePaths: ['venv/', '.venv/', 'static/', 'media/', 'migrations/'],
    customPaths: ['src/', 'apps/'],
  },
  go: {
    indicators: ['go.mod', 'go.sum'],
    excludePaths: ['vendor/', 'bin/'],
    customPaths: ['cmd/', 'internal/', 'pkg/'],
  },
  rust: {
    indicators: ['Cargo.toml', 'Cargo.lock', 'src/'],
    excludePaths: ['target/'],
    customPaths: ['src/', 'crates/'],
  },
  general: {
    indicators: [],
    excludePaths: ['.git/', '.svn/', '.hg/', '.DS_Store', 'Thumbs.db'],
    customPaths: [],
  },
} as const;

export type FrameworkName = keyof typeof FRAMEWORK_PATTERNS;

export const DEFAULT_EXCLUDED_PATTERNS = [
  '*.jpg',
  '*.jpeg',
  '*.png',
  '*.gif',
  '*.ico',
  '*.svg',
  '*.webp',
  '*.mp3',
  '*.mp4',
  '*.wav',
  '*.avi',
  '*.mov',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.rar',
  '*.7z',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.xls',
  '*.xlsx',
  '*.min.js',
  '*.min.css',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
] as const;

/**
 * Filename/path globs for files that may carry secrets and must be hidden from
 * AI CLI agents. The worker masks each match with an empty read-only file inside
 * the cli-exec sandbox (CLI-agnostic read-block — see
 * packages/worker/src/queues/cli-exec/secret-mask.ts). Matched with
 * tinyglobby/picomatch semantics under `dot: true`, so both `**` and `*.ext`
 * work and leading-dot files are matched.
 *
 * Bare `*.sql` is intentionally NOT here: it would mask schema/migration SQL
 * the agent must read (e.g. this repo's database migrations). Users who treat
 * `.sql` as dumps add it per-repo via `secretMaskDenyExtend`.
 */
export const DEFAULT_SECRET_DENY_GLOBS = [
  // env files
  '**/.env',
  '**/.env.*',
  // private keys / certificates
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.p8',
  '**/*.jks',
  '**/*.keystore',
  '**/*.asc',
  // ssh keys
  '**/id_rsa',
  '**/id_dsa',
  '**/id_ecdsa',
  '**/id_ed25519',
  '**/*_rsa',
  '**/.ssh/**',
  // cloud / service-account credentials
  '**/.aws/credentials',
  '**/.aws/config',
  '**/service-account*.json',
  '**/gcp-*.json',
  '**/.azure/**',
  '**/kubeconfig',
  '**/.kube/config',
  '**/.docker/config.json',
  // package / registry auth
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/.cargo/credentials*',
  '**/.terraformrc',
  // framework config secrets (Drupal/PHP). settings.local.php holds real DB
  // creds + hash salt and is normally untracked; a tracked settings.php is
  // skipped by the untracked filter, so only a local creds-bearing one is
  // masked. The `default.settings.php` / `settings.example.php` scaffolding is
  // NOT matched (different basename), so it stays readable.
  '**/settings.local.php',
  '**/settings.php',
  // terraform state / vars
  '**/*.tfstate',
  '**/*.tfstate.*',
  '**/*.tfvars',
  '**/*.tfvars.json',
  // backups / editor leftovers
  '**/*.bak',
  '**/*.bckp',
  '**/*.bkp',
  '**/*.backup',
  '**/*.old',
  '**/*.orig',
  '**/*~',
  '**/*.swp',
  '**/*.swo',
  // database dumps
  '**/*.dump',
  '**/*.dmp',
  '**/*.bson',
  '**/*.rdb',
  '**/*.sql.gz',
  '**/*.sql.bz2',
  '**/*.sql.xz',
  '**/*.sql.zst',
  '**/dump.sql',
  '**/*-dump.sql',
  '**/*.dump.sql',
  '**/backup*.sql',
  '**/*-backup.sql',
  '**/db_backup*',
  // local databases
  '**/*.sqlite',
  '**/*.sqlite3',
  // misc secret stores
  '**/secrets.*',
  '**/*secret*.{yml,yaml}',
  '**/.vault-token',
  '**/*.gpg',
] as const;

/**
 * Globs that stay readable even when they also match a deny glob: example/sample
 * configs and public-key material. Applied as ignore patterns over the matches,
 * so e.g. `.env.example` survives the `.env.*` deny.
 */
export const DEFAULT_SECRET_CARVEOUTS = [
  '**/*.example',
  '**/*.sample',
  '**/*.template',
  '**/*.dist',
  '**/*.defaults',
  '**/example.*',
  '**/*.pub',
  '**/known_hosts',
  '**/*.tfvars.example',
] as const;

/**
 * Directories never scanned for secrets (performance + relevance). A secret
 * planted inside one of these is not a new leak: an agent would have had to read
 * the original to copy it there.
 */
export const SECRET_SCAN_IGNORE_DIRS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
] as const;

/** Max masks emitted per invocation; excess is dropped with a warning. */
export const SECRET_MASK_LIMIT = 500;

export interface SecretMaskGlobs {
  /** Patterns to match — the files to mask. */
  deny: string[];
  /** Patterns to ignore — carve-outs, per-repo allow list, structural dirs. */
  ignore: string[];
}

/**
 * Effective deny/ignore glob sets for a repo's secret masking:
 *   deny   = DEFAULT_SECRET_DENY_GLOBS ∪ denyExtend
 *   ignore = DEFAULT_SECRET_CARVEOUTS ∪ allow ∪ SECRET_SCAN_IGNORE_DIRS
 * The matcher returns files matching `deny` minus those matching `ignore`, so
 * `allow` un-masks specific files and `denyExtend` adds globs.
 */
export function computeEffectiveSecretGlobs(opts: {
  allow?: string[] | null;
  denyExtend?: string[] | null;
}): SecretMaskGlobs {
  const deny = [...new Set([...DEFAULT_SECRET_DENY_GLOBS, ...(opts.denyExtend ?? [])])];
  const ignore = [
    ...new Set([...DEFAULT_SECRET_CARVEOUTS, ...(opts.allow ?? []), ...SECRET_SCAN_IGNORE_DIRS]),
  ];
  return { deny, ignore };
}
