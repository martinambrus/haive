# Haive

Deterministic multi-CLI orchestration and AI agentic workflow utility. Reimplements a legacy markdown-driven Claude Code workflow, the autonomous `/workflow` implementation loop, and a sandboxed local environment replication step set as a deterministic web project. Agentic CLI invocations only happen for parts that genuinely need reasoning. Everything else runs as TypeScript step modules with web forms.

The legacy markdown step content has been ported into TypeScript step modules under `packages/worker/src/step-engine/steps/`. The original source archive is no longer vendored in the repo.

## Stack

- pnpm workspace monorepo, turborepo
- Node 26, TypeScript 5.7, ES2024 target, NodeNext modules
- Hono 4 REST API on port 3001
- Next.js 16 + React 19 + Tailwind 4 web UI on port 3000
- Drizzle ORM on PostgreSQL 18, postgres.js driver
- BullMQ on Redis 8 (noeviction policy is required)
- Uploaded repo archives live in the `haive_repos` named volume (shared by api and worker); Mailpit for dev SMTP
- Docker Compose orchestrates everything; the dev stack is driven by `scripts/dev.sh` (aliased `pnpm docker:dev`), which wraps `docker compose up` with the dev override and GPU layering
- clawker (Apache 2.0 Go binary) wrapped via child_process in `sandbox/clawker-client.ts`. The binary is installed only when the worker image is built with `CLAWKER_RELEASE_URL` plus a matching `CLAWKER_SHA256`; nothing in this repo sets either, so the binary is absent from the shipped image and the wrapper is inert until someone wires it

## Monorepo layout

```
haive/
  package.json                 pnpm workspace root
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  docker-compose.yml           postgres, redis, mailpit, api, worker, web
  docker-compose.dev.yml       dev override: port exposure, hot reload, db-migrate one-shot
  packages/
    shared/                    @haive/shared    types, schemas, crypto, config, logger
    database/                  @haive/database  Drizzle schema and migrations
    api/                       @haive/api       Hono REST + WebSocket terminal proxy
    worker/                    @haive/worker    BullMQ workers, step engine, sandbox manager, CLI adapters
    web/                       @haive/web       Next.js Conductor-style UI
  tests/
    e2e/                       Playwright specs
    fixtures/
```

## Package boundaries

- `@haive/shared` holds zod schemas, types, crypto, logger, ConfigService, SecretsService, and UserSecretsService. May be imported by every other server-side package. May import `@haive/database` for the Drizzle schema namespace used by the secrets services; the actual db client is injected at runtime via `initialize(db)` so shared never instantiates a connection.
- `@haive/database` exports the Drizzle schema and a `createDatabase(url)` factory. Instantiated only by the api and worker packages.
- `@haive/api` is HTTP + WebSocket only. It must never spawn child processes for CLI execution; that responsibility lives in the worker.
- `@haive/worker` owns BullMQ queues, the step engine, the CLI adapter registry, the sandbox/clawker wrapper, and the dispatcher priority chain. It holds no HTTP routes.
- `@haive/web` consumes only the public REST API of `@haive/api`. It must not import from `@haive/database` or `@haive/worker`.

## Architecture summary

Three queues on Redis:

- `task-queue` runs the orchestrator. One job per task. Owns the step machine and persists every transition to Postgres.
- `cli-exec-queue` runs the sandbox worker. One job per CLI invocation. Spawns a per-task Docker sandbox via `docker run`/`create` (`sandbox/docker-runner.ts`) — NOT clawker (clawker backs the persistent terminal/login containers in `sandbox/container-manager.ts`); captures piped stdout/stderr and streams to a Redis Stream (`cli-stream:<invocationId>`). Steerable Claude-family runs keep stdin open (`-i`) so a user steer reaches the CLI mid-run.
- `env-replicate-queue` runs Dockerfile builds for environment replication.

State source of truth is Postgres. Every step transition, every CLI invocation, every form submission is a row. Crash recovery reads the last row.

## Step engine

Every legacy markdown step becomes a `StepDefinition<TInput, TOutput>` with four phases:

1. `detect` runs first. Pure or shells out via clawker. No LLM. Always runs.
2. `form` returns a `FormSchema`. The web UI renders the schema and the user submits values.
3. `llm` is optional. Spawns a CLI invocation through the dispatcher. For CLIs without native sub-agents the splitter emits a sequential script.
4. `apply` runs last. Writes outputs to `task_steps.output` and to actual files under the workspace.

Step lifecycle: `pending` to `running(detect)` to `waiting_form` to `running(apply)` to optional `waiting_cli` then back to `running(apply)` to `done` or `failed` or `skipped`.

## CLI adapter system

`packages/worker/src/cli-adapters/base-adapter.ts` defines `BaseCliAdapter`. Implemented adapters: `claude-code`, `codex`, `gemini`, `amp`, `zai`, `antigravity`, `ollama`, `muse`, `grok`, `openrouter`. Each declares `supportsSubagents`, `supportsCliAuth`, `supportsMcp`, `supportsPlugins`, `defaultAuthMode` (`subscription` or `api_key`), and `apiKeyEnvName`. `supportsSteering` defaults to false; only the Claude-family adapters (`claude-code`, `zai`, `ollama`, `muse`, `openrouter`) override it to true.

Four adapters are the same trick: the stock `claude` binary pointed at a non-Anthropic Anthropic-wire endpoint via `ANTHROPIC_BASE_URL` — `zai` (api.z.ai), `ollama` (in-stack daemon or ollama.com), `muse` (api.meta.ai), `openrouter` (openrouter.ai/api). All four piggyback the `claude-code` install, so they build no new sandbox image. Their per-endpoint quirks are MEASURED against the live API and recorded in the adapter, not taken from vendor docs — `muse` exists as its own adapter purely because its effort scale rejects `max`, and `openrouter` records the opposite finding (its effort enum is validated globally at the gateway, so every level is safe on every model). Re-probe before "correcting" any of those comments.

`ollama` records the third effort finding, and it is the only scale in the codebase whose default is not its top level: `low|medium|high|max` with default `high`. The level arrives as Anthropic `output_config.effort`, which Ollama's compat layer reads only because the claude binary sends `thinking:{"type":"adaptive"}` — the layer honors `thinking.type` for the literals `enabled`/`disabled` and falls through to effort for anything else. An out-of-range level never 400s; it leaves the think value unset, which Ollama then forces on for a thinking-capable model. `max` is exposed but not the default because gpt-oss does not recognise it as a harmony level and reasons LESS at `max` than at `high`, and deepseek-v4-pro at `max` spent an entire output budget in the thinking channel and returned empty text — the same failure the disable-thinking proxy exists for. `high` is additionally what the binary already sent before the scale existed, so the default changed nothing. Orthogonally, the level is on/off only for most LOCAL models: every built-in renderer in ollama 0.24.0 reads `think.Bool()` and none reads `ThinkLevel`, while Ollama Cloud models are rendered upstream and honor all four. Do not "correct" this scale to match zai's — re-probe.

`openrouter` traffic goes through the `openrouter-compat-proxy` sidecar (`docker/openrouter-compat-proxy/`), not straight to openrouter.ai. The claude binary appends a trailing `role:"system"` message (the Agent tool's agent-type listing) on top of the top-level `system` field; OpenRouter passes Anthropic models through natively, but every other vendor needs an Anthropic→OpenAI translation in which that message keeps its position, and vLLM-style backends answer `400 "System message must be at the beginning."` (measured on `qwen/qwen3.8-27b` across all three of its upstreams; `--disallowedTools Agent` does not stop the binary emitting it). The proxy hoists it into `system`. Unconditional rather than toggled — the rewrite is a no-op when no such message is present and was verified not to change already-working models — so unlike ollama's thinking proxy there is no per-provider switch. `resolveOpenRouterBaseUrl` is the single place that endpoint is chosen, shared by the adapter and the Test-connection probe; a provider that sets `ANTHROPIC_BASE_URL` by hand bypasses the proxy and the probe then says so.

`openrouter` fronts 400+ models, so the provider form picks from a cached catalog rather than a free-text slug: the worker's `REFRESH_VERSIONS` job also refreshes `openrouter_model_cache` (`cli-versions/openrouter-models.ts`), the API serves it at `GET /cli-providers/openrouter/models`, and the picker refuses models whose `supported_parameters` lacks `tools` because Claude Code cannot run a step without native tool use. The cache is never a gate: an empty or errored catalog degrades to a free-text model field.

`model_identity` (`queues/cli-exec/model-identity.ts`) records which model ANSWERED, not which one was configured. Two DISTINCT channels, not two names for one value: the claude-family stream-json `system`/`init` event carries what the binary ASKED for, each `assistant` event's `message.model` carries what the endpoint SERVED, and they disagree — api.z.ai answers a `glm-5.3[1m]` request as `glm-5.3`, and recorded streams show the same provider served `glm-5.2` on 2026-07-24 and `glm-5.3` on 2026-08-18, i.e. an endpoint can swap models with no config change here. Coverage is MEASURED per provider: `claude-code`/`zai`/`ollama`/`muse`/`grok`/`openrouter` report both channels; `gemini` names its models only as the keys of `stats.models`; `antigravity` names one only in its `--log-file` and only as a human LABEL (`Gemini 3.7 Flash (High)`), parsed from ONE constant marked volatile that returns null on a reword; `codex` and `amp` report NOTHING. codex's `exec --json` carries no model on any typed event (verified against a complete 3.4 MB SUCCESSFUL run — `model_provider` strings found in such a stream come from old `~/.codex/sessions` rollout files an agent happened to read, not from live events), and amp emits `agent_mode` instead because it abstracts the model away. Those two are permanently `match: 'unknown'`, which is why `unknown` never fails a run.

Two traps in that data. `result.modelUsage` keys are recorded as `billed` and are NOT an identity source: `grok` serves `grok-4.6` while billing `grok-4.6-build`, and `claude-code` bills a `claude-haiku-*` call for its own session titling. And an `assistant` event with `model:"<synthetic>"` is a message the BINARY authored (an API error), not a model reply — filtered on the angle-bracket convention rather than the literal word, so a future sentinel is excluded too. `requested`/`served` are stored verbatim; only `match` is lenient, and only for one case: an endpoint that DROPS a trailing variant tag while naming the same model (`glm-5.3[1m]` to `glm-5.3`) is `exact`. That keys on the tag's PRESENCE differing, not on tag-stripped equality, so a version swap (`glm-5.2[1m]` to `glm-5.3`) and a different variant (`[1m]` to `[200k]`) both stay `differs`, and ollama's colon marker (`glm-5.2:cloud`) is untouched. A mismatch warns and never blocks — claude-code legitimately resolves an alias to a dated snapshot — unless `CONFIG_KEYS.MODEL_IDENTITY_STRICT` (default false, admin toggle) is on. Capture rides the same parse as token usage, so it costs no extra call, prompt or tokens; the canary (`00-model-health`) then copies the task-default provider's identity onto `tasks.model_identity`, while per-invocation truth stays on `cli_invocations.model_identity` because per-step CLI preferences let one task run several models. Re-measure with `packages/worker/test/model-report-discover.ts` before "correcting" any of this — it runs each adapter's real invocation and feeds the live output through the shipped parser.

The dispatcher (`resolveDispatch`) filters to enabled providers, orders the resolved preferred provider first, and picks the first whose adapter is registered and has `supportsCliAuth` — plus `supportsSubagents` when the step declares the `subagents` capability. If none matches, the step is skipped. Every plan it emits is a CLI invocation; there is no API-mode branch. Auth mode selects which credentials the CLI is given, not whether the dispatcher bypasses the CLI.

The sub-agent emulator splits a single sub-agent specification into either a native `Task()` call (Claude Code) or a sequential prompt script (everything else). A sequential script runs inside a single `cli-exec-queue` job — the runner is an in-memory for-loop over the sub-steps, with no per-sub-step DB writes. A crash mid-script therefore fails the whole invocation; restart re-runs from sub-step 0. (Mid-script resume would require persisting each sub-step's parsed output to `cli_invocations` before moving on — not implemented.)

## Model pricing and spend

`cli_invocations.cost` records what a run COST, decided at completion beside `token_usage` and `model_identity` and then immutable. Distinct from `token_usage.costUsd`, which keeps its old meaning (what the CLI itself reported). The split exists because the reported number is real only where the CLI prices its own backend: the claude binary applies ANTHROPIC's table to every backend, so for zai/muse/openrouter/ollama it is fiction, and codex/gemini report no cost at all. MEASURED before the feature: of ~12,800 USD reported across 12,438 invocations, 31.68 USD was the only amount the product could count as real.

Precedence per invocation (`resolveCostDecision`): manual rate > CLI-reported where `costBasis` is `metered` > computed from a synced rate. Subscription auth short-circuits to non-billable regardless — a flat plan's per-token dollars are notional. `billable` is decided at WRITE time, where provider, auth mode, model and price source are all in hand, so reads honor a flag instead of re-deriving the rule (it had been duplicated across three SQL filters). A partial computation is recorded `source: 'none'`, never as a cost: a total missing one bucket looks like money and is not.

Rates live in `cli_model_prices`, effective-dated and append-only. A sync CLOSES the live row and inserts a replacement ONLY when a rate actually moved, so an unchanged 12-hourly tick writes nothing (verified: `inserted 0, closed 0, unchanged 651`). Two feeds, refreshed by the existing `REFRESH_VERSIONS` job (`cli-versions/model-prices.ts`), sequentially after `refreshOpenRouterModels` because it reads that cache rather than re-fetching 4 MB:

- **LiteLLM** `model_prices_and_context_window.json` for direct-vendor rates. The feed publishes one entry per (host, model), so `PROVIDER_LITELLM_VENDORS` maps each Haive provider to the vendors that ARE its backend and everything else is rejected — `azure_ai/claude-opus-5` and `vertex_ai/claude-opus-5` are different rows at different prices, and `azure/us/gpt-5.6-sol` really is 10% over list. MEASURED 2026-08-18: anthropic 26 chat models, openai 90, gemini 50 + vertex_ai-language-models 29, xai 44, zai 13, meta 3, ollama 21 (all priced 0, correct for local inference).
- **OpenRouter** `/api/v1/models` for the gateway's OWN resale rates, provider-scoped to `openrouter` and never priced from a vendor rate — it bills its margin at the routed model's price, wrong by a different factor per model.

Lookup is EXACT on a normalized model key (trim + lowercase, nothing else), deliberately NOT the longest-substring matcher `resolveContextWindow` uses: a wrong context window skews a cosmetic percentage, a wrong price is wrong money, and `claude` alone matches both opus and haiku (~15x apart). Variant markers are kept verbatim (`glm-5.3[1m]`, `deepseek-v4-pro:cloud`) because a context or hosting variant is usually its own SKU. An unmatched id is UNPRICED, never guessed — which is why the manual-override path is load-bearing rather than a nicety (`glm-5.3` is in no feed).

One arithmetic trap: Anthropic-shaped usage reports `input_tokens` EXCLUSIVE of the cache buckets, while codex and gemini report it INCLUSIVE of the cached prefix (`INPUT_INCLUDES_CACHE_PROVIDERS`). Pricing those two without subtracting charges cached tokens at the full input rate. Separately, cache-WRITE rates are frequently absent from the feeds, which costs nothing in practice: MEASURED, only claude-code (which uses its reported cost anyway) and amp (subscription) ever report cache-creation tokens — 0 across 6,204 invocations for every other provider.

Admin control is two-level and BOTH are enforced at lookup, not only at sync, so a change takes effect on the next invocation rather than at the next refresh: `CONFIG_KEYS.PRICING_AUTO_UPDATE_ENABLED` is the global kill-switch, and `cli_pricing_sync.auto_update_enabled` per CLI means "this provider's rates are admin-owned" — its feed rows are ignored and only manual rates apply. Manual rates are effective-dated the same way (a write closes the previous one), and retiring one closes it rather than deleting, since the rows that priced past invocations must stay readable. Admin UI: a card on `/admin` for the global switch plus display currency, and `/admin/pricing` for per-CLI toggles, the rate table and overrides.

Costs are stored canonically in USD. `fx_rates` holds daily ECB USD-per-unit rates and a task converts at the rate effective on ITS OWN date (`resolveCostDisplay`), so re-rendering a finished task yields the same figure; dated on the task rather than per invocation because FX drift within one task is far below the displayed precision. ECB publishes only the current day, so past rows cannot be re-fetched — do not truncate that table. A task older than FX collection converts at the earliest rate on record and is flagged `approximate`.

## Sandbox

`packages/worker/src/sandbox/clawker-client.ts` wraps the clawker binary. The worker container mounts `/var/run/docker.sock` and uses Docker-in-Docker to spawn per-task containers. Only the cloned repository is bind-mounted into the per-task container. The worker filesystem and the user home directory are never exposed. CLI authentication files are copied into a named volume per task at startup and the volume is destroyed at task end.

Secret-file masking (default on, Tier 1): before each cli-exec invocation the worker hides files matching a secret deny-list from the AI CLI agent by bind-mounting empty read-only files over them inside the cli-exec sandbox (`packages/worker/src/queues/cli-exec/secret-mask.ts`, threaded via `resolveSecretMasks` in `exec-core.ts` for the `cli`/`agent_mining`/sub-agent kinds). The effective set is `DEFAULT_SECRET_DENY_GLOBS` (in `@haive/shared`) plus per-repo `secret_mask_deny_extend`, minus `DEFAULT_SECRET_CARVEOUTS` and per-repo `secret_mask_allow`. Untracked files only (`git ls-files` filter) — committed secrets are out of scope. The tracked filter asks each linked worktree about its own paths, because `git ls-files` reports paths relative to the tree it runs in, so the repo root never lists `.haive/worktrees/<name>/x`. The app runtime (app-runner/ddev mount the same `haive_repos` subpath without masks) still sees the real files. Per-repo controls live on the tooling settings page (`secret_mask_enabled`/`secret_mask_allow`/`secret_mask_deny_extend`); `CONFIG_KEYS.SECRET_MASK_ENABLED` is the global kill-switch.

Masking fails closed. A scan that throws, a scan root that is not a readable directory, a match count over `SECRET_MASK_LIMIT`, or a task/repository row that cannot be resolved raises `SecretMaskError` instead of masking a partial set — a subset leaves the remainder readable, which is the one outcome the deny-list exists to prevent. "Masking is off" and "no secrets found" are only ever concluded from evidence that says so: the kill-switch, `secret_mask_enabled`, or a task with no repository (which mounts no tree). The repo root mirrors `resolveTaskRepoMount` exactly, so a repo with no `storage_path` is scanned at its named-volume subpath rather than skipped, and the root is `stat`ed before the scan — glob answers `[]` for a root that does not exist, which is byte-identical to a clean repo, while the sandbox mount binds the real tree regardless of what the worker can see. `handleCliExecJob` records it on the invocation (exit -1) and fails the step. The escape hatches are the repo's `secret_mask_allow` globs and the masking toggles; disabling masking skips the scan and never raises.

Worktree gitfile masking (always on): every agent prompt states that git is unavailable inside the sandbox and that the host stages and commits (`10-gate-3-commit`, `completeMergeHostSide`). That invariant is enforced, not incidental — `worktreeGitfileMask` (`packages/worker/src/queues/cli-exec/gitfile-mask.ts`) bind-mounts an empty read-only file over the worktree's `.git` gitfile for every cli-exec invocation. Without it an agent can repoint the gitfile at the container path (`printf 'gitdir: /haive/workdir/.git/worktrees/<name>' > .git`), which both grants itself a working git behind the commit gate and leaves host-side git fatally broken for every later step. It rides the same `SandboxExtraFile` mechanism as secret masking but is an integrity control, so `SECRET_MASK_ENABLED` never disables it. Never masked at the repo root (there `.git` is a directory), and never applied to the terminal, IDE, app-runner or ddev containers, whose git must keep working. `removeWorktreeDir` runs `git worktree repair` before removal so worktrees poisoned before this existed still clean up.

## Build commands

- `pnpm install` installs all workspace dependencies.
- `pnpm build` runs `turbo run build` across the workspace; `@haive/shared` and `@haive/database` build first because all other packages depend on them.
- `pnpm typecheck` runs `tsc --noEmit` everywhere.
- `pnpm test` runs Vitest across the workspace.
- `pnpm test:e2e` runs Playwright against the dev compose stack.
- `pnpm db:push` runs `drizzle-kit push` against the database in `DATABASE_URL`.
- `pnpm docker:dev` (alias for `scripts/dev.sh up`) boots `docker-compose.yml` plus the dev override, GPU-aware. The script also exposes `rebuild`/`reset`/`restart`/`libs`/`logs`/`status` — run `pnpm docker help`.
- `pnpm docker:down` (alias for `scripts/dev.sh down`) stops everything; it keeps all data volumes (never `-v`).

The api and worker packages depend at build time on `@haive/shared` and `@haive/database`. Always build those two first when running anything outside of turbo.

## Conventions

- All modules are `"type": "module"`. Use `.js` extensions in import paths even for TypeScript sources because of `NodeNext` module resolution.
- Zod is used for both validation and for generating `FormSchema` field metadata where possible.
- Logger is `pino` from `@haive/shared/logger`. Never `console.log` from server code.
- Secrets are stored via envelope encryption: per-user DEK encrypts the secret, master KEK from `CONFIG_ENCRYPTION_KEY` encrypts the DEK. AES-256-GCM throughout.
- Drizzle schema lives in `packages/database/src/schema/`. Migrations in `packages/database/src/migrations/` are generated via `drizzle-kit generate` and applied via `drizzle-kit push`.
- Hono routes group by domain in `packages/api/src/routes/`. Auth middleware mounts globally.
- Forms are described by `FormSchema` from `@haive/shared` and rendered by `FormRenderer` in `@haive/web`. Do not write step-specific React components.
- A message column is display copy, never state. `task_steps.status_message`, `task_steps.error_message` and `cli_invocations.status_message` all outlive the thing they describe: a park whose poll chain ended leaves its last line behind, a step that failed once and succeeded later keeps its error text, and an invocation picked up immediately can be labelled "queued" by a write that lost a race. Gate UI on the structural column that proves the state (`waiting_started_at` for a runtime park, `status` for a failure, `started_at` for a queued invocation) and use the message only as the words inside the banner. The rule lives in `packages/web/src/lib/step-banners.ts` (`parkBanner` / `failureBanner` / `invocationBanner`, unit-tested) — extend that module rather than re-deriving the condition at a new call site. Keying on copy presence produced three separate phantom states in one day: two live "waiting for a slot" banners on one task, a `done` step rendering "cli invocation failed" with a Retry button, and a running CLI advertising "Queued — machine at capacity".
- Do NOT enforce that rule as a CHECK constraint or a nulling trigger. `error_message` on a `done` row is legitimate for `fixLoopOnError` steps (`step-runner.ts`), which write `status: 'done'` together with the error as the diagnosis that routes the fix loop back to implementation — a blanket "done implies no error" would silently destroy it. Repair stale copy with a numbered data migration instead (see `0104`, `0105`, `0106`).

## Where things live

- Step modules: `packages/worker/src/step-engine/steps/{onboarding,workflow,env-replicate}/`
- CLI adapters: `packages/worker/src/cli-adapters/`
- Sandbox wrapper: `packages/worker/src/sandbox/`
- Terminal proxy: `packages/api/src/routes/terminal.ts` plus `packages/web/src/components/terminal/`
- Orchestrator state machine: `packages/worker/src/orchestrator/state-machine.ts`
- Dispatcher priority chain: `packages/worker/src/orchestrator/dispatcher.ts`

## Phasing

Phase 0 scaffold is complete when `pnpm install` and `pnpm docker:dev` boot all services on a clean host with only Docker installed. Subsequent phases build the database schemas, auth, repository management, CLI adapters, sandbox, terminal proxy, step engine, sub-agent emulator, autonomous workflow, and environment replication in that order.

## Constraints

- WSL2 plus Docker is the only supported developer environment. No Windows-native installs.
- Concurrent per-task runtimes (DDEV/app runners) and CLI agents share ONE machine-aware RAM budget (`total - ~30% reserve`), not a fixed count. Two distinct numbers: the Docker `--memory`/CPU/pid **cap** each container runs under (a generous ceiling, swap disabled) and the **planning weight** admission budgets it at. Dividing the budget by the ceiling is what used to price a ~300 MB app-runner like a DDEV DinD. Weights are CALIBRATED absolutes, not fractions of the cap (a project's runner uses the same RAM on a 16 GB host as on a 64 GB one), measured from 1731 `docker stats` samples over 4 DDEV runners and 52 agent sandboxes: `ddevWeightMb` 1536 (peak 1036 incl. a full cold boot), `browserWeightMb` +1536 surcharge for tasks in browser testing (browser-phase peak 2505), `agentWeightMb` 2048 (peak 1736), `appWeightMb` 1024 (the one unmeasured weight — strictly less machinery than a DDEV base). Each is clamped to the container cap, since a runner cannot occupy more than `--memory`. A cold `ddev start` is NOT the peak (image pulls are disk-bound); the peak is agent work during a verify/fix round, which is also when the browser desktop is up — so the browser flag is a proxy for that phase, not the cause. Agents take what the runtime pool leaves free, never below `agentFloor` (a runtime holder needs an agent to finish, so zero agents deadlocks). Admin-tunable: RESOURCE_LIMITS_ENABLED / RUNTIME_MEMORY_MB / RUNTIME_CPUS / MAX_CONCURRENT_RUNTIMES=0 means no count cap / RUNTIME_DDEV_WEIGHT_MB / RUNTIME_APP_WEIGHT_MB / RUNTIME_BROWSER_WEIGHT_MB / AGENT_WEIGHT_MB / AGENT_FLOOR / MAX_PARALLEL_AGENTS=0 means auto / RUNTIME_IDLE_REAP_MINUTES. On a DEV host the binding constraint is usually the base stack, not the weights: `next dev` alone holds ~1.6 GB and Ollama ~1 GB against the 30% reserve, so pin MAX_CONCURRENT_RUNTIMES or cap the dev web server's heap rather than raising weights. A step is gated only if it will actually spawn a runner (`needsRuntime: 'ddev' | 'app' | 'if-serving'`; `'if-serving'` resolves through `classifyRuntime`, so a code-only task never queues for a pool it does not use). A reaper reclaims leaked runners. See packages/worker/src/sandbox/{runtime-caps,runtime-admission,runtime-runner-reaper}.ts and `deriveRuntimeCaps`/`deriveAgentConcurrency` in @haive/shared.
- Runtime occupancy sizing the agent pool is only half the story: WHO gets those few slots matters too. A task holding NO live runtime runner yields its cli-exec slot to one that does (`enforceRuntimeHolderReserve`, `queues/cli-exec/agent-reserve.ts`), because a runner-holder's idle time is billed in committed RAM it can only release by FINISHING — while a runner-less task's slot is fungible. Observed without it: 3 tasks each holding a 3072 MB DDEV, two idle, an onboarding task holding one of the only 2 agent slots, and 4 more tasks parked behind capacity that could not free. Enforced at job PICKUP (a third sibling to `enforcePauseGate`/`enforceTaskAgentCap`, same `moveToDelayed` + `DelayedError`), never at enqueue — BullMQ freezes priority at `queue.add` while runner-holding is state that changes. Keyed on the docker-label invariant "holds a live runner", NOT on `tasks.type`, so a future runner-less task type inherits it. Demand is counted from the BullMQ WAITING list, not from queued `cli_invocations` rows: a DB count includes jobs that are delayed (paused task, per-task cap) and yielding to those idles the slot. Not preemption — a running agent keeps its slot. Admin-tunable: AGENT_RESERVE_ENABLED (off = first-come) / AGENT_RESERVE_MAX_HOLD_MINUTES (0 = strict, else release a held invocation after N minutes so runner-less work slows rather than stops).
- The Docker socket mount in the worker container is effectively root on the host. Document this in the README and offer rootless Docker instructions in Phase 9 hardening.
- All step content lives in TypeScript modules. Do not pipe legacy markdown into a CLI prompt.

## Onboarding template versioning

Deterministic onboarding artifacts (agent specs, slash commands, `workflow-config.json`, Drupal LSP plugin files, the `agents/README.md` index) are registered as `TemplateItem`s in `packages/worker/src/step-engine/template-manifest.ts`. Every item has:

- `id`: stable slug (e.g. `agent.code-reviewer`, `command.review`, `workflow-config`).
- `schemaVersion`: integer, bumped only on shape-breaking changes (filename change, new required frontmatter field).
- `contentHash`: sha256 over the rendered reference output, computed on worker boot from `REFERENCE_CONTEXT` and cached per-manifest.
- `render(ctx)`: invokes the existing generator and returns `TemplateRendering[]`; multiple renderings per item when an agent fans out across CLI target dirs.

On worker boot, `syncTemplateManifestCache(db)` upserts the manifest into Postgres (`template_manifest_cache`) so the API can compute the current set hash without importing worker-side generators. Per-repo install state lives in `onboarding_artifacts`, one live row per `(repository_id, disk_path)`, soft-deleted via `superseded_at`.

### When changing a template

1. **Body-only change (rewording an agent prompt, fixing a typo, updating a command example):** edit the generator in `_agent-templates.ts` / `07-generate-files.ts`. The manifest's `contentHash` recomputes on worker boot and the upgrade-status endpoint starts reporting the template as changed. **Do not bump `schemaVersion`.**
2. **Shape change (rename agent id, change `workflow-config.json` schema, change a command's disk path):** bump the item's `schemaVersion` in `template-manifest.ts`. Rollback across a `schemaVersion` bump restores the prior artifact's stored bytes (migration 0013) and reverts correctly; only legacy rows written before stored content existed refuse to revert across a bump (they have no prior bytes and re-rendering a changed shape is unsafe).
3. **New template:** add the generator, append to `buildTemplateItems()` in `template-manifest.ts`. First upgrade per-repo will surface it in the `new_artifact` bucket.
4. **Removed template:** delete the `TemplateItem`. First upgrade per-repo will surface existing artifacts in the `obsolete` bucket.

Out of scope of onboarding-upgrades: `.claude/skills/` and agents written from LLM discovery (06_5) without a bundle source, `.claude/knowledge_base/`, `.claude/mcp_settings.json`, `.claude/onboarding-review.md`. **Skills and agents installed from custom bundles are tracked and upgradable** (each bundle item lands as an `onboarding_artifacts` row with `templateId = "custom.<bundleId>.<itemId>"`; the `bundle_resync` step before `01-upgrade-plan` refreshes git bundles and the upgrade-plan/apply path treats `custom.*` rows the same as Haive templates). LLM-generated skills and KB content are refreshed by the `/workflow` code-change phase. `mcp_settings.json` is user-owned — created on first onboarding, never rewritten. The review file is one-shot; each upgrade writes a new `.claude/upgrade-reviews/<task_id>.md`.
