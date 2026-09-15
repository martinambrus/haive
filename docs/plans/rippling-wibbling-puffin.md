# Modular (user-definable) task types

> **Not started** — none of `schema/task-types.ts`, `routes/task-types.ts`,
> `task-type-manifest.ts`, `composable-catalog.ts`, `routes/custom-mcp.ts` or the admin
> task-types page exists (re-verified 2026-08-21).
>
> **Two files describe this feature and neither supersedes the other.** This one is the whole
> design and the locked user decisions.
> `rippling-wibbling-puffin-agent-a233cf7f9b59974f6.md` is a subagent-written **half A** — data
> model, `buildRunList`, pgEnum, migration and seed — grounded line-by-line against the tree at
> the time. Read this one for the design, half A for the migration mechanics and the `findIndex`
> invariant. Half A covers only the first slice; it is not an alternative plan.
>
> Anchor drift shared by both: `buildRunList` is now `task-queue.ts:152` (half A says 112-130)
> and `buildRunAppRunList` is `:186` (says 146-178). Both `execution-paths.ts:98`
> (`PATH_REQUIRED_TARGETS`) and `:133` (`orderWorkflowRunList`) still resolve exactly as cited.
>
> **Depends on `toasty-percolating-kernighan`** for Phase 3.1's agent handling. A prompt-template
> step's `agentPool` and `{{agent:<id>}}` tokens ride that plan's per-invocation agent isolation,
> which ships first and independently.

## Context

Today a task type (onboarding, workflow, run_app, onboarding_upgrade, plus internal kb_author / env_replicate) is hardcoded TypeScript in four duplicated declaration sites (shared union, zod enum, web copy, Postgres pgEnum), and its step list is emergent from statically-imported `StepDefinition` modules bucketed by `metadata.workflowType`. Adding or tuning a task type requires a code change across shared + database + worker + web. The goal is to make task types data-driven: admins author them in an admin UI by composing existing steps plus per-step config, enable/disable them, and — for genuinely bespoke logic — attach an agent prompt template and/or a custom MCP tool that runs inside the existing sandbox. The existing runtime capabilities (agent dispatch, the Docker sandbox envelope, browser testing, DDEV/app-runner, terminal, IDE, verify/QA gates) are already task-type-agnostic and gate on data flags, not `tasks.type`, so they come along for free once the definition layer is data-driven.

This is not greenfield: `run_app` and `kb_author` already prove a task type can be assembled at runtime by reusing other types' steps by id (`buildRunAppRunList`). The precedent is the model.

## User decisions (locked)

1. Authoring is admin-only and global (behind `requireAdmin`). Enable/disable also admin.
2. Built-in types are migrated into the data model too — one uniform system, not custom-alongside-hardcoded. This is the higher-risk choice, so Phase 1 is a two-phase, kill-switch-gated, reversible migration with a boot-time byte-identical proof before cutover.
3. Phase 3 bespoke code = prompt-template steps + an optional custom sandboxed MCP tool. Never in-process worker code (a step's `StepContext` hands raw `db` + `fs` with zero isolation; user code there is unacceptable).

## Architecture at a glance

Two layers. The runtime/execution layer is already generic and untouched. The definition layer becomes data:

- A new `task_type_definitions` table is the single source of truth for which types exist, whether they are enabled/selectable, and (for static types) their ordered step list + per-step config defaults.
- `buildRunList` (packages/worker/src/queues/task-queue.ts:112) dispatches on a `runListStrategy` discriminator instead of a hardcoded switch on `tasks.type`.
- The two runtime-dynamic built-ins keep code-resident assemblers referenced by their row: `workflow` (`workflow_paths` strategy: execution-path filtering + env_replicate prelude) and `run_app` (`run_app_modes` strategy: branches on env-template `containerTool`). Everything else, including all custom types, is `static`: a fixed ordered step-id list.
- Custom types may only be `static` — this keeps the run list deterministic across the forward-walk rebuild (`buildRunList` is re-run every hop and forward-walked `findIndex(stepId)+1`).

Key reuse: the per-step parameter store already exists on the tasks row — `preAnswers` (`Record<stepId,Record<fieldId,value>>`), `stepLoopLimits`, `maxFixRounds`, `autoContinue` (packages/database/src/schema/tasks.ts:196-219). A definition seeds these at task creation; no new parameter engine. The boot-upsert cache pattern already exists — `syncTemplateManifestCache` (packages/worker/src/step-engine/template-manifest.ts:304-343) upserts worker-only metadata into Postgres so api/web read it with zero worker imports; both the definitions seed and the composable-step catalog mirror it exactly.

---

## Foundational: composable-step catalog + safety

Not every registered step is safe to drop into an arbitrary order (09-gate-2-verify-approval reads ~8 sibling outputs; 07b assumes 07 ran; browser/gate steps need a worktree + a runtime first; revise/restart-loop targets are computed at runtime and cannot be statically proven). So expose a curated, prerequisite-annotated subset — not all ~60 registered steps.

- New packages/worker/src/step-engine/composable-catalog.ts exporting `COMPOSABLE_STEPS: ComposableStepEntry[]`: `{ stepId, label, group, dispatchesCli, requires: {needs,reason}[], provides: string[], paramFormSchema?: FormSchema, loopBudgetEditable?, loopTargetStepId? }`.
- `requires`/`provides` are capability tokens (`'worktree'`, `'runtime'`, `'spec'`, `'implementation'`), not raw step ids, so alternatives satisfy a need (both 01-worktree-setup and a run_app planter `provide: ['worktree']`).
- New `composable_step_catalog` table + `syncComposableCatalog(db)` boot-upsert (near-verbatim copy of template-manifest.ts:304-343), called right after `registerAllSteps` in bootstrap.
- Shared pure validator in @haive/shared: walk `stepIds` in order, accumulate `provides`, reject if any step's `needs` is not already provided upstream, and reject a list containing a `fixLoop`/`restartLoop`/`fixLoopOnError` step whose declared loop target is absent. This is the DB-driven analog of the existing boot invariant `assertPathStepSetsClosed` (packages/worker/src/step-engine/steps/index.ts:39). Run it client-side (live composer feedback) and authoritatively at POST/PUT and again at task-create (defense in depth).
- Generalize `PATH_REQUIRED_TARGETS` (packages/worker/src/orchestrator/execution-paths.ts:98-108) into a reusable `STEP_LOOP_TARGETS` map the validator consumes. Steps whose loop target is runtime-computed (revise/restart) are excluded from the composable set.

### Definitions may reference module-contributed steps

Companion to "Module-contributed steps must reach the composable step catalog" in
`serialized-chasing-thacker.md`, so a distributed module
(the deep project analysis scan) can contribute steps a task type is composed from.

The module system exports `./steps` and its loader registers them, but this plan composes task types
from a **curated** `composable_step_catalog` — so without this, a module's steps are registered yet
invisible to the composer and unusable by any task type.

- The catalog is the union of core entries and every loaded module's `composableSteps`, namespaced
  `module.<moduleId>.<stepId>` so a module can never shadow a core step id (its companion rule in
  `serialized-chasing-thacker.md`).
- The prereq validator needs **no special-casing**: it walks `requires`/`provides` capability tokens,
  not step ids, so a module step that `provides: ['worktree']` satisfies a core step's need exactly as
  `01-worktree-setup` does. This is the payoff of the capability-token design already in this plan.
- `buildRunList` resolves module step ids through the same registry, which the module loader has
  populated before the catalog sync runs.

### Dangling references — a module removed under a live definition

Data-driven types plus distributed modules create a failure mode neither has alone: a definition's
ordered step list can reference steps that no longer exist, because the module supplying them was
disabled, removed, or failed to load after a rebuild.

- Validate that every `stepId` resolves at boot **and** at task-create (the existing defence-in-depth
  pattern this plan already applies to prereq validation).
- A definition with an unresolvable step becomes **not selectable, with a named reason** — "requires
  module `deep-analysis`, which is not installed". Never a crash, and never silently dropping the
  missing step, which would run a truncated pipeline the admin never authored and cannot see.
- A persona a prompt-template step names with `{{agent:<id>}}` follows the same never-silent rule,
  but task-create cannot refuse one: agent definitions live per repository, and whether a persona
  resolves depends on the tree the invocation mounts, which `01-worktree-setup` decides only when it
  runs (it picks the base then, and a worktree holds tracked files only). So task-create refuses
  only an id outside the marker grammar. When the worker starts the task (`handleStartTask`, beside
  its `task.running` event, which a task-level retry runs again), that plan's reader checks the
  repository as checked out and records an `agent_persona.unresolved` task event, naming the step
  and the agent, for each persona it cannot use there: no `<id>.md` in any markdown agent directory,
  a symlink, an out-of-tree path, an unparseable file, an empty body, a secret-masked file, or a
  body past the per-prompt `MAX_PERSONA_BODY_BYTES` budget. The warning never blocks the start (a
  check that cannot run logs, records nothing and leaves the decision to dispatch). It runs in the worker because that
  reader and the secret-mask policy are worker code, and sharing one reader keeps the warning and
  the dispatch from disagreeing about anything but the tree. Dispatch is authoritative: a persona it
  cannot use fails the dispatch with a named reason ("step `<slug>` needs agent
  `drupal7-developer`, which this repository does not define"), never an empty persona. Refusing
  earlier would block a persona that exists only on the base the task branches from — a rule strict
  enough to choose must not refuse (`AGENTS.md`). A definition that exists only as
  `.codex/agents/<id>.toml` counts as absent until a TOML reader exists. Built-in steps never hit
  it — their personas always carry an inline fallback.
- Tasks already running are untouched by the step half of this rule: their run list is
  materialised, and `buildRunList` is forward-walked from the current step. That half gates new task
  creation only; the persona half warns at start and decides at every dispatch, as above.

### Spatial composability is these capability tokens — already done, do not "add" it

Cordis's "spatial composability" means a plugin declares what it needs from the environment and the
runtime resolves it reactively: a dependency that disappears makes the plugin "just deactivate and
wait, without erroring," rather than crash. This plan independently arrived at exactly that:

- The `requires`/`provides` capability tokens (`'worktree'`, `'runtime'`, `'spec'`) ARE the
  dependency declaration — a step needs `worktree`, and any step that provides it satisfies the
  need, so alternatives compose without special-casing (the payoff noted just above).
- The dangling-reference rule above IS "deactivate and wait" verbatim: a definition referencing a step that
  no longer resolves (its module was removed) becomes not-selectable WITH A NAMED REASON, never a
  crash and never a silently truncated pipeline.

So no change is needed here — this is recorded only so a future reader does not "add spatial
composability" as if it were missing. It is the design already locked. What Haive deliberately does
NOT take is the reactive RUNTIME rebind (swap a provider under a live task and reload it): a running
task's run list is materialised and forward-walked precisely so a mid-flight definition edit cannot
mutate it, which is the correct choice and the opposite of Cordis's live rebind.

---

## Phase 1 — Data-driven task types (the migrate-built-ins core)

### 1.0 Schema (packages/database/src/schema/task-types.ts, NEW; barrel-export it)

`task_type_definitions`: `slug` varchar PK (this is the value stored in `tasks.type`), `displayName`, `description`, `runListStrategy` pgEnum `('static'|'workflow_paths'|'run_app_modes')`, `stepIds` jsonb `string[]` (static only; null for dynamic), `preAnswerDefaults` jsonb, `stepLoopLimitDefaults` jsonb, `fixLoop` jsonb `{targetStepId, humanRejectSourceStepIds, honoredConstraintSourceStepIds} | null`, `enabled` bool, `selectable` bool (false = internal fragment, e.g. env_replicate), `builtin` bool, `sortOrder` int, `contentHash` varchar(64) (sha256 of resolved stepIds, boot drift check).

Task-side pinning (required for forward-walk safety): add `tasks.run_list_snapshot` jsonb `string[]`. At create, a static type copies `stepIds` into the snapshot; `buildRunList`'s static branch resolves the snapshot, not the live definition — so an admin editing a global definition mid-task cannot mutate a running task. Dynamic strategies need no snapshot (their inputs are already task-pinned via execution_path / env template).

### 1.1 Phase 1a — additive, zero behavior change

- Create the table + strategy enum; add `tasks.run_list_snapshot`. Keep `tasks.type` as the existing pgEnum. Keep the hardcoded `buildRunList` branches active — nothing reads the new table for run-list decisions yet.
- New packages/worker/src/step-engine/task-type-manifest.ts (mirrors template-manifest.ts): builds the six built-in rows and `syncTaskTypeDefinitions(db)` upserts on `slug`, updating only registry-owned fields (strategy, stepIds, contentHash), never clobbering admin-tuned fields, and never deleting (custom rows are user data). Called from bootstrap (packages/worker/src/bootstrap.ts:45, same call site as the template cache).
  - Seed set: onboarding (static), workflow (workflow_paths), onboarding_upgrade (static), kb_author (static), run_app (run_app_modes), env_replicate (static, `selectable=false`). Static `stepIds` = the current `stepRegistry.listByWorkflow(slug)` ids.
- Boot assertion (fail to boot): each seeded static row's `stepIds` is byte-identical to `listByWorkflow(slug)`. This is the proof that the data path reproduces the hardcoded path with zero drift before any cutover.
- Rollback for 1a: unconditional and trivial — nothing reads the table for decisions; redeploy the prior worker, optionally drop the additions.

### 1.2 Phase 1b — cutover (kill-switch gated)

- Rewrite `buildRunList` to dispatch on `runListStrategy` (keep the old bodies as a dead `resolveLegacyRunList` fallback for one release). Control flow:
  - `run_app_modes` -> `buildRunAppRunList(ctx, db)` (unchanged, packages/worker/src/queues/task-queue.ts:146-178).
  - `workflow_paths` -> `orderWorkflowRunList(listByWorkflow('workflow'), listByWorkflow('env_replicate'), ctx.executionPath)` (unchanged body; those two are registry keys, not task slugs, so they stay literal).
  - `static` -> `(ctx.runListSnapshot ?? defStepIds).map(id => stepRegistry.require(id))`.
- `resolveTaskContext` (packages/worker/src/queues/task-queue.ts:180-213) loads the definition by slug (fail loud if missing), drops the `as WorkflowType` cast, and adds `runListStrategy` + `runListSnapshot` to `ResolvedTaskContext`.
- Convert `tasks.type` pgEnum -> text (`USING type::text` mandatory; verify `drizzle-kit push --force` emits an in-place ALTER, not drop+recreate — prefer a hand-written numbered migration if the push plan looks destructive). Keep the `workflow_type` enum type defined but unused for rollback re-cast. This preserves every `eq(tasks.type,'onboarding')` literal filter and `task.type === 'run_app'` branch untouched (the reason text beats a `'custom'` enum member + FK).
- Relax the shape-only type sites: shared `workflowTypeSchema` / `createTaskRequestSchema.type` (packages/shared/src/schemas/tasks.ts:3-8,66) -> `z.string().min(1).max(128)`; shared `WorkflowType` (packages/shared/src/types/index.ts:1) and web copy (packages/web/src/lib/api-client.ts:430) -> a builtin alias plus `string`. Real "is this an enabled, existing type?" validation moves into the api create route as a DB lookup (404 missing / 403 disabled), mirroring its existing per-type precondition checks (packages/api/src/routes/tasks/index.ts:170-193).
- Create-path additions (packages/api/src/routes/tasks/index.ts:154-247): validate the type against the DB, write `run_list_snapshot` for static types, and fold the definition's `preAnswerDefaults` / `stepLoopLimitDefaults` into the task row (seed-then-let-06-run-config-overlay: 06 writes specific per-step keys and will not clobber unrelated seeded keys).
- Kill-switch `CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED` (default false): with 1b deployed but the switch off, the engine runs data-driven for built-ins only (already proven byte-identical) while custom-type creation stays blocked — a wide, fully reversible bake window. Needs the standard admin GET/PUT + toggle card (global-config UI rule). Flipping it on is the deliberate act that opens the irreversible door (see Rollback).

### 1.3 Built-in editing rule

Built-in step sequences are registry-owned and read-only in the admin UI (the boot seed rewrites them every boot, so an admin reorder would silently revert). To change a built-in's sequence, fork it into a new custom static type. Disabling onboarding or workflow breaks the New Task auto-detect default — enable-lock those two core built-ins (allow disabling the rest).

---

## Phase 2 — Declarative promotion (make reuse work for custom types)

### 2.1 Generalize the fix loop

`FIX_LOOP_TARGET_STEP_ID = '07-phase-2-implement'` is a module const (packages/worker/src/step-engine/steps/workflow/_fix-loop.ts:16) used at three sites: `loop_back` re-entry (task-queue.ts:982), post-escalation continue (task-queue.ts:1205), and `loadPriorFixContext`'s query (_fix-loop.ts:389). `HUMAN_REJECT_SOURCES` (:281) and `HONORED_CONSTRAINT_SOURCES` (:315) are module-const Sets.

- Add `resolveFixLoopConfig(db, taskId): FixLoopConfig` in _fix-loop.ts, loading the task's definition `fixLoop` block and falling back to today's constants when absent. The migrated `workflow` definition carries exactly today's values -> byte-identical for built-ins.
- Convert the three call sites to use the resolved target/sets. A `null` target means the type opted out of the fix loop; a `loop_back` there becomes a hard fail (prevented at save time by the composition validator, which rejects a loop-emitting step without a declared target — the DB analog of `assertPathStepSetsClosed`).

### 2.2 Promote hardcoded UI panel triggers to declarative flags

The rich panels (VNC/direct browser, DB access, commit-diff, run-app) already read `detectOutput`; only the gating is hardcoded by `step.stepId === '...'` in packages/web/src/app/(app)/tasks/[id]/page.tsx (helper `liveBrowserPanel` :60-89; headerSlot/beforeFieldsSlot/below-form branches ~:2760-2913). So this is a gating change, not a content rewrite.

- Add a shared `UiPanelSpec` descriptor `{ slot: 'header'|'beforeFields'|'belowForm', kind: 'liveBrowser'|'runAppReady'|'commitDiff', title?, artifactPathKey?, suppressWhenActiveRole? }`. A step's `detect()` adds `uiPanels: UiPanelSpec[]` to its detectOutput.
- One pure helper `resolveStepPanels(step)`: use `detectOutput.uiPanels` if present (the path custom-type steps take — zero new stepId branches, zero new React), else fall back to a centralized `BUILTIN_STEP_PANELS: Record<stepId, UiPanelSpec[]>` map that encodes today's logic in one place. Replace the three scattered JSX branch clusters with a generic renderer that maps `slot`+`kind` to the existing components (`liveBrowserPanel`, `RunAppReadyPanels`, `CommitDiffViewer`), preserving the existing type-agnostic guards (`runtimeTornDown`, `taskEnded`, `status !== 'waiting_form'`). Backward-compat is exact.

The task-detail tabs (steps/editor/terminal/activity/attachments) and the `/tasks/:id/files/raw` artifact fetch (packages/api/src/routes/tasks/files.ts:143) are already type-agnostic — no change. Terminal/IDE/browser/DDEV all light up for any task with a repo volume + the right preconditions, so a custom static type gets them by composing a worktree-setup-equivalent + (if it needs a running app) a runtime planter step.

---

## Phase 3 — Sandboxed custom code

### 3.1 Prompt-template step -> synthetic StepDefinition (data, not code)

A definition entry `{ kind:'prompt-template', stepSlug, title, promptTemplate, requiredCapabilities, timeoutMs, agentPool?, uiPanels? }` becomes a synthetic `StepDefinition` at registration time, reusing the existing runner/dispatch with no new execution path.

- Factory `synthesizeStepDefinition(entry, defSlug, index)`: `metadata.id = 'custom.<defSlug>.<stepSlug>'`, `workflowType = defSlug`, `requiresCli: true`, capabilities from config, `llm.agentPool` from `entry.agentPool`. `llm.buildPrompt(args)` = safe mustache-style `{{field}}` interpolation of `entry.promptTemplate` against `args.formValues` (already has preAnswers overlaid) + `args.detected` — plain substitution, no eval/Function. `parseOutput` = generic JSON try-parse. `apply` = generic: write raw + parsed to `task_steps.output`; no in-process fs writes (file work goes through the sandboxed MCP tool).
- Repository agents follow `toasty-percolating-kernighan`'s per-invocation rule with nothing custom here. An entry whose `requiredCapabilities` carry `file_write` keeps seeing the real tree. One that carries `subagents` keeps the agent catalog, and that capability already restricts dispatch to sub-agent-capable adapters (`resolveDispatch`), every one of which reads a markdown agent directory — so a template that wants the model to spawn repository agents never lands on amp (no agent directory), codex or gemini. Any other entry sees no repository agent definitions unless it sets `agentPool: '*'`, which is for reading agent files as data and leaves provider eligibility alone.
- `{{agent:<id>}}` is not a form field. `buildPrompt` renders it as a marker of its own, `[[HAIVE_TEMPLATE_PERSONA:<id>]]`, never as that plan's `agentDefinitionGuidance` block, and Phase 3.1 widens that plan's persona resolver for that syntax only, because the LSP gate that plan keeps exists to protect an embedded fallback a template persona does not have. The kind rides in the prompt itself, not in a `DispatchRequest` field every dispatch path would have to carry, and the rewrite handles both kinds in one `replace` over a pattern matching either, since a second pass would rescan the bodies the first inserted. A token id must match the marker grammar (`[a-z0-9-]+`): the composer refuses any other id at save, task-create refuses it with a named reason, and `agentDefinitionGuidance` and the template marker's renderer both assert it, so no caller can emit a marker the rewrite would leave unparsed. Save and task-create run in the api, which cannot import the worker's private patterns, so the id grammar is one `@haive/shared` constant that the api's checks and both marker patterns are built from. The body is pasted for EVERY provider and whether or not the invocation is isolated — a template that declares `file_write`, `subagents` or `agentPool: '*'`, or names an agent directory or file in its prompt, still has no embedded protocol — so the widened resolver runs for these markers outside that plan's isolation predicate, and every body it pastes is still recorded in `pastedPersonaPaths` for that plan's exec-time secret-mask recheck, isolated or not. It reads `<id>.md` by filename, as that plan does, from the selected provider's own agent directory when that one is markdown and holds it, and otherwise from the first markdown agent directory in catalog order that does — the same directories the dangling-reference check searches, so a persona defined only in `.gemini/agents` raises no start-time warning and still resolves for a claude dispatch, and codex (TOML) and amp (no agent directory) get it without the TOML reader that plan defers. A marker whose body cannot be found at dispatch fails the dispatch with the dangling-reference reason instead of running without its persona — the start-time check reads a different tree, and the tree can change before dispatch — and one whose body would exceed that plan's per-prompt `MAX_PERSONA_BODY_BYTES` budget fails the same way, naming the file and its size, so many tokens cannot add up past it. A template that names an agent directory or file (`Review {{path}}` with `path = .claude/agents/foo.md`) needs nothing of its own: that plan's prompt path scan sees interpolated values and static text like any other prompt text; a template marker names no path, and the bodies pasted for it are scanned verbatim, marker-shaped text included, since the rewrite never rescans what it inserts.
- Registration: `registerCustomStepsFromDefinitions(registry, db)` runs at boot after `registerAllSteps`, reading definitions and calling `registry.override(...)` (packages/worker/src/step-engine/registry.ts:19, upserts, tolerates re-runs). `buildRunList` `require()`s ids at execution time, well after boot, so synthetics are present when needed.
- CLI-dispatch gating caveat: `assertCliDispatchListInSync` (steps/index.ts:94) throws if an `llm` step is absent from the static `CLI_DISPATCH_STEP_IDS`. Custom synthetics register after that snapshot so they fall outside it (confirm ordering at boot). The web per-step CLI picker must treat `custom.*` as CLI-dispatching via the catalog `dispatchesCli` flag rather than the static shared array — the single static-shared-constant that does not stretch to custom steps.

### 3.2 Custom sandboxed MCP tool

Rides `buildDefaultMcpServers` exactly like `haive-rag` / `ddev-control` (packages/worker/src/sandbox/mcp-config.ts:125,137): a dep-free stdio ESM server bind-mounted as a `SandboxExtraFile`, gated by a flag, handed an API URL + a task-scoped token (`signRagToken` / `verifyRagToken`). The MCP server runs inside the sandbox (already the untrusted zone). The API callback route is the security boundary and must be Haive code, not admin code.

- Admin supplies per tool: `toolName`, `description`, `inputSchema` (the MCP advertisement); a gating flag; and a callback behavior chosen from a vetted, allow-listed action registry (e.g. proxy to an allow-listed HTTPS URL, read-only RAG-style query) — not arbitrary handler code (that would need a real sandbox for the callback and is out of MVP scope).
- Wiring: one parameterized `custom-mcp-server.ts` string (clone of the ddev/rag server); `buildDefaultMcpServers` accepts a `customMcpServers[]` array and pushes each as an `McpServerSpec`; `resolveMcpExtraFiles` (packages/worker/src/queues/cli-exec/resolvers.ts:300) mints a token and ships the file per enabled tool; new api router packages/api/src/routes/custom-mcp.ts (mounted `/custom-mcp`) verifies the token and dispatches to the vetted registry (delegating to a worker queue when it needs docker/fs, as ddev-control does).

---

## Admin authoring UI + API (spans Phase 1-3)

- New api router packages/api/src/routes/task-types.ts (requireAuth + requireAdmin, mirroring packages/api/src/routes/admin.ts:24-25), CRUD `/admin/task-types` (list, create, get, put, enable, disable) + `/admin/task-types/catalog`, each zod-validated and wrapped in `recordAuditEvent` (`targetType:'task_type'`). It is a resource, not a config KV, so it does not belong in admin.ts.
- Public read `GET /task-types` (requireAuth only) returning enabled+selectable `{slug,name,description,runListStrategy}` for the New Task picker (web stays REST-only; no worker import).
- New admin page packages/web/src/app/(app)/admin/task-types/page.tsx: list + editor mirroring the load->edit->save shape of packages/web/src/app/(app)/repos/[id]/tooling/page.tsx and the Card layout of admin/page.tsx; add an `admin/task-types` link next to the existing `admin/audit` link.
- Composer control: bespoke React modeled on the existing `bundle-composer` custom field + `BundleComposer` component (packages/web/src/components/form-renderer.tsx:881) — FormRenderer renders a flat field list and has no reorderable-sub-form primitive. Palette (curated catalog) on the left; ordered `stepIds` with reorder/remove + live prereq validation on the right; per-step params rendered inline with FormRenderer against each step's `paramFormSchema` (this part reuses FormRenderer directly). The reorder editor is shown only for `runListStrategy = 'static'`; for the two dynamic built-ins the admin edits enable/disable + params only.
- New Task form (packages/web/src/app/(app)/tasks/new/page.tsx:251-255,329-335,462-493): replace the binary run-app toggle with a real select sourced from `GET /task-types`, keeping onboarding-status auto-detect as the fallback default.

### A module may seed a task-type definition

A module that ships steps will usually want to ship the task type that composes them, so the customer
does not have to hand-assemble it in the composer to get the thing they paid for.

- Manifest gains `taskTypes?: TaskTypeDefinitionSeed[]`, upserted by the module loader the same way
  the composable catalog is — the boot-upsert pattern this plan already borrows from
  `syncTemplateManifestCache`.
- Seeded rows carry `source: 'module:<id>'` so an admin can see they are vendor-supplied, and so they
  are removed with the module.
- An admin may **disable** a module-seeded definition but not delete it: deletion would simply be
  undone at the next boot upsert, and a control that silently reverts is worse than no control.
  Removing it for real means removing the module.

### Creator mode: describe a step in chat, generate the DATA-DRIVEN definition

Cordis's "creator mode" scaffolds and hot-loads a new plugin from a chat description after an
approval click. The dangerous half of that (hot-loading executable code into a live process) is
exactly what Phase 3 refused. But the SAFE half maps perfectly onto this plan, because a
prompt-template step is DATA, not code:

- An admin describes the step they want in natural language ("review the changed SQL migrations for
  destructive operations and report each with severity"). An LLM turn produces a candidate
  `{ kind:'prompt-template', stepSlug, title, promptTemplate, requiredCapabilities, timeoutMs,
  agentPool?, uiPanels? }` entry — the exact shape Phase 3.1 already synthesizes into a StepDefinition.
  The turn is handed the persona catalog Haive's onboarding templates install (id + description), so
  the template can name one with `{{agent:<id>}}`. Authoring is global, so no single repository's
  own agents apply; a repository-specific persona typed by hand is warned about when a task starts
  and checked authoritatively at dispatch by the dangling-reference rule, and the admin reviews the
  pick in the composer like any other field.
- Nothing executes on generation. The output is a definition row the admin previews, edits in the
  composer, and saves. It flows through the SAME prereq/loop-closure validator and the SAME
  `synthesizeStepDefinition` factory — there is no new execution path, no runtime code injection,
  and no rebuild (prompt-template steps are data and need none, per Phase 3.1).
- This is strictly an authoring convenience over Phase 3's manual composer, so it trails Phase 3 and
  cannot precede it. It reuses one existing LLM dispatch and adds no new trust surface: the
  generated artifact is a prompt template that runs in the sandbox like any other, gated by the
  same `CUSTOM_TASK_TYPES_ENABLED` switch.
- Explicitly NOT in scope even here: generating a custom MCP TOOL's callback from a description.
  Tool callbacks are the vetted allow-list (Phase 3.2); a described-into-existence handler would be
  arbitrary code and is the exact thing that plan section keeps behind the allow-list. Creator mode
  generates prompt-template steps only.

---

## Net-new infrastructure (everything else reuses existing patterns)

1. `task_type_definitions` table + `tasks.run_list_snapshot` column + strategy enum.
2. `composable_step_catalog` table + composable-catalog.ts + `syncComposableCatalog` boot-upsert.
3. task-type-manifest.ts + `syncTaskTypeDefinitions` boot-upsert + boot byte-identical assertion.
4. Shared prereq/loop-closure validator (mirrors assertPathStepSetsClosed) + `STEP_LOOP_TARGETS`.
5. Shared `UiPanelSpec` descriptor + `resolveStepPanels` / `BUILTIN_STEP_PANELS` centralization.
6. `synthesizeStepDefinition` factory (carrying `agentPool`, rendering `{{agent:<id>}}` as `[[HAIVE_TEMPLATE_PERSONA:<id>]]` markers) + `registerCustomStepsFromDefinitions` boot hook + the start-time persona check in `handleStartTask` (`agent_persona.unresolved` events) + the shared `{{agent:<id>}}` id grammar constant.
7. Parameterized custom-mcp-server.ts + `/custom-mcp` router + vetted callback registry.
8. `CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED` kill-switch + admin toggle card.
9. task-types admin API router + admin page + composer component + public `GET /task-types`.

## Critical files (touch points)

- Data model: packages/database/src/schema/task-types.ts (NEW), schema/index.ts barrel, schema/tasks.ts:47-59 (enum->text in 1b) + new snapshot column, numbered migrations for 1a and 1b.
- Run list: packages/worker/src/queues/task-queue.ts:88-110 (context), :112-130 (dispatch rewrite), :180-213 (resolve by slug); buildRunAppRunList and orderWorkflowRunList bodies unchanged.
- Boot/seed: packages/worker/src/step-engine/task-type-manifest.ts (NEW), composable-catalog.ts (NEW), bootstrap.ts:45, steps/index.ts (assertions), execution-paths.ts:98-108 (generalize).
- Fix loop: packages/worker/src/step-engine/steps/workflow/_fix-loop.ts:16,281,315,389 + call sites task-queue.ts:982,1205.
- Phase 3: packages/worker/src/step-engine/step-definition.ts (synthetic step shape, `llm.agentPool`), sandbox/mcp-config.ts:75-150, queues/cli-exec/resolvers.ts:300, queues/task-queue.ts `handleStartTask` (the start-time persona check), and the persona resolver `toasty-percolating-kernighan` adds to orchestrator/dispatcher.ts and steps/_retrieval-guidance.ts (widened for the template persona marker only, in the same single rewrite pass; both marker patterns built from the shared id grammar).
- Shared: packages/shared/src/schemas/tasks.ts:3-8,66, types/index.ts:1, config.service.ts (kill-switch), new validator + UiPanelSpec, and the `{{agent:<id>}}` id grammar constant beside the validator.
- Api: packages/api/src/routes/tasks/index.ts:154-247, task-types.ts (NEW), custom-mcp.ts (NEW), verify insert sites upgrades.ts:395 + global-kb.ts:336.
- Web: packages/web/src/lib/api-client.ts:430, app/(app)/tasks/new/page.tsx, app/(app)/tasks/[id]/page.tsx (panel promotion), app/(app)/admin/task-types/page.tsx (NEW) + composer component.

## Verification (end-to-end, per phase)

- 1a: worker boots (the byte-identical assertion passes); run an existing onboarding, workflow, and run_app task through the dev stack (`pnpm docker:dev`) — behavior identical because the hardcoded path is still active. Unit-test the strategy dispatch against seeded rows (`pnpm test`). Typecheck per-container (per project convention).
- 1b (kill-switch off): re-run the workflow smoke (canned formPayloads; 12-worktree-cleanup must be action:'keep'); confirm run lists identical via `task_steps.run_seq` ordering. Confirm the enum->text ALTER is in-place, not drop+recreate.
- Custom type (kill-switch on): author a static custom type in the admin UI composing [worktree-setup, a prompt-template step, a verify step]; create a task of it; confirm it runs, reuses terminal/IDE/browser, and the verify gate + panels render (via `uiPanels`, no stepId branch). Confirm the composition validator rejects an unsatisfied-prerequisite ordering and a loop step without a target.
- Phase 2: custom type with a fix loop targeting its own implement-equivalent — confirm `loop_back` re-enters correctly; a built-in workflow task still fixes-loops identically (fallback path).
- Phase 3: prompt-template step renders the template with form values and dispatches a sandbox CLI invocation; a custom MCP tool is injected via `buildDefaultMcpServers`, the agent calls it, and the `/custom-mcp` callback verifies the task token. A prompt-template step using `{{agent:peer-reviewer}}` produces a captured request (`toasty-percolating-kernighan`'s capture harness) that contains that persona's body and no other repository agent. A token naming a persona the checked-out repository lacks records `agent_persona.unresolved` when the task starts and fails that step's dispatch with the named reason, while one defined only on the base `01-worktree-setup` branches from warns at start and still runs; on codex the template marker's body is pasted while a built-in step's marker in the same task keeps its fallback sentence; a `file_write` template, which is not isolated, whose persona file a deny rule covers by exec time fails before the CLI starts; a token id outside the grammar is refused at task-create.
- Use the project verify skill / chrome-devtools MCP to drive the admin UI and a custom task in the running app, not just tests.

## Rollback (write the undo before the change)

- 1a: unconditional — redeploy prior worker; nothing reads the new table for decisions.
- 1b before any custom task exists: redeploy prior code and re-cast `ALTER COLUMN type TYPE workflow_type USING type::workflow_type` (succeeds — all values are built-in slugs). The retained dead `resolveLegacyRunList` and the still-defined `workflow_type` enum make this clean.
- 1b after a custom task exists: the re-cast fails (a custom slug is not an enum member). This is the one irreversible boundary; undoing requires deleting or remapping custom-typed task rows first. The `CUSTOM_TASK_TYPES_ENABLED` kill-switch exists precisely to keep the pre-custom, fully-reversible window open for as long as wanted; flipping it on is the deliberate, logged act that crosses the boundary.

## Sequencing / effort

Phase 1 is the foundation and the bulk of the value and risk (schema, seed, byte-identical proof, cutover, kill-switch, admin CRUD + composer + picker, catalog + validator). Ship and bake it with the switch off before enabling custom creation. Phase 2 is a focused, self-contained refactor that unblocks custom types reusing the rich panels + fix loop. Phase 3 is additive and can trail; the prompt-template step is small, the custom MCP tool is the largest single new subsystem and can ship last (or the allow-listed-callback MVP first, arbitrary callbacks deferred).

## Deferred / out of scope

- Migrating built-in step SEQUENCES to admin-editable (they stay registry-owned; fork to customize).
- Arbitrary admin-authored MCP callback handler code (vetted allow-list only for MVP).
- Per-user (non-global) task types.
- Exposing all ~60 registered steps as composable (curated allow-list only).
- The reactive RUNTIME rebind other plugin harnesses do (swap a provider under a live task and
  reload it). A running task's run list is materialised and forward-walked precisely so a mid-flight
  definition edit cannot mutate it — the opposite choice, and the correct one here.

**Already built, recorded so it is not "discovered" later as a gap.**

The harness author is envious of an append-only session log with a trajectory view — "what did the
model actually see is a click." Haive already has it: `task_events`, `cli_invocations` with
`stream_log`, the `CliStreamViewer` trajectory, and per-invocation `model_identity` (requested vs
served). No gap; noted so it is not "discovered" later as a missing feature.
