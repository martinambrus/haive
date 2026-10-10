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

Three queues carry the core pipeline (`QUEUE_NAMES` in `@haive/shared` declares more —
repo, bundle, runtime/ide ensure, ddev control, usage and PR polling, and plan mirror):

- `task-queue` runs the orchestrator. One job per task. Owns the step machine and persists every transition to Postgres.
- `cli-exec-queue` runs the sandbox worker. One job per CLI invocation. Spawns a per-task Docker sandbox via `docker run`/`create` (`sandbox/docker-runner.ts`) — NOT clawker (clawker backs the persistent terminal/login containers in `sandbox/container-manager.ts`); captures piped stdout/stderr and streams to a Redis Stream (`cli-stream:<invocationId>`). Steerable Claude-family runs keep stdin open (`-i`) so a user steer reaches the CLI mid-run.
- `env-replicate-queue` runs Dockerfile builds for environment replication.
- `plan-mirror-queue` reconciles the repository-backed plan snapshot: a `refresh` rewrites
  `.haive-data/plan.{json,md}`, a `save` also commits and optionally pushes, and a 10s
  scheduled sweep drains `plan_mirror_state` rows whose `written_revision < revision`.

State source of truth is Postgres. Every step transition, every CLI invocation, every form submission is a row. Crash recovery reads the last row.

## Step engine

Every legacy markdown step becomes a `StepDefinition<TInput, TOutput>` with four phases:

1. `detect` runs first. Pure or shells out via clawker. No LLM. Always runs.
2. `form` returns a `FormSchema`. The web UI renders the schema and the user submits values.
3. `llm` is optional. Spawns a CLI invocation through the dispatcher. For CLIs without native sub-agents the splitter emits a sequential script.
4. `apply` runs last. Writes outputs to `task_steps.output` and to actual files under the workspace.

Step lifecycle: `pending` to `running(detect)` to `waiting_form` to `running(apply)` to optional `waiting_cli` then back to `running(apply)` to `done` or `failed` or `skipped`.

## Build commands

- `pnpm install` installs all workspace dependencies.
- `pnpm build` runs `turbo run build` across the workspace; `@haive/shared` and `@haive/database` build first because all other packages depend on them.
- `pnpm typecheck` runs `tsc --noEmit` everywhere.
- `pnpm test` runs Vitest across the workspace.
- `pnpm test:e2e` runs Playwright against the dev compose stack.
- A smoke that puts jobs on a queue (`smoke:onboarding`, `smoke:workflow`, `smoke:fix-loop` and
  their siblings) needs its OWN Redis and database, as CI gives it. Pointed at the dev stack's, the
  dev worker takes its jobs off the shared queue and runs them with the dev stack's code rather than
  the branch's. Start a throwaway `redis` container and a scratch database for it.
- `pnpm --filter @haive/database migrate` applies pending SQL migrations to `DATABASE_URL`. This is the applier: the `db-migrate` compose one-shot and CI both run it, and api/worker/web wait for it via `depends_on: service_completed_successfully`.
- `pnpm db:push` (`drizzle-kit push`, interactive) is the DEV escape hatch, not the applier. Use it to iterate on a schema shape, then hand-write the numbered migration before committing — the CI `schema-parity` job compares the two and goes red if they disagree. It will offer to DROP `schema_migrations`, because that table is deliberately absent from the Drizzle barrel; accepting is recoverable (the next `migrate` re-adopts) but never what you want.
- `pnpm docker:dev` (alias for `scripts/dev.sh up`) boots `docker-compose.yml` plus the dev override, GPU-aware. The script also exposes `rebuild`/`reset`/`restart`/`libs`/`logs`/`status` — run `pnpm docker help`.
- `pnpm docker:down` (alias for `scripts/dev.sh down`) stops everything; it keeps all data volumes (never `-v`).

The api and worker packages depend at build time on `@haive/shared` and `@haive/database`. Always build those two first when running anything outside of turbo.

### Never drive compose directly

`scripts/dev.sh` is the only supported entry point for the stack LIFECYCLE — run it as
`pnpm docker <command>` (or `bash scripts/dev.sh <command>`). Do not run raw
`docker compose up/build/down` by hand: dev.sh layers `-f docker-compose.yml -f
docker-compose.dev.yml` and then adds an auto-detected `docker-compose.gpu.yml` (NVIDIA) or
`docker-compose.vulkan.yml` (Intel/AMD iGPU). A hand-run `docker compose up` silently omits
all of that, so it boots WITHOUT the dev override and pins Ollama to the CPU — a stack that
looks healthy and is merely slow, which is why the mistake surfaces late. Never add `-v`,
and never prune this project's volumes.

- `pnpm docker restart [service...]` recreates services and rebuilds shared libraries once.
- `pnpm docker rebuild [service...]` handles dependency or lockfile changes and recreates the appropriate dependency volumes. Use it without a service for root, shared, or database dependency changes.
- `pnpm docker reset` recovers stale or corrupt compiled output while preserving application data.
- `pnpm docker libs` rebuilds `@haive/database` and `@haive/shared` with one container writer.

Host-side `pnpm build`, `pnpm --filter ... build`, `pnpm typecheck` and `pnpm test` are
SUPPORTED and expected — turbo's `test` and `typecheck` tasks both declare
`dependsOn: ["^build"]`, so those two build `shared`/`database` on the host by design.
`packages/*/dist` is on the `.:/app` bind mount and therefore has two writers: the host
(uid 1000) and the root-running `dev-libs` container. `scripts/build-libs.sh` chowns both
dist dirs back to the repo owner after every build, failed ones included, precisely so the
host build always has a directory it can write — read its header before changing any of
this. MEASURED: a host `pnpm --filter @haive/shared build` exits 0 in ~5s, emits
byte-identical output to the container build, leaves dist uid-1000-owned, and api, worker
and web keep serving across it. If a host build ever fails with TS5033/EACCES under
`packages/*/dist`, run `pnpm docker libs` and retry; never chown by hand.

`pnpm install` is the one to prefer running through `pnpm docker rebuild`. api, worker and
web each mask `node_modules` with a named volume, so a host install cannot reach them — but
`db-migrate` is the single service with no such override and installs as root straight into
the bind-mounted host tree. A host install is not destructive, it just races that one
container. Two things follow from that shared tree, and BOTH are load-bearing in
`docker-compose.dev.yml`: db-migrate runs on `node:26-bookworm-slim` rather than alpine,
because pnpm resolves native optional deps for the libc it runs on and an alpine install
filled the host's store with musl builds (host `pnpm test` then died in rolldown with
"Cannot find native binding", whose named cause — a missing wasm fallback — is a red
herring: the dep resolved fine, for the wrong libc); and its command chowns
`/app/node_modules` back to the repo owner, the same dance `scripts/build-libs.sh` does for
`packages/*/dist`, since otherwise the tree it writes is root-owned and the host cannot
re-install to repair the store it just read.

For source-only changes to the api, worker, or web app, rely on the bind-mounted source and
the service's dev watcher first; confirm the loaded source and the logs before deciding a
restart or rebuild is necessary. The api and worker watchers POLL (`CHOKIDAR_USEPOLLING` in
`docker-compose.dev.yml`, read by the chokidar tsx bundles): watching by events, tsx stopped
seeing a file once git had replaced it on the bind mount, so a pull could leave the old code
running with no restart line. MEASURED in the worker container: the second `git checkout` of one
file and every write after it went unseen, all of them seen when polling, at ~1.6% of one core
for all 744 worker source and lib files polled once a second. A check with no repository wrapper runs inside the matching
existing service container — `docker exec` is fine for diagnostics and tests, but never to
install dependencies or rebuild runtime artifacts. Before restarting or rebuilding the
worker, inspect active tasks: recreating it can interrupt live CLI terminals and
in-progress task steps.

## Conventions

- All modules are `"type": "module"`. Use `.js` extensions in import paths even for TypeScript sources because of `NodeNext` module resolution.
- Zod is used for both validation and for generating `FormSchema` field metadata where possible.
- Logger is `pino` from `@haive/shared/logger`. Never `console.log` from server code. ONE exception, and it is structural rather than a lapse: `packages/database/src/migrate/` is a CLI and `@haive/shared` DEPENDS ON `@haive/database`, so importing the logger back would be a dependency cycle. It emits one JSON line per event through its own `emit()`.
- Host-side IO on a repository path goes through `@haive/shared/fs-safe`, never through a path-based `node:fs` call. The worker and the api run as root over trees that repositories and sandboxed agents write, so a path resolved by name is a path they can redirect; the primitives take `(anchor, rel)`, resolve `rel` one held directory descriptor at a time, refuse a link in any component, and verify the held inode through `/proc/self/fd` (Node-only, Linux-only, out of the root barrel and of every subpath web imports). Anchors are `<storage>/<userId>/<repoId>` or a repository's `localPath` — never `.haive`, a worktree or an uploads dir, since the sandbox mounts the whole repository root read-write. `packages/shared/test/fs-ratchet.test.ts` pins the remaining path-based calls per file (`fs-ratchet.json`, exact counts): a conversion lowers its entry, and a new call needs a reason in the PR. A child process follows the same rule: `runTool` (`worker/src/repo/tool-spawn.ts`) hands `tar`, `unzip` and `pdftotext` what they read and write as held descriptors, named `/proc/self/fd/N` in the child, never a path they would resolve by name, and runs them with PATH and LANG only, as uid 65534 under a root worker. A tool that re-opens its input (unzip seeks) needs that uid to be able to read it. Every upload is written 0644, and a file that is not is copied through the descriptor into a private, already unlinked file the uid can read (`toolReadable`), so the original's mode is never changed.
- postgres.js is patched (`patches/postgres@3.4.9.patch`, pnpm `patchedDependencies`; upstream
  porsager/postgres#1209, unreleased) so a connection whose backend died rejects what it still owes
  instead of writing to its closed socket. In 3.4.9 a transaction's ROLLBACK did that from a
  `setImmediate`, and the TypeError killed the api or worker process. Every image copies `patches/`
  before `pnpm install`, which refuses the lockfile without it, and a lockfile change reaches the dev
  stack only through `pnpm docker rebuild`. A pool opened for one job ends with `end({ timeout: 5 })`:
  after such a drop a bare `end()` never settles. `smoke:pg-drop` covers both, and is how to tell
  whether a later release carries the fix and the patch can go. Dependabot leaves postgres to a
  person (`.github/dependabot.yml`): pnpm refuses a lockfile whose patch matches no installed
  version (`ERR_PNPM_UNUSED_PATCH`), so a bump in its weekly group would fail the whole group.
  3.4.9 also starts a connection's first type query unawaited (`connection.js` `fetchArrayTypes`),
  so a drop during it rejects with nobody listening. The api and the worker therefore both log an
  unhandled rejection at error level and keep running (`api/src/lib/unhandled-rejection.ts`,
  `worker/src/index.ts`): in dev they run under `tsx watch`, which does not restart after a crash.
- Secrets are stored via envelope encryption: per-user DEK encrypts the secret, master KEK from `CONFIG_ENCRYPTION_KEY` encrypts the DEK. AES-256-GCM throughout.
- Drizzle schema lives in `packages/database/src/schema/`. Migrations are hand-written SQL in `packages/database/migrations/`, applied in filename order by the runner in `packages/database/src/migrate/`, one transaction per file with its `schema_migrations` row written inside it. **To add one:** iterate with `pnpm db:push`, then write `NNNN_name.sql` in that directory, keeping the guarded idempotent style (`ADD COLUMN IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`) — a developer's database is often legitimately AHEAD of the baseline and must survive your file. Declare a new column LAST in its Drizzle table: `ALTER TABLE ADD COLUMN` appends while `drizzle-kit push` builds the table in declaration order, so a column declared anywhere else makes the two schemas differ by column ORDER and turns `schema-parity` red — a failure no migration can fix. Never edit an applied migration: its sha256 is recorded, and a change hard-fails every install that ran it. `0000_baseline.sql` is generated and FROZEN; re-cutting the schema means a later numbered baseline, never an edit to that one. `pre-baseline/` is the record written before the directory was executable and is NEVER run — see its README: 19 of those files are unsafe to replay and one is destructive.
- Hono routes group by domain in `packages/api/src/routes/`. Auth middleware mounts globally.
- A request that changes state, and every WebSocket handshake, is refused when it comes from a page
  other than the app's own (`isForeignOrigin`, `api/src/lib/request-origin.ts`). The session cookie
  is `SameSite=Lax`, and every page on the same site still sends it: on localhost that is every
  other port, the task's own app among them, so the cookie alone cannot say which page asked. The
  api's own origin is allowed because the editor it proxies runs there. It is resolved as the
  browser resolves it (`HAIVE_PUBLIC_API_URL`, else the app's host on `HAIVE_API_PORT`), not read
  off `Host`, which a reverse proxy may rewrite to its upstream. A request with no `Origin` did not
  come from a browser page. A GET must not start work either, since a link from any site carries
  the cookie on a top-level GET; that is why the runtime access routes are POST. A new `'upgrade'`
  listener fails `upgrade-origin.test.ts` until the test covers it.
- Forms are described by `FormSchema` from `@haive/shared` and rendered by `FormRenderer` in `@haive/web`. Do not write step-specific React components.
- EVERY prose body renders through `MarkdownView` / `.haive-md` (`packages/web/src/components/markdown/`). There is no plain-text branch. The rules behind that, from the one renderer to option labels and nested bodies, are in [Markdown rendering](docs/architecture/markdown-rendering.md).
- A fenced code block is found by one scanner, `scanFences` (`@haive/shared/markdown-fences`), and
  never by a hand-rolled regex. It reads CommonMark's rules: a run of three or more backticks or
  tildes behind at most three spaces, closed only by a run of the same character at least as long
  with nothing after it, and an unclosed fence runs to the end of the text. A three-backtick regex
  read a four-backtick fence's inner triple as its close, which lifted a quoted before/after pair
  out as a side-by-side block and hid long blocks from the collapse toolbar. A line scanner cannot
  see a fence inside a list item indented four or more spaces, or behind a blockquote's `>`. One
  reader pairs differently on purpose: `11-final-review` unwraps a model's reply whose first line
  opens a fence and whose last line closes it (`fenceOpener`, `closesFence`), and keeps the lines
  between as they are, since a ` ```markdown ` wrapper holds ` ``` ` samples that close
  it by CommonMark's rules.
- A message column is display copy, never state. `task_steps.status_message`, `task_steps.error_message` and `cli_invocations.status_message` all outlive the thing they describe: a park whose poll chain ended leaves its last line behind, a step that failed once and succeeded later keeps its error text, and an invocation picked up immediately can be labelled "queued" by a write that lost a race. Gate UI on the structural column that proves the state (`waiting_started_at` for a runtime park, `status` for a failure, `started_at` for a queued invocation) and use the message only as the words inside the banner. The rule lives in `packages/web/src/lib/step-banners.ts` (`parkBanner` / `failureBanner` / `invocationBanner`, unit-tested) — extend that module rather than re-deriving the condition at a new call site. Keying on copy presence produced three separate phantom states in one day: two live "waiting for a slot" banners on one task, a `done` step rendering "cli invocation failed" with a Retry button, and a running CLI advertising "Queued — machine at capacity".
- Do NOT enforce that rule as a CHECK constraint or a nulling trigger. `error_message` on a `done` row is legitimate for `fixLoopOnError` steps (`step-runner.ts`), which write `status: 'done'` together with the error as the diagnosis that routes the fix loop back to implementation — a blanket "done implies no error" would silently destroy it. Repair stale copy with a numbered data migration instead (see `0104`, `0105`, `0106`).
- `status = 'waiting_form'` alone does not mean a form is waiting for someone. The submit route clears `waiting_started_at` and leaves the status for the worker to move when it picks the job up, so a poller that stops on the status stops on a turn that was just sent. `isAwaitingFormInput` (`web/src/lib/submit-state.ts`) reads both columns, as the task page's step timer already does; the task queue stamps the column on every park it records (none of the 8 parked steps on the dev install lacked it).

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
- The Docker socket mount in the worker container is effectively root on the host. Document this in the README and offer rootless Docker instructions in Phase 9 hardening.
- All step content lives in TypeScript modules. Do not pipe legacy markdown into a CLI prompt.

## Topic index

The rest of the project's documentation lives under `docs/architecture/`, one file per topic.
Before changing code in an area below, or answering a question about it, read its file in full:
most of it records MEASURED decisions that look wrong in isolation. The names after each entry are
the files and symbols it governs. Put new material in the topic it belongs to, or in a new file
listed here, and keep this file under 32 KiB: Codex CLI reads no more of it than that.

### Step engine

- [Effort estimation](docs/architecture/effort-estimation.md): same-path history, sparse
  fallback, calibration and post-planning refinement. `00b-estimate`, `_estimate.ts`,
  `_task-embedding.ts`, `06b-sprint-planning`.
- [Fix loop](docs/architecture/fix-loop.md): `loop_back` rounds, DAG-mode fix rounds, failures no
  agent can repair, a long diagnosis kept by both ends, a repeat from the same check, guidance
  outside the fence. `_fix-loop.ts`,
  `_test-env-guard.ts`, `loadPriorFixContext`, `excerptDiagnosis`, `loadSameCheckRepeat`.
- [Step summaries](docs/architecture/step-summaries.md): the "What the agent did" panel,
  remembered and per-task CLI choices. `_step-summary.ts`, `task_step_cli_choices`.
- [Staged agent bodies](docs/architecture/staged-agent-bodies.md): document bodies written to
  `.haive/kb-draft/` rather than the reply. `_kb-body-file.ts`.
- [Fan-out dispatch](docs/architecture/fan-out-dispatch.md): mining agents reserved before
  sending, compare-and-swap on agent rows. `dispatchMiningAgents`, `handleCliExecJob`.
- [Worker restarts](docs/architecture/worker-restarts.md): boot recovery, stalled tasks, START
  claims, step ownership, Retry/Stop/Resume fencing. `task-queue.ts`, `step-runner.ts`,
  `step-ownership.ts`, `queues/boot-requeue.ts`, `queues/stalled-redrive.ts`.
- [Merge conflicts](docs/architecture/merge-conflicts.md): the shared git merge core, fixer
  baselines and leftovers. `git-merge.ts`, `12-worktree-cleanup`, `01-plan-merge`.
- [Workflow commits](docs/architecture/workflow-commits.md): generated gate-3 messages, pending
  change excerpts and editable approval. `10-gate-3-commit`, `_commit-diff.ts`.

### CLI adapters

- [CLI adapter system](docs/architecture/cli-adapters.md): capabilities, claude-binary wrappers,
  `model_identity`, `tool_usage`, `haive_build`, `resolveDispatch`. `base-adapter.ts`,
  `tool-usage.ts`, `build-stamp.ts`.
- [Steering](docs/architecture/steering.md): mid-run steers per CLI, the codex app-server and its
  fallback, the steer echo. `codex-app-server.ts`, `steer-echo.ts`.
- [Skills per CLI](docs/architecture/skills-per-cli.md): what each CLI needs to list repo skills,
  frontmatter YAML. `CLAUDE_FAMILY_SKILLS_ENV`, `_yaml-scalar.ts`.
- [Agent rules](docs/architecture/agent-rules.md): provider rules prepended to every prompt
  dispatch. `orchestrator/agent-rules.ts`.

### Prompts and retrieval

- [RAG playground and usage review](docs/architecture/rag-playground.md): personal query replay,
  saved results, finalization assessments and evidence bounds. `rag-playground.ts`, `_rag-usage.ts`.
- [Retrieval protocol](docs/architecture/retrieval-protocol.md): the discover-then-ground block
  and its variants. `_retrieval-guidance.ts`.
- [Prompt containment](docs/architecture/prompt-containment.md): repo-is-data guards, fences,
  values on prompt lines. `_untrusted-repo.ts`, `fencedAgentBlock`, `balanceFences`.
- [RAG embedding failures](docs/architecture/rag-embedding-failures.md): no hash vectors, embed
  timeouts, lexical-only repos. `_rag-embed-health.ts`, `ensureRagSchema`.
- [Identifier search](docs/architecture/identifier-search.md): identifiers indexed whole, IDF
  ranking. `identifiers.ts`.
- [Knowledge reserve in retrieval](docs/architecture/knowledge-reserve.md): KB slots on every
  page. `applyKnowledgeReserve`, `mergeHits`.
- [Global knowledge base](docs/architecture/global-kb.md): instance-wide house standards, the title
  list, admin-enforced house rules and who is shown them, the 07b check and the gates' House rules
  row, facets and framework families. `_global-kb-digest.ts`, `house-rules.ts`,
  `resolveGlobalKbContext`, `_gate-house-rules.ts`, `extractProjectFacets`.

### Plans and attachments

- [Plan canvas](docs/architecture/plan-canvas.md): plan nodes and their one writer, plan build,
  clarifying questions, plan chat, sequencing, "Start next", impact, the mirror. `applyPlanPatch`,
  `computePlanReady`, `buildPlanExpansionContext`, `00b-plan-clarify`.
- [Task attachments](docs/architecture/task-attachments.md): relative-path names, archive
  expansion, the attachments lock, prompt caps. `expand-archives.ts`, `withTaskAttachmentsLock`.
- [Database persistence](docs/architecture/database-persistence.md): pinned project dumps,
  concurrent save decisions and automatic cleanup. `11g-save-database`, `database-snapshots.ts`.
- [Plan inputs](docs/architecture/plan-inputs.md): 00-plan-inputs extraction, the `vision`
  requirement, live inputs. `00-plan-inputs.ts`, `_plan-inputs.ts`.

### Review

- [Review scope](docs/architecture/review-scope.md): the changed-files collector, line-level
  scope, DAG review cost, similar sites. `_impl-changes.ts`, `_scope-fence.ts`,
  `sprintReviewEnabled`.
- [Review findings and waivers](docs/architecture/review-findings.md): dispositions, recurrence,
  fingerprints. `_review-findings.ts`.
- [Review dimensions](docs/architecture/review-dimensions.md): the 14 dimensions, repository
  policy and task override. `REVIEW_DIMENSIONS`.

### Spend and statistics

- [Model pricing and spend](docs/architecture/model-pricing.md): cost precedence, billable and
  notional spend, price feeds, FX. `resolveCostDecision`, `model-prices.ts`.
- [Statistics](docs/architecture/statistics.md): `/stats` endpoints, day bucketing, charts,
  per-step spend, tool usage, throughput.
  `@haive/shared/stats`, `components/stats/`, `summarizeThroughput`.

### Sandbox and runtime

- [Sandbox](docs/architecture/sandbox.md): per-task containers, auth volumes, the base image,
  image builds per tag. `sandbox-core-image.ts`, `handleBuildSandboxImageJob`.
- [Secret and git-data masking](docs/architecture/sandbox-masking.md): secrets and `.git` masked
  in the sandbox, hardened host git. `secret-mask.ts`, `gitfile-mask.ts`.
- [Per-call agent isolation](docs/architecture/agent-isolation.md): empty agent directories and a
  pasted persona. `agentIsolationApplies`.
- [DDEV runtime](docs/architecture/ddev-runtime.md): import checks, framework detection,
  restarts, Playwright, Mailpit. `01c-ddev-env`, `06a-db-migrate`, `07c-ddev-reconcile`.
- [Task browser](docs/architecture/task-browser.md): one browser per task, one tab per agent, the
  window restore. `mcp-surface.ts`.
- [Runtime and agent capacity](docs/architecture/runtime-capacity.md): one RAM budget, the agent
  pool, the holder reserve, priority decay. `agent-reserve.ts`, `priority-decay.ts`.

### Web UI

- [Diff viewer](docs/architecture/diff-viewer.md): text highlights, change maps and pane scrolling.
  `CommitDiffViewer`, `buildDiffRows`, `buildChangeMarkers`.
- [Markdown rendering](docs/architecture/markdown-rendering.md): one renderer, images as links,
  the CSP, mermaid, line breaks, option labels. `markdown.ts`, `mermaid-loader.ts`.

### Onboarding and repositories

- [Committed secret sweep](docs/architecture/secret-sweep.md): tracked credential discovery,
  dependency/build scope and incomplete coverage. `07_7-secret-sweep`, `_credential-scan.ts`.
- [Onboarding completion](docs/architecture/onboarding-completion.md): when a repository counts
  as onboarded. `onboarding-state.ts`.
- [Onboarding reset](docs/architecture/onboarding-reset.md): what a reset takes back, claims,
  quarantine, the root claim. `resetOnboardingArtifacts`, `acquireRootClaim`.
- [MCP server consent](docs/architecture/mcp-consent.md): MCP server lists committed by another
  install. `importHaiveDataMirror`.
- [Repository refresh](docs/architecture/repository-refresh.md): fast-forward, never delete.
  `repo/refresh.ts`.
- [Onboarding template versioning](docs/architecture/onboarding-upgrades.md): the manifest, what
  to bump, upgrade apply and rollback, RTK off. `template-manifest.ts`, `_agent-templates.ts`,
  `02-upgrade-apply`.

### Releases

- [Cutting a release](docs/architecture/release.md): the tag is the release, images,
  `release.json`. `release.yml`.

## Review guidelines

The rules a change is reviewed against live in the topic files indexed above as well as in this
file. When reviewing, open the topic file of every area the diff touches, review the change
against it, and cite the topic file's line when a change breaks one of its rules.
