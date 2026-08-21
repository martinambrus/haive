# Modular (user-definable) task types

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

A definition entry `{ kind:'prompt-template', stepSlug, title, promptTemplate, requiredCapabilities, timeoutMs, uiPanels? }` becomes a synthetic `StepDefinition` at registration time, reusing the existing runner/dispatch with no new execution path.

- Factory `synthesizeStepDefinition(entry, defSlug, index)`: `metadata.id = 'custom.<defSlug>.<stepSlug>'`, `workflowType = defSlug`, `requiresCli: true`, capabilities from config. `llm.buildPrompt(args)` = safe mustache-style `{{field}}` interpolation of `entry.promptTemplate` against `args.formValues` (already has preAnswers overlaid) + `args.detected` — plain substitution, no eval/Function. `parseOutput` = generic JSON try-parse. `apply` = generic: write raw + parsed to `task_steps.output`; no in-process fs writes (file work goes through the sandboxed MCP tool).
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

---

## Net-new infrastructure (everything else reuses existing patterns)

1. `task_type_definitions` table + `tasks.run_list_snapshot` column + strategy enum.
2. `composable_step_catalog` table + composable-catalog.ts + `syncComposableCatalog` boot-upsert.
3. task-type-manifest.ts + `syncTaskTypeDefinitions` boot-upsert + boot byte-identical assertion.
4. Shared prereq/loop-closure validator (mirrors assertPathStepSetsClosed) + `STEP_LOOP_TARGETS`.
5. Shared `UiPanelSpec` descriptor + `resolveStepPanels` / `BUILTIN_STEP_PANELS` centralization.
6. `synthesizeStepDefinition` factory + `registerCustomStepsFromDefinitions` boot hook.
7. Parameterized custom-mcp-server.ts + `/custom-mcp` router + vetted callback registry.
8. `CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED` kill-switch + admin toggle card.
9. task-types admin API router + admin page + composer component + public `GET /task-types`.

## Critical files (touch points)

- Data model: packages/database/src/schema/task-types.ts (NEW), schema/index.ts barrel, schema/tasks.ts:47-59 (enum->text in 1b) + new snapshot column, numbered migrations for 1a and 1b.
- Run list: packages/worker/src/queues/task-queue.ts:88-110 (context), :112-130 (dispatch rewrite), :180-213 (resolve by slug); buildRunAppRunList and orderWorkflowRunList bodies unchanged.
- Boot/seed: packages/worker/src/step-engine/task-type-manifest.ts (NEW), composable-catalog.ts (NEW), bootstrap.ts:45, steps/index.ts (assertions), execution-paths.ts:98-108 (generalize).
- Fix loop: packages/worker/src/step-engine/steps/workflow/_fix-loop.ts:16,281,315,389 + call sites task-queue.ts:982,1205.
- Phase 3: packages/worker/src/step-engine/step-definition.ts (synthetic step shape), sandbox/mcp-config.ts:75-150, queues/cli-exec/resolvers.ts:300.
- Shared: packages/shared/src/schemas/tasks.ts:3-8,66, types/index.ts:1, config.service.ts (kill-switch), new validator + UiPanelSpec.
- Api: packages/api/src/routes/tasks/index.ts:154-247, task-types.ts (NEW), custom-mcp.ts (NEW), verify insert sites upgrades.ts:395 + global-kb.ts:336.
- Web: packages/web/src/lib/api-client.ts:430, app/(app)/tasks/new/page.tsx, app/(app)/tasks/[id]/page.tsx (panel promotion), app/(app)/admin/task-types/page.tsx (NEW) + composer component.

## Verification (end-to-end, per phase)

- 1a: worker boots (the byte-identical assertion passes); run an existing onboarding, workflow, and run_app task through the dev stack (`pnpm docker:dev`) — behavior identical because the hardcoded path is still active. Unit-test the strategy dispatch against seeded rows (`pnpm test`). Typecheck per-container (per project convention).
- 1b (kill-switch off): re-run the workflow smoke (canned formPayloads; 12-worktree-cleanup must be action:'keep'); confirm run lists identical via `task_steps.run_seq` ordering. Confirm the enum->text ALTER is in-place, not drop+recreate.
- Custom type (kill-switch on): author a static custom type in the admin UI composing [worktree-setup, a prompt-template step, a verify step]; create a task of it; confirm it runs, reuses terminal/IDE/browser, and the verify gate + panels render (via `uiPanels`, no stepId branch). Confirm the composition validator rejects an unsatisfied-prerequisite ordering and a loop step without a target.
- Phase 2: custom type with a fix loop targeting its own implement-equivalent — confirm `loop_back` re-enters correctly; a built-in workflow task still fixes-loops identically (fallback path).
- Phase 3: prompt-template step renders the template with form values and dispatches a sandbox CLI invocation; a custom MCP tool is injected via `buildDefaultMcpServers`, the agent calls it, and the `/custom-mcp` callback verifies the task token.
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

---

# Amendment — 2026-08-20: composing module-contributed steps

*Appended after the original plan was archived; the body above is unchanged. Companion to the
amendment on `serialized-chasing-thacker.md`. Added so a distributed module (the deep project
analysis scan) can contribute steps that a task type is then composed from.*

## F. Definitions may reference module-contributed steps

The module system exports `./steps` and its loader registers them, but this plan composes task types
from a **curated** `composable_step_catalog` — so without this, a module's steps are registered yet
invisible to the composer and unusable by any task type.

- The catalog is the union of core entries and every loaded module's `composableSteps`, namespaced
  `module.<moduleId>.<stepId>` so a module can never shadow a core step id (companion amendment A).
- The prereq validator needs **no special-casing**: it walks `requires`/`provides` capability tokens,
  not step ids, so a module step that `provides: ['worktree']` satisfies a core step's need exactly as
  `01-worktree-setup` does. This is the payoff of the capability-token design already in this plan.
- `buildRunList` resolves module step ids through the same registry, which the module loader has
  populated before the catalog sync runs.

## G. Dangling references — a module removed under a live definition

Data-driven types plus distributed modules create a failure mode neither has alone: a definition's
ordered step list can reference steps that no longer exist, because the module supplying them was
disabled, removed, or failed to load after a rebuild.

- Validate that every `stepId` resolves at boot **and** at task-create (the existing defence-in-depth
  pattern this plan already applies to prereq validation).
- A definition with an unresolvable step becomes **not selectable, with a named reason** — "requires
  module `deep-analysis`, which is not installed". Never a crash, and never silently dropping the
  missing step, which would run a truncated pipeline the admin never authored and cannot see.
- Tasks already running are untouched: their run list is materialised, and `buildRunList` is
  forward-walked from the current step. This gates new task creation only.

## H. A module may seed a task-type definition

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

---

# Amendment — 2026-08-21: unbuilt; and how the two puffin files relate

Unbuilt — none of `schema/task-types.ts`, `routes/task-types.ts`, `task-type-manifest.ts`,
`composable-catalog.ts`, `routes/custom-mcp.ts` or the admin task-types page exists.

**Two files describe this feature and neither supersedes the other.** This file is the whole design
and the locked user decisions. `rippling-wibbling-puffin-agent-a233cf7f9b59974f6.md` is a
subagent-written **half A** — data model, `buildRunList`, pgEnum, migration and seed — grounded
line-by-line against the tree at the time. They are complementary: read this one for the design and
the amendment on module-contributed steps, and half A for the migration mechanics and the
`findIndex` invariant. Half A covers only the first slice; it is not an alternative plan.

Anchor drift shared by both: `buildRunList` is now `task-queue.ts:152` (half A says 112-130) and
`buildRunAppRunList` is `:186` (says 146-178). Both `execution-paths.ts:98`
(`PATH_REQUIRED_TARGETS`) and `:133` (`orderWorkflowRunList`) still resolve exactly as cited, in
`packages/worker/src/orchestrator/execution-paths.ts`.
