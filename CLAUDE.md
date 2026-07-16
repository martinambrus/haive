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
- clawker (Apache 2.0 Go binary) wrapped via child_process for per-task Docker sandboxes; pinned at worker image build time

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

`packages/worker/src/cli-adapters/base-adapter.ts` defines `BaseCliAdapter`. Implemented adapters: `claude-code`, `codex`, `gemini`, `amp`, `zai`, `antigravity`, `ollama`. Each declares `supportsSubagents`, `supportsCliAuth`, `supportsMcp`, `supportsPlugins`, `defaultAuthMode` (`subscription` or `api_key`), and `apiKeyEnvName`. `supportsSteering` defaults to false; only the Claude-family adapters (`claude-code`, `zai`, `ollama`) override it to true.

The dispatcher (`resolveDispatch`) filters to enabled providers, orders the resolved preferred provider first, and picks the first whose adapter is registered and has `supportsCliAuth` — plus `supportsSubagents` when the step declares the `subagents` capability. If none matches, the step is skipped. Every plan it emits is a CLI invocation; there is no API-mode branch. Auth mode selects which credentials the CLI is given, not whether the dispatcher bypasses the CLI.

The sub-agent emulator splits a single sub-agent specification into either a native `Task()` call (Claude Code) or a sequential prompt script (everything else). A sequential script runs inside a single `cli-exec-queue` job — the runner is an in-memory for-loop over the sub-steps, with no per-sub-step DB writes. A crash mid-script therefore fails the whole invocation; restart re-runs from sub-step 0. (Mid-script resume would require persisting each sub-step's parsed output to `cli_invocations` before moving on — not implemented.)

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

## Where things live

- Step modules: `packages/worker/src/step-engine/steps/{onboarding,workflow,env-replicate}/`
- CLI adapters: `packages/worker/src/cli-adapters/`
- Sandbox wrapper: `packages/worker/src/sandbox/`
- Terminal proxy: `packages/api/src/routes/terminal.ts` plus `packages/web/src/components/terminal/`
- Orchestrator state machine: `packages/worker/src/orchestrator/state-machine.ts`
- Dispatcher priority chain: `packages/worker/src/orchestrator/dispatcher.ts`

## Phasing

Phase 0 scaffold is complete when `pnpm install` and `pnpm docker:dev` boot all services on a clean host with only Docker installed. Subsequent phases build the database schemas, auth, repository management, CLI adapters, sandbox, terminal proxy, step engine, sub-agent emulator, autonomous workflow, and environment replication in that order. See the project plan in `/home/zathrus/.claude/plans/vivid-greeting-stroustrup.md` for the full sequence.

## Constraints

- WSL2 plus Docker is the only supported developer environment. No Windows-native installs.
- Concurrent per-task runtimes (DDEV/app runners) are bounded by a machine-aware resource governor, not a fixed count: each runner gets Docker memory/CPU/pid caps (swap disabled) and an admission gate limits how many run at once, both auto-derived from host RAM/CPU and admin-tunable (RESOURCE_LIMITS_ENABLED / RUNTIME_MEMORY_MB / RUNTIME_CPUS / MAX_CONCURRENT_RUNTIMES / RUNTIME_IDLE_REAP_MINUTES). A reaper reclaims leaked runners. See packages/worker/src/sandbox/{runtime-caps,runtime-admission,runtime-runner-reaper}.ts.
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
