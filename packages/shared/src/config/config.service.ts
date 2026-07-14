import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { createRedisConnection } from '../utils/redis-factory.js';
import { logger } from '../logger/index.js';

/** Default per-file cap for task attachments (25 MiB). Admin-tunable via
 *  CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES. */
export const DEFAULT_TASK_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export const CONFIG_KEYS = {
  DATABASE_URL: 'config:database:url',
  API_PORT: 'config:server:apiPort',

  JWT_ACCESS_TTL: 'config:jwt:accessTtl',
  JWT_REFRESH_TTL: 'config:jwt:refreshTtl',

  RATE_LIMIT_API_RPM: 'config:rateLimit:api:requestsPerMinute',
  RATE_LIMIT_AUTH_RPM: 'config:rateLimit:auth:requestsPerMinute',

  SMTP_HOST: 'config:email:smtpHost',
  SMTP_PORT: 'config:email:smtpPort',
  SMTP_USER: 'config:email:smtpUser',
  SMTP_FROM: 'config:email:from',
  SMTP_FROM_NAME: 'config:email:fromName',

  // Max CLI/agent invocations that run in parallel GLOBALLY: bounds the cli-exec
  // queue concurrency AND the in-process fan-out limiter (e.g. DAG coders,
  // onboarding fan-outs). User-tunable per host capacity (>= 1; no upper limit —
  // some machines handle 10+).
  MAX_PARALLEL_AGENTS: 'config:worker:maxParallelAgents',
  // Per-task cap: max CLI/agent invocations a SINGLE task may run at once. Bounds
  // one task's share of the global pool (above) so a task's fan-out can't seize
  // every slot. Enforced by deferring a task's over-cap jobs at pickup. >= 1;
  // only binds when set below MAX_PARALLEL_AGENTS. Replaces the unused
  // WORKER_CONCURRENCY scaffold key.
  MAX_PARALLEL_AGENTS_PER_TASK: 'config:worker:maxParallelAgentsPerTask',
  // Minimum CLI-invocation timeout (ms) for Ollama providers. A CLI invocation
  // wraps a whole multi-turn agentic session, and local inference on weak
  // hardware can take many minutes per turn; this floors the per-step timeout so
  // a slow session isn't killed mid-generation. Default 2 h; raise for very
  // slow setups.
  OLLAMA_CLI_TIMEOUT_MS: 'config:worker:ollamaCliTimeoutMs',
  // When 'true', local in-stack Ollama models are allowed to run steps flagged
  // unsafeForLocalModels (skill generation, code simplification). Default false:
  // those steps fail for local models with an actionable message.
  ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS: 'config:worker:allowLocalModelDestructiveSteps',
  // Global kill-switch for the model-health canary: a tiny first step (00-model-health)
  // that fails a task/onboarding loudly when the configured model can't emit valid
  // fenced JSON / follow instructions. Default true; set 'false' to skip the canary.
  MODEL_HEALTH_CHECK_ENABLED: 'config:worker:modelHealthCheckEnabled',
  // Global kill-switch for fair cli-exec scheduling. When 'true' (default), each
  // CLI invocation is enqueued with a BullMQ priority equal to the enqueuing user's
  // in-flight invocation backlog, so a freed concurrency slot goes to the most-
  // starved user instead of the next FIFO job from one task's fan-out. Set 'false'
  // to restore plain FIFO live without a redeploy.
  FAIR_SCHEDULING_ENABLED: 'config:worker:fairScheduling',
  // Global opt-in (default OFF) for the 1-hour prompt-cache TTL on Claude-family CLI
  // steps. When 'true', cli-exec sets ENABLE_PROMPT_CACHING_1H=1 so API-key / Bedrock /
  // Vertex claude runs use the 1h cache TTL (subscription auth is already 1h
  // automatically). The 1h cache write costs 2x base input vs the 5-min default's 1.25x,
  // so it only pays off when a step reuses the cached prefix 2+ times within the hour;
  // leave OFF unless the per-step token panel shows that reuse. Read per cli dispatch
  // (~30s config cache); a flip needs no redeploy.
  PROMPT_CACHING_1H: 'config:caching:promptCaching1h',

  HOST_REPO_ROOT: 'config:filesystem:hostRepoRoot',
  REPO_STORAGE_PATH: 'config:filesystem:repoStoragePath',

  CLAWKER_BIN: 'config:sandbox:clawkerBin',
  SANDBOX_NETWORK: 'config:sandbox:network',
  // Global kill-switch for secret-file masking (hides deny-listed files from AI
  // CLI agents in the cli-exec sandbox). Default true; set 'false' to disable
  // masking for every repo without per-repo edits or a redeploy.
  SECRET_MASK_ENABLED: 'config:sandbox:secretMaskEnabled',
  // Global kill-switch for direct browser access: when 'true' (default), each
  // per-task runner publishes its app port to 127.0.0.1 at startup so the user
  // can open the app in their own browser (localhost + *.ddev.site URLs), a fast
  // alternative to the VNC pixel stream. Set 'false' to stop publishing host
  // ports everywhere (runners start with no -p, exactly the pre-feature behavior)
  // without a redeploy. Read at runner START, so a mid-task flip needs a restart.
  BROWSER_DIRECT_ACCESS: 'config:sandbox:browserDirectAccess',
  // Global kill-switch for direct database access: when 'true' (default), each
  // per-task DDEV runner reserves a loopback host port at startup that a user can
  // expose their project's database on (opt-in per task), so a local DB client can
  // connect to 127.0.0.1:<port>. Set 'false' to stop reserving the port and refuse
  // the per-task opt-in everywhere, without a redeploy. Read at runner START (the
  // port reservation) and per bring-up (the socat listener), so a mid-task flip
  // needs a runner restart to change the reservation.
  DB_DIRECT_ACCESS: 'config:sandbox:dbDirectAccess',
  // Global switch for mid-run steering (default ON; a kill-switch). When 'true',
  // every Claude-family CLI step runs in stream-json input mode so a user can
  // inject steering messages (applied at the next tool-call boundary), and each
  // steer is mined into the KB. Set 'false' to disable steering everywhere
  // without a redeploy. Steering is a uniform UX affordance, so this is the only
  // toggle — there is no per-repo flag.
  STEERING_ENABLED: 'config:steering:enabled',

  // Soft timeout for steerable CLI invocations (default ON). The hard timeout is a
  // zero-grace SIGKILL, so a reviewer killed at its budget loses every finding it
  // made. At CLI_SOFT_TIMEOUT_PERCENT of the budget the worker publishes a wind-down
  // to the invocation's steer channel (CLI_SOFT_TIMEOUT_WIND_DOWN): stop investigating,
  // emit the verified findings now. Set 'false' to go back to the bare hard kill.
  //
  // Steer-delivered, so it reaches ONLY invocations that are actually steerable —
  // Claude-family adapters, and only while STEERING_ENABLED is on. Non-steerable
  // adapters (codex, gemini, amp, antigravity) are unaffected either way.
  CLI_SOFT_TIMEOUT_ENABLED: 'config:cli:softTimeoutEnabled',
  // Percent of the invocation's timeout budget at which the wind-down fires (default
  // 80). An integer, not a fraction, because configService.getNumber parses with
  // parseInt — 0.8 would read as 0 and fire the wind-down instantly. Clamped to
  // 1..99: at 0 or 100 the wind-down is either useless or unsendable, so both
  // disable it. Steers apply at the next tool-call boundary, so the remaining
  // percent must cover a boundary plus the JSON write (20% of 30min = 6 min).
  CLI_SOFT_TIMEOUT_PERCENT: 'config:cli:softTimeoutPercent',

  // Global kill-switch for the subscription usage-window display (claude-hud-style
  // 5h/weekly meters in the task header). When 'true' (default), a gentle background
  // poller reads each logged-in provider's (undocumented) usage endpoint and the task
  // header shows the active step's CLI windows. Set 'false' to stop all usage polling
  // and hide the chip everywhere without a redeploy. Read by the poller each tick
  // (~30s config cache).
  USAGE_WINDOW_ENABLED: 'config:usage:windowEnabled',

  // Global kill-switch for the in-task browser IDE (code-server Editor tab).
  // When 'true' (default), the web exposes the Editor tab and the api/worker
  // lazily launch a per-task code-server container. Set 'false' to hide the
  // Editor tab and refuse IDE launches everywhere (the read-only Source viewer
  // remains the fallback) without a redeploy.
  IDE_ENABLED: 'config:ide:enabled',

  // Global kill-switch for on-demand step-debugging. When 'true' (default), the
  // 01-debug-mode step is offered (asks per task whether to wire step-debugging into
  // the runtime: PHP/Xdebug under DDEV, JS via the VNC browser CDP, Node --inspect).
  // Set 'false' to skip that step everywhere (tasks run with debug_mode off, no debug
  // overhead) without a redeploy. Read by the step's shouldRun within the ~30s config
  // cache; persists across restarts.
  DEBUG_MODE_ENABLED: 'config:debug:enabled',

  // Global kill-switch for the DDEV-control MCP. When 'true' (default), a DDEV task's
  // AI CLI gets a `ddev-control` MCP server (ddev_status / ddev_logs / ddev_restart)
  // that proxies through the api to the worker's ddevExec, so the agent can inspect and
  // recover its OWN per-task DDEV when the app 404s. Set 'false' to stop injecting that
  // server everywhere (no redeploy). Read at cli-exec invocation build time.
  DDEV_CONTROL_MCP_ENABLED: 'config:ddev:controlMcpEnabled',

  // Global kill-switch for the DDEV image pull-through cache. When 'true' (default),
  // each per-task DDEV runner routes its nested dockerd Docker Hub pulls through a
  // shared registry mirror (a singleton registry:2 proxy on a persistent volume), so a
  // repo's DDEV base images are pulled from Hub once and served locally to every later
  // task instead of re-pulled per task (the runner's nested image store is dropped at
  // teardown). Read at runner START; OFF => runners pull direct from Docker Hub (a
  // mid-task flip needs Stop/Retry). Persists across restarts.
  DDEV_REGISTRY_CACHE_ENABLED: 'config:ddev:registryCache',

  // When 'true', the usage poller AUTO-resumes a task that FAILED on a provider
  // session/rate-limit once that provider's allowance resets — resume semantics, so
  // completed loop passes are preserved — capped at ALLOWANCE_AUTO_RESUME_CAP consecutive
  // auto-resumes before falling back to notify-only. Default 'false' = notify-only (the
  // user resumes manually, today's behavior). Read once per usage-poll tick.
  AUTO_RESUME_ON_ALLOWANCE: 'config:tasks:autoResumeOnAllowance',

  // Per-file size cap (bytes) for user-uploaded task attachments. Enforced by the
  // attachment upload endpoint (streamed; aborts once the byte count exceeds it).
  // Admin-tunable; default DEFAULT_TASK_ATTACHMENT_MAX_BYTES (25 MiB).
  TASK_ATTACHMENT_MAX_BYTES: 'config:tasks:attachmentMaxBytes',

  APP_URL: 'config:app:url',

  ENCRYPTION_KEY: 'bootstrap:encryptionKey',

  MAINTENANCE_MODE: 'config:deployment:maintenanceMode',
  MAINTENANCE_MESSAGE: 'config:deployment:maintenanceMessage',

  // Global cross-task KB (separate DB; see plan luminous-weaving-archive.md §4).
  // Non-secret settings only; the external connection string is a SecretsService
  // secret (SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING), never plaintext config.
  GLOBAL_KB_ENABLED: 'config:globalKb:enabled',
  GLOBAL_KB_MODE: 'config:globalKb:mode',
  GLOBAL_KB_NAMESPACE: 'config:globalKb:namespace',
  GLOBAL_KB_OLLAMA_URL: 'config:globalKb:ollamaUrl',
  GLOBAL_KB_EMBED_MODEL: 'config:globalKb:embedModel',
  GLOBAL_KB_EMBED_DIMS: 'config:globalKb:embedDims',
  GLOBAL_KB_ARCHIVE_RETENTION_DAYS: 'config:globalKb:archiveRetentionDays',

  // Global terseness level for agent OUTPUT prose, applied as a directive appended to
  // each CLI step's main prompt (lite | full | ultra; default full). Only the model's
  // prose is affected — the directive carves out JSON/code/diffs/specs so structured
  // output stays exact, and reasoning (extended thinking) is a separate channel left
  // untouched. The manifest-hashed agent .md files keep the fixed 'full' block; this
  // level governs only the runtime step-prompt injection. Read per cli dispatch (~30s
  // config cache); a change needs no redeploy.
  TERSENESS_LEVEL: 'config:output:tersenessLevel',

  // Opt-in (default off): condense the spec passed to the 08c code-review fan-out and
  // write the full spec to a worktree artifact reviewers can Read on demand. Trims the
  // duplicated spec input across the parallel reviewers; lossy but retrievable. Caching
  // can't dedup the fan-out (separate sessions), so this is the only lever — kept off by
  // default until token metrics justify it.
  REVIEW_FANOUT_DISTILL: 'config:output:reviewFanoutDistill',

  // Refutation pass over 08c's BLOCKING review findings (default ON). Each such finding
  // routes the change back through implementation and costs one of the capped fix
  // rounds, so before that happens a refuter per finding is asked to disprove it against
  // the code. A finding is dismissed only on positive, cited evidence that it is wrong;
  // an uncertain, unparseable or failed refuter leaves it standing. Costs one extra CLI
  // invocation per blocking finding, only in a round that has one. Set 'false' to block
  // on the reviewers' word alone. Read per 08c apply (~30s config cache).
  REVIEW_REFUTE_ENABLED: 'config:review:refuteEnabled',
} as const;

/** Allowed terseness levels for CONFIG_KEYS.TERSENESS_LEVEL (output prose only). */
export const TERSENESS_LEVELS = ['lite', 'full', 'ultra'] as const;
export type TersenessLevel = (typeof TERSENESS_LEVELS)[number];

const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.API_PORT]: '3001',
  [CONFIG_KEYS.JWT_ACCESS_TTL]: '15m',
  [CONFIG_KEYS.JWT_REFRESH_TTL]: '7d',
  [CONFIG_KEYS.RATE_LIMIT_API_RPM]: '60',
  [CONFIG_KEYS.RATE_LIMIT_AUTH_RPM]: '10',
  [CONFIG_KEYS.SMTP_HOST]: 'mailpit',
  [CONFIG_KEYS.SMTP_PORT]: '1025',
  [CONFIG_KEYS.SMTP_FROM]: 'no-reply@haive.local',
  [CONFIG_KEYS.SMTP_FROM_NAME]: 'Haive',
  [CONFIG_KEYS.MAX_PARALLEL_AGENTS]: '3',
  [CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK]: '5',
  [CONFIG_KEYS.OLLAMA_CLI_TIMEOUT_MS]: '7200000',
  [CONFIG_KEYS.ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS]: 'false',
  [CONFIG_KEYS.MODEL_HEALTH_CHECK_ENABLED]: 'true',
  [CONFIG_KEYS.FAIR_SCHEDULING_ENABLED]: 'true',
  [CONFIG_KEYS.PROMPT_CACHING_1H]: 'false',
  [CONFIG_KEYS.HOST_REPO_ROOT]: '/host-fs',
  [CONFIG_KEYS.REPO_STORAGE_PATH]: '/var/lib/haive/repos',
  [CONFIG_KEYS.CLAWKER_BIN]: '/usr/local/bin/clawker',
  [CONFIG_KEYS.SANDBOX_NETWORK]: 'haive-network',
  [CONFIG_KEYS.SECRET_MASK_ENABLED]: 'true',
  [CONFIG_KEYS.STEERING_ENABLED]: 'true',
  [CONFIG_KEYS.CLI_SOFT_TIMEOUT_ENABLED]: 'true',
  [CONFIG_KEYS.CLI_SOFT_TIMEOUT_PERCENT]: '80',
  [CONFIG_KEYS.USAGE_WINDOW_ENABLED]: 'true',
  [CONFIG_KEYS.IDE_ENABLED]: 'true',
  [CONFIG_KEYS.DEBUG_MODE_ENABLED]: 'true',
  [CONFIG_KEYS.DDEV_CONTROL_MCP_ENABLED]: 'true',
  [CONFIG_KEYS.DDEV_REGISTRY_CACHE_ENABLED]: 'true',
  [CONFIG_KEYS.AUTO_RESUME_ON_ALLOWANCE]: 'false',
  [CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES]: String(DEFAULT_TASK_ATTACHMENT_MAX_BYTES),
  [CONFIG_KEYS.APP_URL]: 'http://localhost:3000',
  [CONFIG_KEYS.MAINTENANCE_MODE]: 'false',
  [CONFIG_KEYS.MAINTENANCE_MESSAGE]: 'Maintenance in progress. Please check back shortly.',
  // Global KB defaults: feature ON (no backward-compat concern; kept as a
  // kill-switch), Haive-hosted internal DB, single shared corpus, per-repo
  // default embedding dims. Ollama URL / model stay unset (null) until
  // configured → query falls back to deterministic hash embedding.
  [CONFIG_KEYS.GLOBAL_KB_ENABLED]: 'true',
  [CONFIG_KEYS.GLOBAL_KB_MODE]: 'internal',
  [CONFIG_KEYS.GLOBAL_KB_NAMESPACE]: 'default',
  [CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS]: '2560',
  [CONFIG_KEYS.TERSENESS_LEVEL]: 'full',
  [CONFIG_KEYS.REVIEW_FANOUT_DISTILL]: 'false',
  [CONFIG_KEYS.REVIEW_REFUTE_ENABLED]: 'true',
};

export class ConfigService {
  private redis: Redis | null = null;
  private initialized = false;
  private localCache = new Map<string, { value: string | null; expiresAt: number }>();
  private static LOCAL_CACHE_TTL_MS = 30_000;

  async initialize(redisUrl?: string): Promise<void> {
    if (this.initialized) return;

    const url = redisUrl ?? process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL environment variable is required');
    }

    this.redis = createRedisConnection(url);

    await new Promise<void>((resolve, reject) => {
      this.redis!.once('ready', resolve);
      this.redis!.once('error', reject);
    });

    await this.seedDefaults();
    await this.ensureEncryptionKey();

    this.initialized = true;
    logger.info('ConfigService initialized');
  }

  private async seedDefaults(): Promise<void> {
    const pipeline = this.redis!.pipeline();
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      pipeline.setnx(key, value);
    }
    const results = await pipeline.exec();
    if (results?.some(([, result]) => result === 1)) {
      logger.info('Default configuration seeded');
    }
  }

  private async ensureEncryptionKey(): Promise<void> {
    const exists = await this.redis!.exists(CONFIG_KEYS.ENCRYPTION_KEY);
    const envKey = this.getEnvEncryptionKey();

    if (!exists) {
      if (envKey) {
        await this.redis!.set(CONFIG_KEYS.ENCRYPTION_KEY, envKey);
        logger.info('Seeded encryption key from CONFIG_ENCRYPTION_KEY');
        return;
      }
      const generated = randomBytes(32).toString('hex');
      await this.redis!.set(CONFIG_KEYS.ENCRYPTION_KEY, generated);
      logger.warn('Generated new encryption key (CONFIG_ENCRYPTION_KEY not set)');
      return;
    }

    if (envKey) {
      const stored = await this.redis!.get(CONFIG_KEYS.ENCRYPTION_KEY);
      if (stored && stored !== envKey) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error(
            'CONFIG_ENCRYPTION_KEY does not match the key stored in Redis. Aborting to prevent data corruption.',
          );
        }
        logger.warn('CONFIG_ENCRYPTION_KEY does not match Redis encryption key');
      }
    }
  }

  async get(key: string): Promise<string | null> {
    this.ensureInitialized();
    const cached = this.localCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    const value = await this.redis!.get(key);
    this.localCache.set(key, {
      value,
      expiresAt: Date.now() + ConfigService.LOCAL_CACHE_TTL_MS,
    });
    return value;
  }

  async getNumber(key: string, defaultValue = 0): Promise<number> {
    const value = await this.get(key);
    if (value === null) return defaultValue;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }

  async getBoolean(key: string, defaultValue = false): Promise<boolean> {
    const value = await this.get(key);
    if (value === null) return defaultValue;
    return value === 'true' || value === '1';
  }

  async set(key: string, value: string): Promise<void> {
    this.ensureInitialized();
    await this.redis!.set(key, value);
    this.localCache.delete(key);
  }

  clearCache(): void {
    this.localCache.clear();
  }

  async getEncryptionKey(): Promise<string> {
    const key = await this.get(CONFIG_KEYS.ENCRYPTION_KEY);
    if (!key) {
      const envKey = this.getEnvEncryptionKey();
      if (envKey) {
        await this.redis!.set(CONFIG_KEYS.ENCRYPTION_KEY, envKey);
        return envKey;
      }
      throw new Error('Encryption key not found');
    }
    return key;
  }

  getRedis(): Redis {
    this.ensureInitialized();
    return this.redis!;
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.initialized = false;
    }
  }

  private getEnvEncryptionKey(): string | null {
    const raw = process.env.CONFIG_ENCRYPTION_KEY?.trim();
    if (!raw) return null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return raw.toLowerCase();
    }
    try {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === 32) {
        return decoded.toString('hex');
      }
    } catch {
      // Ignore invalid base64
    }
    logger.warn('CONFIG_ENCRYPTION_KEY must be 64 hex chars or base64-encoded 32 bytes');
    return null;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ConfigService not initialized. Call initialize() first.');
    }
  }
}

export const configService = new ConfigService();
