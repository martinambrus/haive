# Haive

Deterministic multi-CLI orchestration and AI agentic workflow utility. Reimplements a legacy markdown-driven Claude Code workflow, the autonomous `/workflow` implementation loop, and a sandboxed local environment replication step set as a deterministic web project. Agentic CLI invocations only happen for parts that genuinely need reasoning. Everything else runs as TypeScript step modules with web forms.

The legacy markdown step content has been ported into TypeScript step modules under `packages/worker/src/step-engine/steps/`. The original source archive is no longer vendored in the repo.

## Stack

- pnpm workspace monorepo, turborepo
- Node 24, TypeScript 5.7, ES2024 target, NodeNext modules
- Hono 4 REST API on port 3001
- Next.js 16 + React 19 + Tailwind 4 web UI on port 3000
- Drizzle ORM on PostgreSQL 18, postgres.js driver
- BullMQ on Redis 8 (noeviction policy is required)
- Uploaded repo archives live in the `haive_repos` named volume (shared by api and worker); Mailpit for dev SMTP
- Docker Compose orchestrates everything; `docker compose up` is the only supported boot path
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
- `cli-exec-queue` runs the sandbox worker. One job per CLI invocation. Spawns clawker, attaches PTY, streams output via Redis pub/sub.
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

`packages/worker/src/cli-adapters/base-adapter.ts` defines `BaseCliAdapter`. Initial adapters: `claude-code`, `codex`, `gemini`, `amp`, `grok`, `qwen`, `kiro`, `zai`. Each declares `supportsSubagents`, `supportsApi`, `supportsCliAuth`. The dispatcher resolves execution via a priority chain: subscription CLI to BYOK API to platform API to CLI fallback to skip.

The sub-agent emulator splits a single sub-agent specification into either a native `Task()` call (Claude Code) or a sequential prompt script (everything else). A sequential script runs inside a single `cli-exec-queue` job — the runner is an in-memory for-loop over the sub-steps, with no per-sub-step DB writes. A crash mid-script therefore fails the whole invocation; restart re-runs from sub-step 0. (Mid-script resume would require persisting each sub-step's parsed output to `cli_invocations` before moving on — not implemented.)

## Sandbox

`packages/worker/src/sandbox/clawker-client.ts` wraps the clawker binary. The worker container mounts `/var/run/docker.sock` and uses Docker-in-Docker to spawn per-task containers. Only the cloned repository is bind-mounted into the per-task container. The worker filesystem and the user home directory are never exposed. CLI authentication files are copied into a named volume per task at startup and the volume is destroyed at task end.

## Build commands

- `pnpm install` installs all workspace dependencies.
- `pnpm build` runs `turbo run build` across the workspace; `@haive/shared` and `@haive/database` build first because all other packages depend on them.
- `pnpm typecheck` runs `tsc --noEmit` everywhere.
- `pnpm test` runs Vitest across the workspace.
- `pnpm test:e2e` runs Playwright against the dev compose stack.
- `pnpm db:push` runs `drizzle-kit push` against the database in `DATABASE_URL`.
- `pnpm docker:dev` boots `docker-compose.yml` plus the dev override.
- `pnpm docker:down` stops everything.

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
- Never run more than 7 concurrent worker tasks; WSL crashes under heavier parallelism.
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
2. **Shape change (rename agent id, change `workflow-config.json` schema, change a command's disk path):** bump the item's `schemaVersion` in `template-manifest.ts`. Rollback of upgrades that crossed this bump will refuse to revert and tell the user to redeploy the prior Haive image.
3. **New template:** add the generator, append to `buildTemplateItems()` in `template-manifest.ts`. First upgrade per-repo will surface it in the `new_artifact` bucket.
4. **Removed template:** delete the `TemplateItem`. First upgrade per-repo will surface existing artifacts in the `obsolete` bucket.

Out of scope of onboarding-upgrades: `.claude/skills/` and agents written from LLM discovery (06_5) without a bundle source, `.claude/knowledge_base/`, `.claude/mcp_settings.json`, `.claude/onboarding-review.md`. **Skills and agents installed from custom bundles are tracked and upgradable** (each bundle item lands as an `onboarding_artifacts` row with `templateId = "custom.<bundleId>.<itemId>"`; the `bundle_resync` step before `01-upgrade-plan` refreshes git bundles and the upgrade-plan/apply path treats `custom.*` rows the same as Haive templates). LLM-generated skills and KB content are refreshed by the `/workflow` code-change phase. `mcp_settings.json` is user-owned — created on first onboarding, never rewritten. The review file is one-shot; each upgrade writes a new `.claude/upgrade-reviews/<task_id>.md`.
