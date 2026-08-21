import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { createRedisConnection } from '../utils/redis-factory.js';
import { logger } from '../logger/index.js';
import {
  DEFAULT_CHROME_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_CLI_TIMEOUT_BASE_MINUTES,
  DEFAULT_CLI_TIMEOUT_LADDER,
} from '../constants/index.js';

/** Default per-file cap for task attachments (25 MiB). Admin-tunable via
 *  CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES. */
export const DEFAULT_TASK_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Default retention window for CLI transcripts: 0 = keep forever. Off by default
 *  because the sweep nulls the column and that cannot be undone. Admin-tunable via
 *  CONFIG_KEYS.CLI_STREAM_LOG_RETENTION_DAYS. */
export const DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS = 0;

export const CONFIG_KEYS = {
  DATABASE_URL: 'config:database:url',
  API_PORT: 'config:server:apiPort',

  RATE_LIMIT_API_RPM: 'config:rateLimit:api:requestsPerMinute',
  RATE_LIMIT_AUTH_RPM: 'config:rateLimit:auth:requestsPerMinute',

  SMTP_HOST: 'config:email:smtpHost',
  SMTP_PORT: 'config:email:smtpPort',
  SMTP_USER: 'config:email:smtpUser',
  SMTP_FROM: 'config:email:from',
  SMTP_FROM_NAME: 'config:email:fromName',

  // Max CLI/agent invocations that run in parallel GLOBALLY: bounds the cli-exec
  // queue concurrency AND the in-process fan-out limiter (e.g. DAG coders,
  // onboarding fan-outs). A positive value pins it (no upper limit — some machines
  // handle 10+). 0 = auto: sized from the host RAM budget the runtime pool is not
  // holding, so agents use the headroom when no DDEV runner is up and fall back to
  // the agent floor when the pool is full (deriveAgentConcurrency).
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
  // Whether a requested-vs-served model mismatch FAILS the model-health canary.
  // Default 'false': the canary records both and warns, but the task runs. A
  // mismatch is not inherently an error — claude-code legitimately resolves an
  // alias to a dated snapshot — so failing by default would break normal runs.
  // Set 'true' when a provider must be pinned exactly and a silent upstream swap
  // (measured: zai served glm-5.3 for a glm-5.2[1m] request) should stop the task.
  MODEL_IDENTITY_STRICT: 'config:worker:modelIdentityStrict',
  // Global kill-switch for fair cli-exec scheduling. When 'true' (default), each
  // CLI invocation is enqueued with a BullMQ priority equal to the enqueuing user's
  // in-flight invocation backlog, so a freed concurrency slot goes to the most-
  // starved user instead of the next FIFO job from one task's fan-out. Set 'false'
  // to restore plain FIFO live without a redeploy.
  FAIR_SCHEDULING_ENABLED: 'config:worker:fairScheduling',
  // Global pause switch (default 'false'). When 'true' the orchestrator stops handing
  // out work everywhere: no step advances and no queued CLI invocation is picked up.
  // A CLI already RUNNING is never interrupted — it finishes, as it does for a per-task
  // pause. Deliberately scoped to orchestration: terminals, the browser IDE, VNC,
  // DDEV/app runners and the login/probe/version jobs keep working, so a frozen system
  // stays debuggable. Read per advance and per cli-exec pickup (~30s config cache), so a
  // flip needs no redeploy and no live-retune channel.
  GLOBAL_PAUSE: 'config:orchestrator:globalPause',
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

  // Escalating hard-timeout ladder for CLI invocations. The hard timeout is a
  // zero-grace SIGKILL, and a re-dispatch after one used to hand the SAME budget to a
  // run we already know needs more (07b's fixer burned 3 x 31 min and produced
  // nothing). The budget an invocation gets is
  //   max(step's declared timeoutMs, CLI_TIMEOUT_BASE_MINUTES) * CLI_TIMEOUT_LADDER[n]
  // where n counts the CONSECUTIVE prior timeouts on that step. Defaults give a 30-min
  // step 45/60/90 and a 60-min step 60/80/120. Only timeouts advance the ladder — a
  // worker-restart orphan never got its time, so it retries at the same rung.
  CLI_TIMEOUT_BASE_MINUTES: 'config:cli:timeoutBaseMinutes',
  // Comma-separated multipliers applied to the base, one per attempt; the last entry
  // repeats if attempts somehow exceed it. Fractional on purpose (unlike
  // CLI_SOFT_TIMEOUT_PERCENT these are parsed as floats), and a string that parses to
  // nothing usable falls back to the built-in ladder rather than yielding a zero budget.
  CLI_TIMEOUT_LADDER: 'config:cli:timeoutLadder',

  // Global kill-switch for the subscription usage-window display (claude-hud-style
  // 5h/weekly meters in the task header). When 'true' (default), a gentle background
  // poller reads each logged-in provider's (undocumented) usage endpoint and the task
  // header shows the active step's CLI windows. Set 'false' to stop all usage polling
  // and hide the chip everywhere without a redeploy. Read by the poller each tick
  // (~30s config cache).
  USAGE_WINDOW_ENABLED: 'config:usage:windowEnabled',

  // Global kill-switch for subscription usage-depletion alerts. When 'true' (default),
  // the web notifier warns (toast + OS notification) once per provider per window per
  // reset as soon as that window's REMAINING allowance falls to or below
  // USAGE_ALERT_THRESHOLD_PCT. Independent of USAGE_WINDOW_ENABLED, but useless
  // without it: the alerts read the same poller-written snapshots the chip does, so a
  // stopped poller means stale rows and no alerts either way.
  USAGE_ALERT_ENABLED: 'config:usage:alertEnabled',
  // Remaining-percent threshold at which a usage window alerts (default 10, matching
  // the header chip's red band). REMAINING, not consumed — 10 means "warn when 10% is
  // left", not "warn after 10% is spent". An integer, not a fraction, because
  // configService.getNumber parses with parseInt (0.1 would read as 0). Clamped to
  // 1..50 by the admin endpoint: 0 could never fire and anything past half the window
  // stops being a warning.
  USAGE_ALERT_THRESHOLD_PCT: 'config:usage:alertThresholdPct',

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

  // Hard per-call wall-clock cap (ms) on the chrome-devtools MCP server, emitted as that
  // server's `timeout` field in the generated MCP config. Progress notifications do NOT
  // extend it, which is what makes it bite on a hung browser tool. 0 disables the cap
  // (the CLI's own ~28h default returns). Read at cli-exec invocation build time within
  // the ~30s config cache, so a retune takes effect without a redeploy.
  CHROME_MCP_TOOL_TIMEOUT_MS: 'config:mcp:chromeToolTimeoutMs',

  // Global kill-switch for the DDEV image pull-through cache. When 'true' (default),
  // each per-task DDEV runner routes its nested dockerd Docker Hub pulls through a
  // shared registry mirror (a singleton registry:2 proxy on a persistent volume), so a
  // repo's DDEV base images are pulled from Hub once and served locally to every later
  // task instead of re-pulled per task (the runner's nested image store is dropped at
  // teardown). Read at runner START; OFF => runners pull direct from Docker Hub (a
  // mid-task flip needs Stop/Retry). Persists across restarts.
  DDEV_REGISTRY_CACHE_ENABLED: 'config:ddev:registryCache',

  // How Haive reacts when a task FAILS on a provider outage (session/rate-limit, or a
  // provider 5xx) and that provider later recovers. One of ALLOWANCE_WATCH_MODES:
  //   'off'    — do not watch at all. Nothing is armed, nothing notifies, nothing resumes.
  //   'notify' — watch and fire a browser notification when the provider is back (default).
  //   'auto'   — also AUTO-resume the task (resume semantics, so completed loop passes are
  //              preserved), capped at ALLOWANCE_AUTO_RESUME_CAP consecutive auto-resumes
  //              before falling back to notify-only.
  // The key string keeps its legacy 'autoResumeOnAllowance' name so an existing install's
  // stored value survives the boolean->enum change; parseAllowanceWatchMode maps the legacy
  // 'true'/'false' values onto 'auto'/'notify'. Read once per usage-poll tick and at arm time.
  ALLOWANCE_WATCH_MODE: 'config:tasks:autoResumeOnAllowance',

  // Per-file size cap (bytes) for user-uploaded task attachments. Enforced by the
  // attachment upload endpoint (streamed; aborts once the byte count exceeds it).
  // Admin-tunable; default DEFAULT_TASK_ATTACHMENT_MAX_BYTES (25 MiB).
  TASK_ATTACHMENT_MAX_BYTES: 'config:tasks:attachmentMaxBytes',

  // Retention window (days) for cli_invocations.stream_log — the full CLI transcript
  // behind the terminal's Raw tab. Nothing else ever deletes it (there is no task-delete
  // route), and a codex `exec --json` run inlines every MCP tool result into its event
  // stream, so one read_multiple_files call persists whole file contents. The sweep nulls
  // the column on ended invocations older than the window; the row keeps its parsed
  // output, token usage and timings, and the replay endpoint falls back to rawOutput.
  // 0 keeps transcripts forever (the default) — nulling is irreversible, so it is opt-in.
  CLI_STREAM_LOG_RETENTION_DAYS: 'config:tasks:cliStreamLogRetentionDays',

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
  // Prompt-side counterpart to retrieval: list the titles of the stack-matching
  // global KB entries in every rag-wired agent prompt, so an agent that would
  // otherwise never call rag_search at least knows what exists. Kill switch —
  // it costs prompt tokens on every dispatch. Separate from GLOBAL_KB_ENABLED so
  // the digest can be turned off without disabling global KB retrieval.
  GLOBAL_KB_DIGEST_ENABLED: 'config:globalKb:digestEnabled',

  // Global terseness level for agent OUTPUT prose, applied as a directive appended to
  // each CLI step's main prompt (lite | full | ultra; default full). Only the model's
  // prose is affected — the directive carves out JSON/code/diffs/specs so structured
  // output stays exact, and reasoning (extended thinking) is a separate channel left
  // untouched. The manifest-hashed agent .md files keep the fixed 'full' block; this
  // level governs only the runtime step-prompt injection. Read per cli dispatch (~30s
  // config cache); a change needs no redeploy.
  TERSENESS_LEVEL: 'config:output:tersenessLevel',

  // How much of the approved spec post-implementation agents get in their prompt.
  // 'toc' (default) sends the heading index plus a bounded lead of each section and
  // points the agent at the on-disk `.haive/spec.md` artifact for anything omitted;
  // 'full' embeds the whole document as before. Every CLI invocation is a fresh
  // process, so the same spec is otherwise re-sent to a dozen agents per run and
  // prompt caching cannot dedup it (separate sessions). The steps that REASON OVER the
  // whole spec (audit, quality, resolve-warnings, run-config, sprint planning) always
  // get the full text regardless of this setting. Read per step; no redeploy needed.
  SPEC_VIEW_MODE: 'config:output:specViewMode',

  // --- Cost / pricing -----------------------------------------------------
  // Master switch for the per-model price sync. OFF stops both feeds being fetched at
  // all, so every rate stays exactly as it is and pricing keeps working from the last
  // sync — the intended posture for an install on negotiated rates that has entered
  // its own. The per-CLI `cli_pricing_sync.auto_update_enabled` toggles are the
  // finer-grained version of the same idea; this one wins over all of them.
  PRICING_AUTO_UPDATE_ENABLED: 'config:pricing:autoUpdateEnabled',
  // Which currency costs are DISPLAYED in. Storage is always USD (what every vendor
  // bills); this only picks the conversion applied at read time, using the ECB rate
  // effective on the task's own date so an old task keeps reporting the same figure.
  // One of DISPLAY_CURRENCIES; anything else falls back to USD.
  COST_DISPLAY_CURRENCY: 'config:pricing:displayCurrency',

  // Refutation pass over 08c's BLOCKING review findings (default ON). Each such finding
  // routes the change back through implementation and costs one of the capped fix
  // rounds, so before that happens a refuter per finding is asked to disprove it against
  // the code. A finding is dismissed only on positive, cited evidence that it is wrong;
  // an uncertain, unparseable or failed refuter leaves it standing. Costs one extra CLI
  // invocation per blocking finding, only in a round that has one. Set 'false' to block
  // on the reviewers' word alone. Read per 08c apply (~30s config cache).
  REVIEW_REFUTE_ENABLED: 'config:review:refuteEnabled',

  // How many angles each blocking finding is attacked from before it can be dismissed
  // (default 3: reachability, impact, defenses). A single generic refuter finds one kind
  // of reason a finding is wrong and stops; three voters, each told where to spend their
  // effort, do not. Dismissal is UNANIMOUS — one silent, unreadable or uncertain voter
  // keeps the finding, which is the fail-closed direction (see 08c's asymmetry note).
  //
  // Costs 3 sandboxed invocations per blocking finding instead of 1, capped at
  // MAX_REFUTERS bugs per round. It cannot starve other tasks — enforceTaskAgentCap
  // defers past MAX_PARALLEL_AGENTS_PER_TASK at pickup — so the cost is wall-clock,
  // several serial batches rather than one. Anything BELOW 3 runs the original single
  // generic pass rather than a subset: a two-lens panel cannot be unanimous about what
  // the third would have caught. Read per 08c apply (~30s config cache).
  REVIEW_REFUTE_LENSES: 'config:review:refuteLenses',

  // Global kill-switch for the pull-request close-out workflow. When 'true', a
  // workflow task's final worktree-cleanup step offers a "Create a pull request"
  // action (open a PR/MR on the repo's forge instead of a local merge), and the
  // task parks in waiting_pr until a background poller sees the PR merge. Default
  // 'false' (staged rollout): the create_pr option is hidden and no PR polling
  // runs until an admin flips this on. Also gated per-repo by
  // repositories.pr_workflow_enabled. Read per step form + per poll tick (~30s
  // config cache); a flip needs no redeploy.
  PR_WORKFLOW_ENABLED: 'config:pr:workflowEnabled',

  // --- Learned step guidance ----------------------------------------------
  // Master switch for learned per-step prompt guidance (plan lexical-jingling-dawn).
  // When on, the CLI-driven steps that can route a run back to implementation carry a
  // short instruction inviting them to name an INSTRUCTION defect that caused the
  // rejection; 11e-prompt-guidance triages the candidates at the end of the run; and
  // approved items are APPENDED to the target step's prompt on later runs.
  //
  // Default 'false' (staged rollout, as PR_WORKFLOW_ENABLED does). Flipping it back to
  // false is the rollback for the whole feature and needs no deploy: guidance is only
  // ever appended, so every prompt returns to byte-identical. Also gated per-repo by
  // repositories.step_guidance_enabled. Read per cli dispatch and per step detect
  // (~30s config cache); a flip needs no redeploy.
  STEP_GUIDANCE_ENABLED: 'config:guidance:stepGuidanceEnabled',

  // Master kill-switch for the machine-aware runtime resource governor (default ON).
  // When 'true', every per-task DDEV/app runner and CLI-exec sandbox is spawned with
  // Docker resource caps (--memory + swap-off + --cpus + --pids-limit), and an
  // admission gate bounds how many runtime runners boot concurrently. Set 'false' to
  // spawn with no caps and never gate (byte-for-byte the pre-feature argv) — the
  // rollback. Read at each runner START, so a mid-task flip needs a runner restart.
  RESOURCE_LIMITS_ENABLED: 'config:sandbox:resourceLimitsEnabled',
  // Per-runtime-runner memory cap (MB) for DDEV/app runners, applied as --memory AND
  // --memory-swap (swap disabled inside the container, so it OOM-kills rather than
  // driving the host into swap thrash). 0 = auto-derive from host RAM (deriveRuntimeCaps).
  // A per-task tasks.memoryLimitMb overrides this for that task.
  RUNTIME_MEMORY_MB: 'config:sandbox:runtimeMemoryMb',
  // Per-runtime-runner CPU cap for DDEV/app runners, applied as --cpus. 0 = auto-derive
  // from host CPU count. A per-task tasks.cpuLimitMilli overrides this for that task.
  RUNTIME_CPUS: 'config:sandbox:runtimeCpus',
  // Hard cap on the NUMBER of live runtime runners (DDEV + app), enforced alongside the
  // byte budget. 0 = no count cap, the budget alone governs. A count cap treats every
  // runtime as equally expensive, which is what made a light app-runner consume the same
  // slot as a DDEV DinD; set it only to pin the old behavior.
  MAX_CONCURRENT_RUNTIMES: 'config:sandbox:maxConcurrentRuntimes',
  // Planning weights (MB) the admission gate budgets each consumer at. NOT container caps:
  // RUNTIME_MEMORY_MB is the ceiling a runner may grow into, these are what the pool assumes
  // it actually occupies. 0 = auto, which uses the CALIBRATED defaults in deriveRuntimeCaps
  // (ddev 1536, app 1024, agent 2048), measured from 1731 `docker stats` samples rather than
  // guessed. Absolute, not host-relative: a project's runner uses the same RAM on a 16 GB box
  // as on a 64 GB one. Override only if your projects differ materially from that profile.
  RUNTIME_DDEV_WEIGHT_MB: 'config:sandbox:runtimeDdevWeightMb',
  RUNTIME_APP_WEIGHT_MB: 'config:sandbox:runtimeAppWeightMb',
  AGENT_WEIGHT_MB: 'config:sandbox:agentWeightMb',
  // Surcharge (MB) added to a runtime's weight when its task runs browser testing. The headed
  // desktop (Xvfb + x11vnc + Chromium) runs INSIDE the runner container, so it is not its own
  // pool entry — it makes that runner heavier. 0 = auto (1536, so a browser-phase DDEV is
  // budgeted 3072 against a measured 2505 peak). The flag is really a proxy for "this task is
  // in a verify/fix phase", which is when the agent works the app hardest.
  RUNTIME_BROWSER_WEIGHT_MB: 'config:sandbox:runtimeBrowserWeightMb',
  // Agents that stay runnable however full the runtime pool is. A task holding a runtime
  // needs an agent to finish, so a zero-agent state deadlocks. 0 = auto (2).
  AGENT_FLOOR: 'config:sandbox:agentFloor',
  // Whether the agent pool is sized from the host's MEASURED free memory instead of from the
  // planned budget minus the runtime pool's planning weights. Both ends of that subtraction are
  // peak-calibrated estimates that are wrong by different factors: MEASURED, three DDEV runners
  // charged 9216 MB were occupying 2551 (starving agents to the floor) while the dev base stack
  // overran its 30% reserve (which the planned figure cannot see at all). Off = the planned-only
  // sizing, byte for byte.
  AGENT_POOL_MEASURED_ENABLED: 'config:sandbox:agentPoolMeasuredEnabled',
  // MB held back from the measured headroom for the base stack's growth and for running agents
  // climbing toward their peak (~450 MB early against a 1736 MB peak). 0 = auto (a fifth of the
  // host, clamped to 2048..4096). Raise it if the host starts swapping as the pool ramps.
  AGENT_POOL_SAFETY_MB: 'config:sandbox:agentPoolSafetyMb',
  // Whether a task holding NO live runtime runner yields its cli-exec slot to a task that
  // holds one. Runtime occupancy already caps the agent pool, but nothing made a fungible
  // agent yield to a task whose idle time is billed in committed RAM: a runner-less task
  // (onboarding, a workflow task before its env boots) took one of the few slots while a
  // primed DDEV task sat idle holding gigabytes it could only release by finishing. Off =
  // pre-feature first-come behavior.
  AGENT_RESERVE_ENABLED: 'config:sandbox:agentReserveEnabled',
  // How long a runner-less invocation may be held before it runs regardless. The escape
  // hatch that turns "runner-holders have priority" into "runner-holders go first": without
  // it a busy runtime fleet starves runner-less work for as long as it keeps queueing jobs.
  // 0 = strict, no escape.
  AGENT_RESERVE_MAX_HOLD_MINUTES: 'config:sandbox:agentReserveMaxHoldMinutes',
  // Whether a RUNNING CLI agent on a lower-voted task is killed so a higher-voted task's
  // queued job can take its slot. Vote scoring only orders the QUEUE, so a boosted task
  // still waited behind whatever happened to be enqueued first — observed live: a +2 task
  // held the queue's lowest priority number and could not run because both slots were taken
  // first-come. Preemption is the only thing that changes that. It destroys the killed
  // round's tokens and partial work, and it is the one part of vote scoring that can break
  // the no-starvation property, so it is a switch. Off = first-come among running agents
  // (the queue is still vote-ordered).
  AGENT_PREEMPTION_ENABLED: 'config:sandbox:agentPreemptionEnabled',
  // How long a CLI agent must have been running before it may be preempted. The trade in
  // one number: lower reacts faster but destroys more short runs, higher lets a brief run
  // finish under its own power while the boosted task waits longer. Also what stops a
  // just-restarted victim from being killed again before it achieves anything. 0 = no
  // guard (preempt as soon as a higher-voted task queues work).
  AGENT_PREEMPTION_MIN_RUN_MINUTES: 'config:sandbox:agentPreemptionMinRunMinutes',
  // Whether a higher-voted task waiting for a RUNTIME (DDEV/app) slot may reclaim a lower-voted
  // task's LIVE runner. Without it, holding a runner is a prerequisite for a vote to matter at
  // all: a task that cannot get an environment never reaches the cli-exec queue, so its score is
  // never consulted — observed as a score-1 task parked behind three live runners while a score-0
  // holder kept running. Only ever reclaims a runner whose task has NO live CLI invocation, so an
  // environment is never torn out from under a running agent. Off = the pre-feature tiers (dead,
  // orphaned and paused-and-settled runners only).
  RUNTIME_PREEMPTION_ENABLED: 'config:sandbox:runtimePreemptionEnabled',
  // How long a higher-voted task may sit parked before the reclaimer forces the issue by
  // preempting the HOLDER'S AGENT, which creates the settled window it needs. Without this the
  // tier only fires when the agent sweeper happens to have evicted that holder for its own
  // reasons, so a quiet machine can leave the waiter parked indefinitely. 0 = never force it.
  RUNTIME_PREEMPTION_MAX_WAIT_MINUTES: 'config:sandbox:runtimePreemptionMaxWaitMinutes',
  // Grace (minutes) before the runtime reaper reclaims a FAILED task's leaked runner
  // (failed runners are kept for retry/recovery, so they need a grace). Runners whose
  // task is completed/cancelled/missing, or whose container has exited, are reaped
  // immediately regardless. 0 disables the failed-grace reap (the rest still runs).
  RUNTIME_IDLE_REAP_MINUTES: 'config:sandbox:runtimeIdleReapMinutes',
} as const;

/** Allowed terseness levels for CONFIG_KEYS.TERSENESS_LEVEL (output prose only).
 *  'off' injects no directive at all — for models that are already concise by
 *  default, where the extra instruction is bulk rather than signal. */
export const TERSENESS_LEVELS = ['off', 'lite', 'full', 'ultra'] as const;
export type TersenessLevel = (typeof TERSENESS_LEVELS)[number];

/** Allowed values for CONFIG_KEYS.SPEC_VIEW_MODE — how much of the approved spec a
 *  post-implementation agent receives inline. 'toc' is the condensed section index plus
 *  a pointer to the on-disk spec; 'full' is the whole document. */
export const SPEC_VIEW_MODES = ['toc', 'full'] as const;
export type SpecViewMode = (typeof SPEC_VIEW_MODES)[number];

/** Allowed levels for CONFIG_KEYS.ALLOWANCE_WATCH_MODE — how Haive reacts to a task that
 *  failed on a provider outage once that provider recovers. */
export const ALLOWANCE_WATCH_MODES = ['off', 'notify', 'auto'] as const;
export type AllowanceWatchMode = (typeof ALLOWANCE_WATCH_MODES)[number];

/** Read a stored ALLOWANCE_WATCH_MODE value, accepting the legacy boolean the key held
 *  before it became an enum ('true' was auto-resume-on, 'false' was notify-only). Anything
 *  unrecognised — including an absent key — reads as 'notify', the default level. */
export function parseAllowanceWatchMode(raw: string | null | undefined): AllowanceWatchMode {
  if (raw === 'true') return 'auto';
  return (ALLOWANCE_WATCH_MODES as readonly string[]).includes(raw ?? '')
    ? (raw as AllowanceWatchMode)
    : 'notify';
}

const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.API_PORT]: '3001',
  [CONFIG_KEYS.RATE_LIMIT_API_RPM]: '60',
  [CONFIG_KEYS.RATE_LIMIT_AUTH_RPM]: '10',
  [CONFIG_KEYS.SMTP_HOST]: 'mailpit',
  [CONFIG_KEYS.SMTP_PORT]: '1025',
  [CONFIG_KEYS.SMTP_FROM]: 'no-reply@haive.local',
  [CONFIG_KEYS.SMTP_FROM_NAME]: 'Haive',
  [CONFIG_KEYS.MAX_PARALLEL_AGENTS]: '0',
  [CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK]: '5',
  [CONFIG_KEYS.OLLAMA_CLI_TIMEOUT_MS]: '7200000',
  [CONFIG_KEYS.ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS]: 'false',
  [CONFIG_KEYS.MODEL_HEALTH_CHECK_ENABLED]: 'true',
  [CONFIG_KEYS.MODEL_IDENTITY_STRICT]: 'false',
  [CONFIG_KEYS.FAIR_SCHEDULING_ENABLED]: 'true',
  [CONFIG_KEYS.GLOBAL_PAUSE]: 'false',
  [CONFIG_KEYS.PROMPT_CACHING_1H]: 'false',
  [CONFIG_KEYS.HOST_REPO_ROOT]: '/host-fs',
  [CONFIG_KEYS.REPO_STORAGE_PATH]: '/var/lib/haive/repos',
  [CONFIG_KEYS.CLAWKER_BIN]: '/usr/local/bin/clawker',
  [CONFIG_KEYS.SANDBOX_NETWORK]: 'haive-network',
  [CONFIG_KEYS.SECRET_MASK_ENABLED]: 'true',
  [CONFIG_KEYS.STEERING_ENABLED]: 'true',
  [CONFIG_KEYS.CLI_SOFT_TIMEOUT_ENABLED]: 'true',
  [CONFIG_KEYS.CLI_SOFT_TIMEOUT_PERCENT]: '80',
  [CONFIG_KEYS.CLI_TIMEOUT_BASE_MINUTES]: String(DEFAULT_CLI_TIMEOUT_BASE_MINUTES),
  [CONFIG_KEYS.CLI_TIMEOUT_LADDER]: DEFAULT_CLI_TIMEOUT_LADDER.join(','),
  [CONFIG_KEYS.USAGE_WINDOW_ENABLED]: 'true',
  [CONFIG_KEYS.USAGE_ALERT_ENABLED]: 'true',
  [CONFIG_KEYS.USAGE_ALERT_THRESHOLD_PCT]: '10',
  [CONFIG_KEYS.IDE_ENABLED]: 'true',
  [CONFIG_KEYS.DEBUG_MODE_ENABLED]: 'true',
  [CONFIG_KEYS.DDEV_CONTROL_MCP_ENABLED]: 'true',
  [CONFIG_KEYS.CHROME_MCP_TOOL_TIMEOUT_MS]: String(DEFAULT_CHROME_MCP_TOOL_TIMEOUT_MS),
  [CONFIG_KEYS.DDEV_REGISTRY_CACHE_ENABLED]: 'true',
  [CONFIG_KEYS.ALLOWANCE_WATCH_MODE]: 'notify',
  [CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES]: String(DEFAULT_TASK_ATTACHMENT_MAX_BYTES),
  [CONFIG_KEYS.CLI_STREAM_LOG_RETENTION_DAYS]: String(DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS),
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
  [CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED]: 'true',
  [CONFIG_KEYS.TERSENESS_LEVEL]: 'full',
  [CONFIG_KEYS.SPEC_VIEW_MODE]: 'toc',
  // Pricing: sync ON by default (a fresh install should price itself without setup);
  // display in USD, which is also the storage currency, so the default path applies no
  // conversion at all.
  [CONFIG_KEYS.PRICING_AUTO_UPDATE_ENABLED]: 'true',
  [CONFIG_KEYS.COST_DISPLAY_CURRENCY]: 'USD',
  [CONFIG_KEYS.REVIEW_REFUTE_ENABLED]: 'true',
  [CONFIG_KEYS.REVIEW_REFUTE_LENSES]: '3',
  [CONFIG_KEYS.PR_WORKFLOW_ENABLED]: 'false',
  [CONFIG_KEYS.STEP_GUIDANCE_ENABLED]: 'false',
  // Runtime resource governor: ON by default; the numeric caps default to 0 (auto-derive
  // from host RAM/CPU via deriveRuntimeCaps) so a fresh install self-tunes to its machine.
  [CONFIG_KEYS.RESOURCE_LIMITS_ENABLED]: 'true',
  [CONFIG_KEYS.RUNTIME_MEMORY_MB]: '0',
  [CONFIG_KEYS.RUNTIME_CPUS]: '0',
  [CONFIG_KEYS.MAX_CONCURRENT_RUNTIMES]: '0',
  [CONFIG_KEYS.RUNTIME_DDEV_WEIGHT_MB]: '0',
  [CONFIG_KEYS.RUNTIME_APP_WEIGHT_MB]: '0',
  [CONFIG_KEYS.AGENT_WEIGHT_MB]: '0',
  [CONFIG_KEYS.RUNTIME_BROWSER_WEIGHT_MB]: '0',
  [CONFIG_KEYS.AGENT_FLOOR]: '0',
  [CONFIG_KEYS.AGENT_POOL_MEASURED_ENABLED]: 'true',
  [CONFIG_KEYS.AGENT_POOL_SAFETY_MB]: '0',
  [CONFIG_KEYS.AGENT_RESERVE_ENABLED]: 'true',
  // 3, not 10: the hold is only HALF the wait. A released job still has to wait for a slot to
  // free, and that term is invisible in the knob — measured with the hold at 10, runner-less
  // invocations waited 12.6, 14.1 and 21.9 minutes. 3 bounds the total to roughly one agent run.
  [CONFIG_KEYS.AGENT_RESERVE_MAX_HOLD_MINUTES]: '3',
  [CONFIG_KEYS.AGENT_PREEMPTION_ENABLED]: 'true',
  [CONFIG_KEYS.AGENT_PREEMPTION_MIN_RUN_MINUTES]: '5',
  [CONFIG_KEYS.RUNTIME_PREEMPTION_ENABLED]: 'true',
  [CONFIG_KEYS.RUNTIME_PREEMPTION_MAX_WAIT_MINUTES]: '10',
  [CONFIG_KEYS.RUNTIME_IDLE_REAP_MINUTES]: '180',
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
