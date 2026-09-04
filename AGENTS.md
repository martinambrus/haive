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

### Step summaries

The "What the agent did" panel (`task_steps.summary`) has two producers, and the cheap one wins. `resolveCuratedSummary` (`_step-summary.ts`) lifts `findingsSummary`/`summary`/`notes` straight off the apply output for the steps that emit one — no LLM, and it mirrors its own task-ledger entry. Only when the output carries none of those keys does `maybeEnqueueStepSummary` (`step-runner.ts`) spend a CLI call, and that pass is best-effort throughout: a missing provider, a `skip` dispatch, an empty agent text or a failure all leave `summary` null and never touch the step machine.

**The invocation is unlinked but attributed.** `task_step_id` stays NULL — that column is what places a row in the step terminal, the retry blocker, park folding, the step's invocation count and the `cli_invocations_one_live_per_step_idx` partial unique index, and a recap written after the step finished is none of those. `summary_for_step_id` carries the SPEND home instead, so `enrichStepsWithCliStats` folds it into the step's token/cost badge by `coalesce(task_step_id, summary_for_step_id)` while both COUNTERS stay on `task_step_id`. `sumTaskTokens` and `sumTaskProviderBreakdown` accept `task_step_id IS NOT NULL OR summary_for_step_id IS NOT NULL` — deliberately not "no filter", because a summary row written before that column existed carries neither and must stay out of both sides, which keeps a task's list total equal to the sum of its per-step badges on old tasks with no backfill. Cost resolution needed no change: `resolveInvocationCost` already runs before the `step_summary` branch returns.

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

## Plan canvas

`plan_nodes` and friends (`packages/database/src/schema/plan.ts`, migrations 0130/0131) are the durable, per-repo tree of what a project is MEANT to be — the intentional counterpart to the KB, which only describes how the code currently is. One plan per repo, enforced by a partial unique index on the root node rather than a `plans` table. A repo with no remote and no local tree is a first-class `source: 'blank'` repository: the repo-queue INIT job creates the storage dir, `git init`s it and lands one commit, so worktrees, task attachments and the `.haive-data/` mirror all work on a project that does not exist yet.

**One writer.** Every write — LLM turn, UI edit, markdown import — goes through `applyPlanPatch` in `@haive/shared/plan` (NOT the worker: the api writes plans too and cannot import the worker; `global-kb/task-context.ts` is the precedent for a shared package taking an injected `db`). It owns the materialised ancestry (`path`, self-inclusive and slash-terminated so one `LIKE 'prefix%'` selects a subtree), the `version` optimistic-concurrency check (a stale `expectedVersion` is a 409 the UI must SHOW, never a silent refetch), and subtree moves, which rewrite every descendant in one prefix-substitution UPDATE. The SQL offset must be cast — `substring(path from $n::int)` — because an untyped bind resolves to Postgres' POSIX-REGEX `substring(text, text)` overload and returns NULL. `importPlanMirror` is the ONE deliberate bypass: a mirror restore recreates nodes with their original ids verbatim (the spec writer and plan.md quote those ids), which the patch contract deliberately cannot express; it runs only when the repo has zero plan rows and refuses whole rather than half-import when the ids collide.

**Plan task types are not in `workflowTypeSchema`.** That zod enum is the create-task REQUEST validator; `plan_build` / `plan_chat` / `advisory` need a node id the generic form has no field for, so they are spawned by their own endpoints (`POST /repositories/:id/plan/...`) — the same arrangement `kb_author` already has. They live in the DB enum and in web's local `WorkflowType` union only.

**Completion greens the node** from the worker's `markTaskCompleted` (the only completion write; cancel and fail have their own functions, which is the point). Only `todo`/`in_progress` advance — `blocked_human` and `not_applicable` are verdicts a person entered, and a task finishing is weaker evidence than that. Status roll-up is DERIVED at read time (`rollUpStatus` in shared, one source for every view) and never stored: a `blocked_human` descendant makes every ancestor render blocked; green requires every descendant `done` or `not_applicable` — `not_applicable` must not prevent green, but must never render green itself either.

**Two triggers, one builder.** `createPlanBuildStep` (steps/plan/01-plan-build.ts) serves both the standalone `plan_build` task and the onboarding wrapper `10_8-plan-build` (index 14.5, after the KB and RAG exist, before the mirror is staged), because `onboarding_upgrade` reconciles template artifacts only and never re-runs onboarding steps — an already-onboarded repo can reach the builder no other way. The build is LEVEL-BY-LEVEL (wave 0 drafts root + level 1 via `selectAgents`; each later wave is thrown from apply() as a `MiningWaveError`, one agent per frontier node) because one pass cannot emit 400 nodes without truncating. Do NOT move it to `loop`: the runner's loop re-entry calls `resolveLlmPhase`, which asserts `stepDef.llm` exists — a mining-only loop step dies on its second pass with "reading 'prepare'" (measured, on a real repo). The frontier is recomputed from the DB every wave, and excludes `research`/`external` nodes (a blocker waiting on a person is not a system to decompose) and `taskable` leaves; per-wave agent ids (`plan-expand-<nodeId>-p<N>`) double as the asked-set, so a node is never re-asked even though apply passes are independent calls. Because a wave re-runs apply() with the CUMULATIVE result set and temp-ref creation is not idempotent, the fold is over `newAgentMiningResults` — `task_step_agent_minings.consumed_at` (migration 0132) is stamped on every row apply has folded right before the next wave dispatches and cleared on a re-roll; for steps that never throw MiningWaveError the new field equals the cumulative set, so existing steps are unchanged.

**Two modes, and the difference is the node status.** `from_repo` mines the KB and its nodes
arrive `done` because they describe code that exists; `greenfield` takes a written brief plus
any number of attachments and leaves them `todo`. A brief used to ride `from_repo`, which was
not inaccurate prompt copy but a project rendered as already finished. `from_md` (one inline
markdown document) is RETIRED from `planBuildRequestSchema` and deliberately alive in the
worker's `BuildMode`, so stored tasks stay retryable. An unrecognised stored value falls to
`from_repo` — a default rather than a throw, because that is what a revert would also produce.

**Attachments exist before the worker reads them, or the task never starts.** The plan
builder's first step reads the uploads dir and the worker picks a job up immediately, so
`POST /plan/build` with `deferStart` creates the row WITHOUT enqueueing; the client streams
files through the ordinary attachment route and finalizes with the `start` task action, which
claims `status = 'created'` in one atomic UPDATE (a second click matches no row and enqueues
nothing). An upload that fails therefore cannot start anything — the draft is the repair
surface, reachable from its Attachments tab. This replaced the inline-document seed hook,
which could carry exactly one file. `_ATTACHMENTS.md` is now regenerated by
`finalizeAttachment`, the one tail every write path shares: the prompt notice names that file
unconditionally, so a path that skipped it handed the agent a pointer to nothing.

**00-plan-inputs** (index -1, deterministic, no CLI) verifies every attachment row has its
file, refuses a greenfield build with neither a brief nor a file, and writes a readable form
of the kinds no CLI can open — `.docx`/`.xlsx` via `unzip -p` and a small in-repo OOXML reader
(`_plan-inputs.ts`; nothing in the pnpm store parses XML, and OOXML element names are
ISO-29500, so this matches an invariant not someone's formatting), `.pdf` via `pdftotext`.
Sidecars land beside the originals with the api's same chown-to-1000 dance and are indexed by
`_PLAN_INPUTS.md`, which the greenfield prompt names. An extraction that THROWS is reported
per-file and never fails the step — the original is still mounted — while one that yields
nothing is reported as empty, because "unreadable" and "says nothing" are different facts.
`02-plan-coverage` reads that normalised set: it used to read the FIRST attachment as UTF-8
regardless of kind, so a PNG arrived as mojibake whose headings were whatever followed a
newline and a hash. Sections carry their `source`, so a gap names its file and two files'
line 12 stay two gaps.

**What a model must SEE is a hard `vision` requirement; a PDF that has text is a soft
preference.** A model with a learned `modelLimits.vision === false` is told by
`NO_VISION_BOUNDARY_PROMPT` not to open images at all, so handing it a wireframe produces a
confident plan that ignored the input. The dispatcher therefore EXCLUDES such a provider when
`vision` is in the capabilities and fails with a message naming what to change; the capability
rides `AgentMiningDispatch.capabilities` rather than the mining spec, because it depends on
the task's inputs and not on the step. `preferVision` is the soft half — it orders known-blind
providers last without excluding any, for an input that has both a visual and a textual form.

The set is `visualOnlyInputs`: images, PLUS any document that needed extraction and yielded no
text. A wireframe PDF is the second case and is why the split is not simply "images" — it is
large because of its pictures, `pdftotext` returns a handful of labels or nothing, and with no
sidecar to fall back on a blind model has nothing at all. That verdict is `ExtractionResult.
hasContent`, decided from the document's own content and NEVER from the rendered markdown:
this module adds a `---` between pages and a `## Sheet` heading per sheet, so `markdown.trim()`
is non-empty for a document that says nothing. MEASURED — a 31 MiB all-picture PDF extracted to
exactly `---`, was recorded as having text, and the requirement that exists to stop a blind
model planning around it did not fire. `PlanInputRow.hasText` carries it structurally beside
`note`, which is display copy nothing branches on.

`DEFAULT_TASK_ATTACHMENT_MAX_BYTES` is 256 MiB for the same reason: the files this feature
exists for are the large ones, and the upload is STREAMED with the cap as a running byte
count, so it bounds disk rather than memory. Raising a default is inert on an install that
already seeded the old one (`seedDefaults` is `setnx`), so `reconcileRaisedDefaults` lifts a
stored value that is still exactly the previous default, on every boot, idempotently — the
deploy path a config-only change would otherwise not have.

**plan_chat** is one conversation on one card: a self-targeting `reviseLoop` re-parks the form every turn and the user ends it by submitting nothing. The transcript lives in `plan_node_messages` precisely because that revise resets the step row each cycle. The agent is handed the WHOLE plan (via `renderPlanMarkdown`, the same render committed as `.haive-data/plan.md` — one function so what the agent reads and what is committed cannot drift), so a request made while looking at one node can correctly patch another. **advisory** researches a non-code blocker and then STOPS: `02-advisory-decision` parks on a form and only the USER closes it — an agent concluding an unsigned contract is fine would turn a real blocker into a green tick.

**Impact answers "if I change this, what else must change?"** (`shared/plan/impact.ts`): an explicit BFS with a visited set, because the edge graph has cycles by construction and a recursive CTE without dedup would not terminate while one with dedup could not say where it stopped. Both caps are REPORTED, never applied silently. The mermaid source encodes nodes as a `pnode<32 hex>` token; the browser recovers the uuid from THAT, unanchored — mermaid prefixes rendered ids with its own render id, so a `^flowchart-` anchor binds zero handlers and fails silently. **Code links** have one writer (the applier; the builder only links files it actually opened, with `evidence`) and rot is flagged, not guessed away: `11c-rag-reindex` marks links stale for the paths in `tasks.changedPaths`, and only re-assertion by an agent clears the flag — the difference between an impact view that is wrong and one that is merely old.

**Spec-writer integration:** when the repo has a plan, 04-phase-0b is handed a compact component index and must emit an `## Affected components` section naming `node:<uuid>` ids. Its apply parses those IDS — never the agent's prose, because name-matching picks the wrong node the first time two read alike — resolves them through the edge graph, and gate 1 renders the set with a mermaid diagram, stating the traversal cap when one was hit.

The mirror (`worker/src/plan/mirror.ts`) writes `.haive-data/plan.json` + `plan.md` from every plan-step apply and from `12-post-onboarding`; `persistDetection` imports it on clone. `CONFIG_KEYS.PLAN_CANVAS_ENABLED` (admin toggle) off refuses new plan tasks and makes the onboarding step self-skip; existing plans stay readable and editable — hiding a plan someone made reads as data loss. Web: drill-down grid, not a graph engine (`components/plan/`); `plan-status.ts` is the single status→colour source; counts are server-computed. Live-Postgres coverage: `pnpm --filter @haive/worker smoke:plan-canvas` (61 checks).

## Review scope

Every reviewing step (07a, 07b, 08a, 08b, 08c, 08c2, 08d) is scoped by ONE collector,
`collectImplementationFiles` (`_impl-changes.ts`). It unions 07's agent-reported
`filesTouched`, the DAG issues' `filesModified`, and the dirty worktree, caps the list at 100
and REPORTS the cap (`changedFilesBlock`'s COVERAGE notice orders the agent to state what it
was not given) — a silent cap once had a reviewer approve 100 of 150 files as though it had
seen all of them. The list is not a convenience: `worktreeGitfileMask` bind-mounts an empty
file over the worktree's `.git` for every cli-exec invocation, so inside the sandbox there is
no `git status` and no `git diff`, and everything an agent knows about the change has to
arrive in its prompt.

Each path carries the LINES this change wrote (`lines 12-18, 45`, `new file`, `deleted`,
`no line changes (mode or rename only)`). Measured against the MERGE-BASE with the task's base
branch, not HEAD, because the two execution paths commit differently and only the fork point
covers both: single-agent work is still uncommitted at review time (the first commit is
`10-gate-3-commit`), while `dag-executor` commits every issue and merges it in, so a DAG task's
tree is CLEAN by 07b and `git diff HEAD` reports nothing. `git diff <ref>` compares the WORKING
TREE to that ref, so one call covers committed and uncommitted work together. Line numbers come
from the hunk headers' `+` side, which is the file as the agent will read it.

ABSENT is not "unchanged". A path git never saw (an agent-reported file, a diff that could not
be read) carries no note, and both the prompt legend and the scope fence say so explicitly:
the whole file is in scope. Narrowing on a measurement nobody made is the one direction this
must never fail in.

`SCOPE_BOUNDARY` (`_scope-fence.ts`, shared with the on-disk agent templates so the inline
persona and the file that OVERRIDES it cannot drift) is therefore keyed on lines, not files:
in scope = the lines the change wrote, the function or block each sits in — an edit's effect is
not confined to the edited line — plus blast radius (callers of a changed signature, consumers
of a changed schema, paths the change makes newly reachable). It used to be "the files this
change touched", which made a pre-existing defect anywhere in a 5,000-line file a blocking
finding against a three-line edit; MEASURED across 102 runs of one task, ~450 blocking findings
sat on legacy code the task never touched, each costing a capped fix round whose fixer then
REWROTE that legacy code (one worktree: 71 dirty files against a plan of 23). Out-of-scope
findings are never dropped, only re-dispositioned — `## INSIGHTS` for the peer/lens reviewers,
`in_scope: "no"` for security, the markdown report for 07b.

An EMPTY change set fails the step (`assertReviewableChange`), at the prompt-build boundary
rather than in detect() so a replayed `detect_output` is guarded too, and always before
dispatch. It used to render a fallback telling the agent to work the change out from the
workspace — which it cannot, so it guessed, and the verdict it returned covered nothing. A skip
would be worse than a failure: at gate 2 a review with no findings is indistinguishable from an
approval. The two ways to get an empty set are reported as different diagnoses, since
`dirtyWorktreeFiles` no longer swallows its own error — a failed scan names git's message, a
scan that ran and found nothing says the implementation wrote no files.

## Review findings and waivers

`review_findings` is the durable record of what every reviewing step raised — 07b's validator, 08c/08c2, 08d's adversaries. Findings otherwise live only in `task_steps.output`, which a manual retry nulls, so nothing could say whether a reviewer change helped. It is WRITE-ONLY on purpose: `recordReviewFindings` (`_review-findings.ts`) is the only insert and nothing in worker or api SELECTs the table. No behaviour gates on it, which is why every write there is best-effort and never throws — telemetry must not fail the review that produced it.

`disposition` is the verdict on a finding. Every value that is written has exactly one writer:

- `open` — default. Nobody has ruled on it.
- `dismissed_refuted` — 08c's refuter panel disproved it. Written at INSERT, because the insert happens on the final apply() after refutation ran.
- `dismissed_human` — the developer picked a subset at gate 1.5 (`08d2`) and left this one out. Written by `dispositionReviewFindings`.
- `accepted_risk` — the fix loop hit its round cap (or oscillated), and the developer accepted the remainder at the escalation gate. Written by `acceptRemainingReviewFindings` from the queue's gate resolver, which is why that one takes a `db` rather than a `StepContext`.
- `fixed` / `recurred` — declared, SUPERSEDED, and must stay unwritten. Recurrence lives on `recurrence_count` instead (below); `fixed` should never be written at all, because absence of a finding is not evidence it was fixed — a reviewer that was skipped, budget-killed, or simply reworded it produces an identical absence. Do not read `open` as "still outstanding".

Both UPDATE paths are scoped to the CURRENT round and guarded on `disposition = 'open'`. The round scope matters because the same fingerprint recurs on its own row every round, so an unscoped update rewrites the history of rounds the developer never saw — and because with no `fixed` writer, an earlier round's rows are `open` whether they were fixed or recurred. The `open` guard keeps the more specific verdict: a refuter's disproof and a gate-1.5 waiver both outrank a blanket acceptance. Findings raised AFTER the acceptance stay `open` and are NOT swept into it — the developer accepted the remainder they had been shown, not findings nobody had seen yet. That is the normal case, not an edge one: acceptance stands down the FIX loop only, while `restartLoop` (a gate-2 reject) is suppression-immune, so a later round runs and records more. MEASURED on the dev install, every accepted task has findings past its accepted round (accepted 7 / findings to 9, 4 to 5, 5 to 7, 6 to 9). Those surface at gate 2, where the call is the developer's again.

A waiver is CONTEXT, never SUPPRESSION. Nothing reads `dismissed_human` back, and 08d2's detect deliberately does not fold on it. A verdict is about a MOMENT, not about the defect — the reason 08d gives where it carries its disproved set forward, and a human declining to spend a round on something is far weaker evidence than a PoC a verifier actually ran and could not reproduce. What a partial fix round leaves behind instead is a task-ledger entry (`formatWaiverLedgerEntry`) whose wording invites a re-raise and asks what changed; `augmentPromptWithLedger` already carries it into the next round's prompts, so it needs no plumbing of its own. Accept-as-is at gate 1.5 records NOTHING — those findings still surface advisorily at gate 2, so the call is deferred rather than made.

`recurrence_count` records how many EARLIER rounds of the task already saw that reviewer flag that FILE, stamped at insert by `recordReviewFindings` from `loadFindingRecurrence`. A counter beside the verdict rather than a disposition value, for two reasons: recurrence is orthogonal to a ruling (a finding can be both refuted and recurring, and `disposition` holds one value), and both disposition UPDATE paths are guarded on `disposition = 'open'`, so a `recurred` written there would hide exactly the most-repeated findings from a gate-1.5 waiver and from the escalation gate's acceptance. Surfaced two ways: `recurrenceTag` prefixes gate 2's finding lines with `[repeat xN]` plus a one-line legend, and `buildRecurringNote` (08c) hands the next fix round an "Already tried" block, since each round is a fresh `claude -p` and `loadPriorFixContext` dedupes prior diagnoses by prose.

The key is `(reviewerId, normalised path)` — deliberately NOT `fingerprint`. MEASURED across 9,750 findings in 68 multi-round tasks: the fingerprint matches across rounds 5 times (0.05%) because it hashes the issue TEXT and two rounds' descriptions of one defect are different sentences, while (reviewer, path) matches 1,408 of 3,294 (42.7%) and reading the rows confirms those are one complaint re-raised — one across 19 rounds, every row still `open`. The cost of the coarser key is that two DISTINCT defects in one file count as a repeat, which is why every surface says "this reviewer already flagged this file" and never "the same defect". Nothing branches on the count; it informs a human and a prompt.

`fingerprint` is `sha256(reviewerId, path, normalised issue)` — line numbers and ids stripped, path KEPT, since the same defect in two files is two findings. Rows are written PRE-merge, one per adversary that reported a finding, while every later step sees only the survivor of 08d's location merge and has no reviewer id to rebuild a key from. That is why 08d attaches the collapsed set to each surviving finding as `fingerprints[]` (same shape and reason as 08c's `RefutableFinding.fingerprints`), on the OUTPUT copy only so the merge's own objects and `raw` stay untouched.

## Model pricing and spend

`cli_invocations.cost` records what a run COST, decided at completion beside `token_usage` and `model_identity` and then immutable. Distinct from `token_usage.costUsd`, which keeps its old meaning (what the CLI itself reported). The split exists because the reported number is real only where the CLI prices its own backend: the claude binary applies ANTHROPIC's table to every backend, so for zai/muse/openrouter/ollama it is fiction, and codex/gemini report no cost at all. MEASURED before the feature: of ~12,800 USD reported across 12,438 invocations, 31.68 USD was the only amount the product could count as real.

Precedence per invocation (`resolveCostDecision`): manual rate > CLI-reported where `costBasis` is `metered` > computed from a synced rate. Subscription auth short-circuits to non-billable regardless — a flat plan's per-token dollars are notional. `resolveCostBasis` demotes BOTH per-token bases under subscription auth, `metered` AND `estimate`, so a claude-binary wrapper on a flat plan (a GLM coding plan) is non-billable too; its counterfactual is then computed from Haive's own feed rate, never from the binary's Anthropic-table total, and an unpriced model there is `none` rather than fiction. `billable` is decided at WRITE time, where provider, auth mode, model and price source are all in hand, so reads honor a flag instead of re-deriving the rule (it had been duplicated across three SQL filters). A partial computation is recorded `source: 'none'`, never as a cost: a total missing one bucket looks like money and is not.

`ollama` is the one provider whose basis is per-MODEL rather than per-CLI, so `resolveCostBasis` takes an optional model key. One catalog entry covers the local daemon and Ollama Cloud alike, and the catalog says `local` because that is what `ollama` used to mean; a `-cloud`/`:cloud` model runs on ollama.com under a plan that is plan-included up to a limit and metered beyond it, which is neither free nor per-token-billed, so it resolves `subscription` (non-billable, priced only as the counterfactual). Keyed on the model TAG via `isOllamaCloudModel`, the same test the base-URL routing and the boot provisioner already use — NOT on the base URL, which a cloud provider row does not set at all because the local daemon proxies cloud models. Both tag forms matter: the common one is `<size>-cloud`, and every zero-rate cloud row the LiteLLM feed carried wore it, so a `:cloud`-only check would have missed all of them. A caller with no model in hand (the per-provider usage rollup groups by provider, not by model) keeps the catalog answer.

The non-billable half is not discarded, it is the SUBSCRIPTION COUNTERFACTUAL: `notionalCostUsdSql` (api `routes/tasks/_helpers.ts`) sums what those same tokens would have cost at list API rates, rendered grey and labelled on the task's provider card, never added to real spend. Two halves, each the exact complement of the real-spend rule: snapshot rows flagged non-billable minus `source: 'none'` (whose 0 means unpriced, not free), plus legacy `cost IS NULL` rows from a METERED provider on subscription auth. The claude-binary wrappers are excluded from the legacy half because their reported total is Anthropic-table fiction in either direction (5,968 USD of it against local ollama tokens), and codex/gemini report no cost at all, so both contribute 0 rather than a guess. MEASURED on the dev install: 29.63 USD real against 3,236 USD notional.

Rates live in `cli_model_prices`, effective-dated and append-only. A sync CLOSES the live row and inserts a replacement ONLY when a rate actually moved, so an unchanged 12-hourly tick writes nothing (verified: `inserted 0, closed 0, unchanged 651`). Three feeds, refreshed by the existing `REFRESH_VERSIONS` job (`cli-versions/model-prices.ts`), sequentially after `refreshOpenRouterModels` because it reads that cache rather than re-fetching 4 MB:

- **LiteLLM** `model_prices_and_context_window.json` for direct-vendor rates. The feed publishes one entry per (host, model), so `PROVIDER_LITELLM_VENDORS` maps each Haive provider to the vendors that ARE its backend and everything else is rejected — `azure_ai/claude-opus-5` and `vertex_ai/claude-opus-5` are different rows at different prices, and `azure/us/gpt-5.6-sol` really is 10% over list. MEASURED 2026-08-18: anthropic 26 chat models, openai 90, gemini 50 + vertex_ai-language-models 29, xai 44, zai 13, meta 3. `ollama` is deliberately NOT mapped here: all 21 of its rows are priced 0, which is the truth for a local model and a LIE for the four CLOUD models the feed also carries under that vendor (`deepseek-v3.1:671b-cloud`, `gpt-oss:20b-cloud`, `gpt-oss:120b-cloud`, `qwen3-coder:480b-cloud`). A stored 0 is not "unpriced", it is a PRICE — it makes an invocation record a real $0.00 — so those rows were retired by migration 0126 and the vendor mapping dropped.
- **OpenRouter** `/api/v1/models` for the gateway's OWN resale rates, provider-scoped to `openrouter` and never priced from a vendor rate — it bills its margin at the routed model's price, wrong by a different factor per model.
- **Ollama** the model pages themselves (`cli-versions/ollama-model-prices.ts` fetching, `cli-providers/ollama-pricing.ts` parsing), because Ollama publishes no price document and no pricing API — `ollama.com/pricing` lists plans and difficulty grades, not rates. Bounded to CONFIGURED CLOUD models, one page each per tick, never the whole library; cloud-only is a GUARD, since a stored rate on a `local`-basis run would be summed as real spend. MEASURED 2026-08-23 across the 10 configured cloud models: 1 (`kimi-k3`, $3.00 input / $0.30 cached / $15.00 output per 1M) publishes a cost block and 9 do not. Absence is a RESULT, not a failure — it is the common path and must never log an error or every tick cries wolf. A block that EXISTS and cannot be read fails loud and writes nothing. Amounts are paired with the label that follows them, never by position (an automated read of that page during diagnosis returned input $0.30 / cached $3.00, the two swapped), and `cached <= input` is asserted because a violation means the pairing is wrong. Selectors live in ONE constant marked volatile — this is HTML, it will reword.

Lookup is EXACT on a normalized model key (trim + lowercase, nothing else), deliberately NOT the longest-substring matcher `resolveContextWindow` uses: a wrong context window skews a cosmetic percentage, a wrong price is wrong money, and `claude` alone matches both opus and haiku (~15x apart). Variant markers are kept verbatim (`glm-5.3[1m]`, `deepseek-v4-pro:cloud`) because a context or hosting variant is usually its own SKU. An unmatched id is UNPRICED, never guessed — which is why the manual-override path is load-bearing rather than a nicety (`glm-5.3` is in no feed).

One arithmetic trap: Anthropic-shaped usage reports `input_tokens` EXCLUSIVE of the cache buckets, while codex and gemini report it INCLUSIVE of the cached prefix (`INPUT_INCLUDES_CACHE_PROVIDERS`). Pricing those two without subtracting charges cached tokens at the full input rate. Separately, cache-WRITE rates are frequently absent from the feeds, which costs nothing in practice: MEASURED, only claude-code (which uses its reported cost anyway) and amp (subscription) ever report cache-creation tokens — 0 across 6,204 invocations for every other provider.

Admin control is two-level and BOTH are enforced at lookup, not only at sync, so a change takes effect on the next invocation rather than at the next refresh: `CONFIG_KEYS.PRICING_AUTO_UPDATE_ENABLED` is the global kill-switch, and `cli_pricing_sync.auto_update_enabled` per CLI means "this provider's rates are admin-owned" — its feed rows are ignored and only manual rates apply. Manual rates are effective-dated the same way (a write closes the previous one), and retiring one closes it rather than deleting, since the rows that priced past invocations must stay readable. Admin UI: a card on `/admin` for the global switch plus display currency, and `/admin/pricing` for per-CLI toggles, the rate table and overrides.

Costs are stored canonically in USD. `fx_rates` holds daily ECB USD-per-unit rates and a task converts at the rate effective on ITS OWN date (`resolveCostDisplay`), so re-rendering a finished task yields the same figure; dated on the task rather than per invocation because FX drift within one task is far below the displayed precision. ECB publishes only the current day, so past rows cannot be re-fetched — do not truncate that table. A task older than FX collection converts at the earliest rate on record and is flagged `approximate`.

## Sandbox

`packages/worker/src/sandbox/clawker-client.ts` wraps the clawker binary. The worker container mounts `/var/run/docker.sock` and uses Docker-in-Docker to spawn per-task containers. Only the cloned repository is bind-mounted into the per-task container. The worker filesystem and the user home directory are never exposed. CLI authentication files are copied into a named volume per task at startup and the volume is destroyed at task end.

Secret-file masking (default on, Tier 1): before each cli-exec invocation the worker hides files matching a secret deny-list from the AI CLI agent by bind-mounting empty read-only files over them inside the cli-exec sandbox (`packages/worker/src/queues/cli-exec/secret-mask.ts`, threaded via `resolveSecretMasks` in `exec-core.ts` for the `cli`/`agent_mining`/sub-agent kinds). The effective set is `DEFAULT_SECRET_DENY_GLOBS` (in `@haive/shared`) plus per-repo `secret_mask_deny_extend`, minus `DEFAULT_SECRET_CARVEOUTS` and per-repo `secret_mask_allow`. Untracked files only (`git ls-files` filter) — committed secrets are out of scope FOR MASKING, and are instead REPORTED once per repo by the `07_7-secret-sweep` onboarding step (which is why they are two features and not one: masking stops an agent reading a secret, the sweep tells the human one is already in their history). The tracked filter asks each linked worktree about its own paths, because `git ls-files` reports paths relative to the tree it runs in, so the repo root never lists `.haive/worktrees/<name>/x`. The app runtime (app-runner/ddev mount the same `haive_repos` subpath without masks) still sees the real files. Per-repo controls live on the tooling settings page (`secret_mask_enabled`/`secret_mask_allow`/`secret_mask_deny_extend`); `CONFIG_KEYS.SECRET_MASK_ENABLED` is the global kill-switch.

Masking fails closed. A scan that throws, a scan root that is not a readable directory, a match count over `SECRET_MASK_LIMIT`, or a task/repository row that cannot be resolved raises `SecretMaskError` instead of masking a partial set — a subset leaves the remainder readable, which is the one outcome the deny-list exists to prevent. "Masking is off" and "no secrets found" are only ever concluded from evidence that says so: the kill-switch, `secret_mask_enabled`, or a task with no repository (which mounts no tree). The repo root mirrors `resolveTaskRepoMount` exactly, so a repo with no `storage_path` is scanned at its named-volume subpath rather than skipped, and the root is `stat`ed before the scan — glob answers `[]` for a root that does not exist, which is byte-identical to a clean repo, while the sandbox mount binds the real tree regardless of what the worker can see. `handleCliExecJob` records it on the invocation (exit -1) and fails the step. The escape hatches are the repo's `secret_mask_allow` globs and the masking toggles; disabling masking skips the scan and never raises.

Worktree gitfile masking (always on): every agent prompt states that git is unavailable inside the sandbox and that the host stages and commits (`10-gate-3-commit`, `completeMergeHostSide`). That invariant is enforced, not incidental — `worktreeGitfileMask` (`packages/worker/src/queues/cli-exec/gitfile-mask.ts`) bind-mounts an empty read-only file over the worktree's `.git` gitfile for every cli-exec invocation. Without it an agent can repoint the gitfile at the container path (`printf 'gitdir: /haive/workdir/.git/worktrees/<name>' > .git`), which both grants itself a working git behind the commit gate and leaves host-side git fatally broken for every later step. It rides the same `SandboxExtraFile` mechanism as secret masking but is an integrity control, so `SECRET_MASK_ENABLED` never disables it. Never masked at the repo root (there `.git` is a directory), and never applied to the terminal, IDE, app-runner or ddev containers, whose git must keep working. `removeWorktreeDir` runs `git worktree repair` before removal so worktrees poisoned before this existed still clean up.

One browser per task, one TAB per agent. Every sandboxed CLI of a task gets the same `--browser-url` (`resolvers.ts` probes the runner once per invocation), and chrome-devtools-mcp selects `pages[0]` on connect — so N concurrent agents drive ONE tab unless told otherwise. They are told otherwise by `BROWSER_TAB_DISCIPLINE` (`sandbox/mcp-surface.ts`), which rides the MCP surface block and therefore reaches every browser-capable dispatch: llm, mining (`08d-adversarial-qa`, the only fan-out keeping the full surface) and `dag_parallel` coders. `isolatedContext` is banned there rather than unmentioned — it is the obvious-looking way to isolate and it starts a fresh cookie jar, discarding the one deterministic app login `_app-auth.ts` performs per task. Tab 0 is the human's view: `browser-probe-connect.js` and `browser-login.js` both reuse `pages[0]` and bring it to front. A per-agent headless browser is NOT the alternative — it cannot reach a `*.ddev.site` or app-runner URL from the cli-exec sandbox, and carries no login. Agents killed before their `close_page` are swept by `closeExtraBrowserTabs` (`browser-close-extra-tabs.js`) at the mining and DAG barriers ONLY, never at browser bring-up, which runs while a human may have tabs open. The tab it keeps is the one RECORDED as the human's (`browser-human-tab.js`, written by `browser-probe-connect.js`/`browser-login.js` at the moment they `bringToFront()` a tab, read back as a CDP `Target.getTargetInfo` id), never inferred from the tabs. Three inference attempts have been MEASURED lying: `browser.pages()` is not creation order (two probes minutes apart put the newest tab at index 0 and then the oldest, so an early keep-`pages[0]` version closed the app tab the human was watching), `/json/list` is a third order again, and `document.visibilityState` — which replaced them — reported `visible` for BOTH tabs of a two-tab window (identical `windowId` and bounds), along with `document.hidden` false, `hasFocus()` true, animation frames and screencast frames, so the sweep failed safe and closed nothing on exactly the runners that leak. No record, an unreadable one, or a recorded tab that is no longer open still closes NOTHING; a leaked tab costs memory, closing the wrong one costs work. The launch script also restores puppeteer's three anti-backgrounding switches, since with a tab per agent all but one are always in the background — the likeliest reason no page-side signal separates them any more.

The same barrier RESTORES THE WINDOW, and Gate 2's bring-up does it again before the human looks (`browser-restore-window.js`, `restoreRunnerBrowserWindow`/`restoreAppRunnerBrowserWindow`). `resize_page` is not viewport emulation: MEASURED in the shipped chrome-devtools-mcp 1.7.0 bundle it un-maximizes the OS window and then sets its bounds so the CONTENT matches, so 08a's deterministic 1280x800 outlives the MCP session — three live runners were sitting at 1280x887 on a 1920x1080 screen. The agents cannot undo it and are not asked to: `resize_page` takes a CONTENT size and there is no window-state tool, so the screen size overshoots the display, and one window serves every agent's tab, so a per-agent restore would resize a sibling mid-screenshot. Restore target is the screen read from the page, NOT the 1920x1080 literal in `start-browser-desktop.sh` and not the launch geometry (Chrome offsets that by 10,10, which would hang 20px off two edges). Chrome settles at 1919x1079 for a 1920x1080 request, so the skip test asks whether the window COVERS the screen rather than matching it, or every barrier would rewrite identical bounds.

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
restart or rebuild is necessary. A check with no repository wrapper runs inside the matching
existing service container — `docker exec` is fine for diagnostics and tests, but never to
install dependencies or rebuild runtime artifacts. Before restarting or rebuilding the
worker, inspect active tasks: recreating it can interrupt live CLI terminals and
in-progress task steps.

## Conventions

- All modules are `"type": "module"`. Use `.js` extensions in import paths even for TypeScript sources because of `NodeNext` module resolution.
- Zod is used for both validation and for generating `FormSchema` field metadata where possible.
- Logger is `pino` from `@haive/shared/logger`. Never `console.log` from server code.
- Secrets are stored via envelope encryption: per-user DEK encrypts the secret, master KEK from `CONFIG_ENCRYPTION_KEY` encrypts the DEK. AES-256-GCM throughout.
- Drizzle schema lives in `packages/database/src/schema/`. Migrations in `packages/database/src/migrations/` are generated via `drizzle-kit generate` and applied via `drizzle-kit push`.
- Hono routes group by domain in `packages/api/src/routes/`. Auth middleware mounts globally.
- Forms are described by `FormSchema` from `@haive/shared` and rendered by `FormRenderer` in `@haive/web`. Do not write step-specific React components.
- EVERY prose body renders through `MarkdownView` / `.haive-md` (`packages/web/src/components/markdown/`). There is no plain-text branch. `looksLikeMarkdown` still exists but decides ONE thing — the LINE-BREAK POLICY, not the style: a markdown body gets `remarkGfm` alone so a model's ~80-col hard wraps reflow, a plain body also gets `remarkSoftBreaks` so its newlines survive as `<br>`. Do NOT re-promote it to a renderer switch. It used to be one, and identical prose then jumped between mono-12px `<pre>` and sans-14px `.haive-md` on nothing more specific than whether it happened to contain one backtick. `remark-soft-breaks.ts` is a deliberate local stand-in for `remark-breaks`, not an oversight: the dep is not in the pnpm store and adding one costs a full stack rebuild. A body nested INSIDE another styled block (form/field/option descriptions, note fields) uses `InlineMarkdown`, which takes its size and colour from a WRAPPER element via `.haive-md-inherit` — putting those classes on MarkdownView's own element does not work, because `font-size: inherit` resolves against the parent, so a `text-xs` there would be what it inherits FROM rather than what it applies. Inline code under that modifier is sized as a RATIO of the body (`0.9285em` = 0.8125/0.875), never the absolute rem the plain rule uses, with `pre code` reset to `inherit` so the same selector does not scale it twice. `globals.css` is outside the repo's prettier glob (`ts,tsx,js,jsx,json,md`) and is hand-formatted compactly — running `prettier --write` on it produces ~150 lines of unrelated churn.
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
- Concurrent per-task runtimes (DDEV/app runners) and CLI agents share ONE machine-aware RAM budget (`total - ~30% reserve`), not a fixed count. Two distinct numbers: the Docker `--memory`/CPU/pid **cap** each container runs under (a generous ceiling, swap disabled) and the **planning weight** admission budgets it at. Dividing the budget by the ceiling is what used to price a ~300 MB app-runner like a DDEV DinD. Weights are CALIBRATED absolutes, not fractions of the cap (a project's runner uses the same RAM on a 16 GB host as on a 64 GB one), measured from 1731 `docker stats` samples over 4 DDEV runners and 52 agent sandboxes: `ddevWeightMb` 1536 (peak 1036 incl. a full cold boot), `browserWeightMb` +1536 surcharge charged WHILE THE DESKTOP IS UP (browser-phase peak 2505), `agentWeightMb` 2048 (peak 1736), `appWeightMb` 1024 (the one unmeasured weight — strictly less machinery than a DDEV base). Each is clamped to the container cap, since a runner cannot occupy more than `--memory`. A cold `ddev start` is NOT the peak (image pulls are disk-bound); the peak is agent work during a verify/fix round, which is also when the browser desktop is up — so the browser flag is a proxy for that phase, not the cause. That surcharge is LIFECYCLE-SCOPED, not stamped into the weight label at container create: the desktop first starts at 07, so a task charged for it from `01c` paid for a Chromium that did not exist for hours — MEASURED, two of three live DDEV runners had zero Xvfb/x11vnc/chrome processes while each was charged 1536 MB for one, which is what parked other tasks against a budget nothing was spending. Labels are immutable after create, so the live half is a Redis SET of runner CONTAINER NAMES (`markBrowserDesktopUp`/`Down`, called inside `startBrowserDesktop`/`stopBrowserDesktop` so every step inherits it) folded into occupancy by `parseRunnerWeights`. It is clamped to the kind's class weight plus the surcharge, which is what stops a runner created BEFORE the move — whose label already contains it — being charged twice, while leaving a per-task `memoryLimitMb` pin (already above that cap) alone. Applied only to containers the same `docker ps` returned, so a stale entry is inert and no TTL or sweep exists. Agents take what the runtime pool leaves free, never below `agentFloor` (a runtime holder needs an agent to finish, so zero agents deadlocks) — but that subtraction is a difference of two peak-calibrated estimates and is wrong in BOTH directions at once, so `AGENT_POOL_MEASURED_ENABLED` (default on) lets the host's own `MemAvailable` answer instead. MEASURED: three DDEV runners charged 9216 MB were occupying 2551, flooring the pool at 2 while 7.9 GB sat free, and the dev base stack meanwhile overran its 30% reserve — a term the planned figure cannot see at all. `readHostAvailableMb` reads MemAvailable, NOT `os.freemem()` (that is MemFree: 750 MB against 7.9 GB available, which would zero the term), and prefers a cgroup limit when one is set below host total because `/proc/meminfo` reports the HOST inside a capped container. `agentWeightMb` stays the divisor — being coarse (19% of a 16 GB budget) is exactly why the planned quantisation could not express the difference. Only the RESERVATIONS half of runtime occupancy is subtracted from the measurement; a live runner's RSS is already missing from it. Growth BEYOND the planned figure is capped at `DEFAULT_AGENT_RAMP_STEP` (2) per 30s evaluation, each step re-measured with the previous one resident, so an illusory headroom stops itself; the plan's own width still opens at once (an idle host was never broken) and shrinking is never ramped, since a lower cap only stops NEW jobs. `AGENT_POOL_SAFETY_MB` (0 = a fifth of the host, clamped 2048..4096) is what the ramp holds back for the base stack's growth and for agents climbing from ~450 MB toward their 1736 MB peak; raise it if the host swaps as the pool ramps. Admin-tunable: RESOURCE_LIMITS_ENABLED / RUNTIME_MEMORY_MB / RUNTIME_CPUS / MAX_CONCURRENT_RUNTIMES=0 means no count cap / RUNTIME_DDEV_WEIGHT_MB / RUNTIME_APP_WEIGHT_MB / RUNTIME_BROWSER_WEIGHT_MB / AGENT_WEIGHT_MB / AGENT_FLOOR / AGENT_POOL_MEASURED_ENABLED / AGENT_POOL_SAFETY_MB / MAX_PARALLEL_AGENTS=0 means auto (a positive pin still short-circuits everything, measurement included) / RUNTIME_IDLE_REAP_MINUTES. On a DEV host the binding constraint is usually the base stack, not the weights: `next dev` alone holds ~1.6 GB and Ollama ~1 GB against the 30% reserve, so pin MAX_CONCURRENT_RUNTIMES or cap the dev web server's heap rather than raising weights. A step is gated only if it will actually spawn a runner (`needsRuntime: 'ddev' | 'app' | 'if-serving'`; `'if-serving'` resolves through `classifyRuntime`, so a code-only task never queues for a pool it does not use). A reaper reclaims leaked runners. See packages/worker/src/sandbox/{runtime-caps,runtime-admission,runtime-runner-reaper}.ts and `deriveRuntimeCaps`/`deriveAgentConcurrency` in @haive/shared.
- Runtime occupancy sizing the agent pool is only half the story: WHO gets those few slots matters too. A task holding NO live runtime runner yields its cli-exec slot to one that does (`enforceRuntimeHolderReserve`, `queues/cli-exec/agent-reserve.ts`), because a runner-holder's idle time is billed in committed RAM it can only release by FINISHING — while a runner-less task's slot is fungible. Observed without it: 3 tasks each holding a 3072 MB DDEV, two idle, an onboarding task holding one of the only 2 agent slots, and 4 more tasks parked behind capacity that could not free. Enforced at job PICKUP (a third sibling to `enforcePauseGate`/`enforceTaskAgentCap`, same `moveToDelayed` + `DelayedError`), never at enqueue — BullMQ freezes priority at `queue.add` while runner-holding is state that changes. Keyed on the docker-label invariant "holds a live runner", NOT on `tasks.type`, so a future runner-less task type inherits it. Demand is counted from the BullMQ WAITING list, not from queued `cli_invocations` rows: a DB count includes jobs that are delayed (paused task, per-task cap) and yielding to those idles the slot. Not preemption — a running agent keeps its slot. The one thing that outranks the reserve is an EXPLICIT vote: a runner-less task whose `tasks.vote_score` is STRICTLY above every holder's skips the yield (`voteScore`/`maxHolderVoteScore` on `agentReserveDecision`; both read live at pickup, never carried on the job, for the same reason the gate itself is at pickup). Strictly, because a tie states no preference and there the committed-RAM argument still decides — and at the default score 0 everywhere the term is inert, so an install where nobody votes behaves as it did before. A vote is the operator saying what to run first; holding a runner is this module inferring it from RAM, and the statement beats the inference. Without it a vote re-priced only the QUEUE while this gate handed the slot away anyway: MEASURED, +1 onboarding invocations sat 12.6/14.1/21.9 min behind unvoted DDEV holders that were at the head-adjacent bands. Admin-tunable: AGENT_RESERVE_ENABLED (off = first-come) / AGENT_RESERVE_MAX_HOLD_MINUTES (0 = strict, else release a held invocation after N minutes so runner-less work slows rather than stops; default 3, not 10, because the hold is only half the wait — a released job then waits for a slot to free, a term invisible in the knob).
- Queued cli-exec priority is `band = VOTE_BASE + rank - vote_score`, and BullMQ FREEZES it at `queue.add`. `rank` (the task's in-flight agent count) is therefore a SNAPSHOT, which turned a drained fan-out into a permanent sentence: MEASURED, an idle +1 task sat at band 9 (rank 5, from an `09_5` mining fan-out long since finished) behind a neutral task at band 6 that had two agents RUNNING, and led the queue on nothing but enqueue order. A vote cannot correct that on its own — it moves at most 5 bands and a 5-wide fan-out moves 4. `CliPriorityDecaySweeper` (`queues/cli-exec/priority-decay.ts`, 30s) rebuilds the band from live load: for `r` STARTED agents and `k` queued jobs in their current order the ranks are `r+1 .. r+k`, i.e. exactly what an incremental enqueue would produce right now — so the round-robin across tasks is preserved while the fan-out penalty decays. Order INSIDE a task never changes, and a settled queue produces zero writes. A sweeper rather than a hook on invocation-end because the count also drops on paths that never run that code (orphan sweep, preemption, cancel). It has no switch of its own: with `FAIR_SCHEDULING_ENABLED` off, jobs carry priority 0 and every one is skipped.
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

Out of scope of onboarding-upgrades: `.claude/skills/` and agents written from LLM discovery (06_5) without a bundle source, `.haive-data/knowledge_base/`, `.claude/mcp_settings.json`, `.claude/onboarding-review.md`. **Skills and agents installed from custom bundles are tracked and upgradable** (each bundle item lands as an `onboarding_artifacts` row with `templateId = "custom.<bundleId>.<itemId>"`; the `bundle_resync` step before `01-upgrade-plan` refreshes git bundles and the upgrade-plan/apply path treats `custom.*` rows the same as Haive templates). LLM-generated skills and KB content are refreshed by the `/workflow` code-change phase. Project knowledge lives under `.haive-data/` — `knowledge_base/` and `learnings/` — not under a vendor dir, because Haive is model-agnostic; the canonical paths are `KB_DIR`/`LEARNINGS_DIR` in `packages/shared/src/knowledge-paths.ts`, and `stripManagedKnowledgeGlobs` makes them impossible to scope-exclude from the folder pickers (06_7/09_7, the api exclusions endpoint, and the repos-page editor). `mcp_settings.json` is user-owned — created on first onboarding, never rewritten. The review file is one-shot; each upgrade writes a new `.claude/upgrade-reviews/<task_id>.md`.
