# Modular / user-definable task types — implementation plan (half A: data model, buildRunList, pgEnum, migration, seed)

Grounded against the current tree. All line refs verified read.

## 0. Verified facts this plan stands on

- `buildRunList` (worker/src/queues/task-queue.ts:112-130) is the single branch point.
  - `run_app` -> `buildRunAppRunList` (:146-178): hand-assembles by `require(id)`, tail branches on
    `envTemplate.declaredDeps.containerTool` — RUNTIME-DYNAMIC, input is task-pinned (env template).
  - `workflow` -> `orderWorkflowRunList(main, prelude, executionPath)` (execution-paths.ts:133-152):
    filters by `tasks.execution_path` — RUNTIME-DYNAMIC, input is task-pinned (set by 00-triage).
  - everything else (`onboarding`, `onboarding_upgrade`, `kb_author`) -> `stepRegistry.listByWorkflow(type)`
    (registry.ts:43-45): the full registered list for that workflowType, sorted by `metadata.index`. STATIC.
  - `env_replicate` is NOT a task type — it is only pulled as `prelude` inside the workflow branch (:120).
- buildRunList is REBUILT ON EVERY HOP and walked forward: `findIndex(stepId)+1` at task-queue.ts:804,
  1185, 1233-1234, 1394-1395. If the list changes shape under a running task, findIndex can return -1 ->
  premature completion. This is the hard invariant.
- `run_seq` (task_steps.runSeq) = buildRunList position, stamped at advance (:1394-1408) and read back as the
  run-monotonic display key (resolveCurrentStepIndex :243-262). `computeGlobalStepIndex` (step-runner.ts:1791-1802)
  is only the TRANSIENT fallback label before a row materializes; it keys off `WORKFLOW_TYPE_OFFSETS` by the
  step's OWN `metadata.workflowType`.
- Steps are registered under their home `metadata.workflowType` and are globally addressable by id via
  `stepRegistry.require(id)` — this is exactly how run_app already composes cross-type steps (:150-156).
- 4 type-declaration sites: WorkflowType union (shared/types/index.ts:1), workflowTypeSchema zod
  (shared/schemas/tasks.ts:3-8, consumed at :66), web copy (web/lib/api-client.ts:430), pgEnum `workflow_type`
  (database/schema/tasks.ts:47-59, column at :108 — already a SUPERSET: has env_replicate, kb_author, run_app).
- 3 task-insert sites, all set a built-in slug already: tasks/index.ts:222 (form), upgrades.ts:395
  (onboarding_upgrade), global-kb.ts:336 (kb_author).
- All `eq(schema.tasks.type, '<literal>')` filters (upgrades.ts:163/290/383, tasks/index.ts:178, rag.ts:117,
  step-runner.ts:99, several step files, terminal-session-manager.ts:236) compare to BUILT-IN literals only.
  Converting the column enum->text does NOT break them: `WHERE type = 'onboarding'` is valid string
  equality either way, and custom slugs correctly never match onboarding-specific branches.
- Parameterization store already on `tasks`: `preAnswers` jsonb Record<stepId,Record<fieldId,value>> (:210-213),
  `stepLoopLimits` jsonb Record<stepId,number> (:196-199), `maxFixRounds` (:219), `autoContinue` (:203).
- Boot-upsert pattern to mirror: `syncTemplateManifestCache` (template-manifest.ts:304-343) called from
  bootstrap.ts:45; reads worker-only generators, upserts into `template_manifest_cache`
  (onboarding.ts:83-90) so api/web read without importing the worker.
- Admin config GET/PUT toggle pattern: admin.ts:318-346 (concurrency/steering), gated by
  `requireAuth`+`requireAdmin` (admin.ts:24-25). Roles exist (userRoleEnum admin|user).

## 1. `task_type_definitions` table (Drizzle)

New file `packages/database/src/schema/task-types.ts`, exported from schema/index.ts barrel.

```
runListStrategyEnum = pgEnum('run_list_strategy', ['static','workflow_paths','run_app_modes'])

taskTypeDefinitions = pgTable('task_type_definitions', {
  slug:            varchar('slug',128).primaryKey(),   // stable id AND the value stored in tasks.type
  displayName:     varchar('display_name',128).notNull(),
  description:     text('description'),
  runListStrategy: runListStrategyEnum('run_list_strategy').notNull(),
  // Only meaningful for strategy='static'. Ordered list of registered step ids.
  // NULL for the two dynamic strategies (their assembly stays code-resident).
  stepIds:         jsonb('step_ids').$type<string[]>(),
  // Per-step defaults, folded into tasks.preAnswers / tasks.stepLoopLimits at create.
  // Reuse the EXISTING runtime mechanism — no new overlay engine.
  preAnswerDefaults: jsonb('pre_answer_defaults')
                     .$type<Record<string,Record<string,unknown>>>()
                     .notNull().default(sql`'{}'::jsonb`),
  stepLoopLimitDefaults: jsonb('step_loop_limit_defaults')
                     .$type<Record<string,number>>()
                     .notNull().default(sql`'{}'::jsonb`),
  enabled:         boolean('enabled').notNull().default(true), // New-Task visibility
  selectable:      boolean('selectable').notNull().default(true), // false = internal fragment (env_replicate)
  builtin:         boolean('builtin').notNull().default(false), // seeded row; guards destructive admin edits
  sortOrder:       integer('sort_order').notNull().default(0),  // New-Task ordering
  contentHash:     varchar('content_hash',64),  // sha256 of resolved stepIds; boot drift check (built-ins)
  createdAt/updatedAt timestamps
})
```

Design justification (KEY TENSION resolved):

- A single `runListStrategy` discriminator carries the static/dynamic split. `static` is fully data-driven
  (`stepIds`). `workflow_paths` and `run_app_modes` stay code-resident because their assembly reads
  RUNTIME inputs (execution_path, env-template containerTool) that cannot be expressed as a fixed list — but
  they are still REFERENCED by a definition row, so every type (incl. workflow/run_app) is one uniform row
  with a display name, enabled flag, ordering, and params. This is "one uniform system" without pretending a
  runtime-branching pipeline is a flat list.
- Custom types can ONLY be `static` (the admin UI never offers the two code-resident strategies for new
  rows). This keeps custom types inside the deterministic-list contract the forward walk requires.
- Per-step parameter defaults map ONTO the existing `preAnswers` / `stepLoopLimits` runner mechanism rather
  than inventing a second overlay path (Simplicity First). At task create, `preAnswerDefaults` seed
  `tasks.preAnswers` and `stepLoopLimitDefaults` seed `tasks.stepLoopLimits`; the runner already overlays
  those as top-priority auto-submit candidates.

Which rows get seeded (the "6 built-ins" question, precisely):
- 5 SELECTABLE: `onboarding`(static), `workflow`(workflow_paths), `onboarding_upgrade`(static),
  `kb_author`(static), `run_app`(run_app_modes).
- 1 FRAGMENT: `env_replicate` (static, selectable=false) — seeded so the workflow branch can eventually
  resolve its prelude from data too, and so the boot drift check covers it. It is NOT a New-Task option.
  RECOMMENDATION: seed all 6 (satisfies the user's "6" and maximal uniformity), but in phase 1b the
  workflow branch keeps calling `listByWorkflow('env_replicate')` for the prelude — moving that read to the
  seeded row is an optional later tightening, out of scope for the byte-identical proof.

### 1a. Task-side pinning column (forward-walk safety — REQUIRED)

Add to `tasks` (database/schema/tasks.ts):
```
runListSnapshot: jsonb('run_list_snapshot').$type<string[]>()  // static strategy only; NULL for dynamic + legacy
```
At create, for a `static` type, copy the resolved `stepIds` -> `tasks.run_list_snapshot`. buildRunList's static
branch resolves the SNAPSHOT, not the live definition. Rationale: an admin editing a global definition
mid-task would otherwise mutate a running task's list and break `findIndex` (-1 -> premature completion). The
two dynamic strategies need no snapshot — their inputs (execution_path, env template) are already task-pinned.
This is the analog of how workflow/run_app stay deterministic per-hop from stable task-pinned inputs.

## 2. buildRunList rewrite (data-driven, dynamic assemblers preserved)

Extend `ResolvedTaskContext` (task-queue.ts:88-110): add
```
runListStrategy: 'static'|'workflow_paths'|'run_app_modes';
runListSnapshot: string[] | null;
```
`resolveTaskContext` (:180-213): after loading the task, load its definition by slug
(`db.query.taskTypeDefinitions.findFirst({where eq(slug, task.type)})`). If missing -> throw (fail loud, do
not silently fall back). Populate strategy + snapshot (snapshot from `task.runListSnapshot`, or definition
`stepIds` for legacy rows with null snapshot). Keep `workflowType: task.type as string` (drop the
`as WorkflowType` cast — see #3).

New control flow:
```
async function buildRunList(ctx, db): StepDefinition[] {
  switch (ctx.runListStrategy) {
    case 'run_app_modes':   return buildRunAppRunList(ctx, db);        // UNCHANGED
    case 'workflow_paths': {                                          // UNCHANGED body
      const main = stepRegistry.listByWorkflow('workflow');
      const prelude = stepRegistry.listByWorkflow('env_replicate');
      return orderWorkflowRunList(main, prelude, ctx.executionPath);
    }
    case 'static': {
      const ids = ctx.runListSnapshot ?? /*legacy*/ definitionStepIds(ctx);
      return ids.map((id) => stepRegistry.require(id));               // require() = fail loud on bad id
    }
  }
}
```
Note: the static branch no longer keys off `ctx.workflowType === 'workflow'` string equality; it dispatches on
the definition's strategy. `listByWorkflow('workflow')` and `listByWorkflow('env_replicate')` inside
workflow_paths stay literal because those are registry keys (StepMetadata.workflowType), NOT task slugs — the
seam holds.

Create-path decision — new column vs slug-in-`type`: store the SLUG directly in `tasks.type` (no
`task_type_definition_id` FK). Reasons: (a) `type` already flows through ~15 read sites as a string; a slug
keeps them working untouched; (b) the definition is keyed by slug (its PK), so a FK is redundant; (c) avoids a
join on every task read. The definition is the source of truth for strategy/steps; the task pins the
snapshot. (A nullable FK would only add value if slugs were mutable — keep slugs immutable instead.)

computeGlobalStepIndex caveat (flag, cosmetic): `WORKFLOW_TYPE_OFFSETS` (step-runner.ts:1791) has no entry
for a custom slug -> offset 0 for the transient pre-materialization fallback label. run_seq is the real key
and is stamped at park (:1394-1408), so the display self-corrects the moment the row materializes. Acceptable;
document it. Do not attempt to register custom slugs in WORKFLOW_TYPE_OFFSETS (arbitrary, unbounded).

## 3. pgEnum problem + 4-site reconciliation

RECOMMENDATION: convert `tasks.type` from `workflowTypeEnum` to `text` (do NOT add a 'custom' enum member).
- Rationale: arbitrary user slugs cannot be pgEnum values; a 'custom' member + FK forces a two-field
  (`type='custom'` + `definition_id`) read model that breaks every existing `eq(tasks.type,'onboarding')`
  filter and every `task.type === 'run_app'` branch. text keeps all built-in slugs as their own literal
  values, so those ~15 sites are untouched and custom slugs slot in as first-class values.
- Keep the `workflow_type` pgEnum TYPE defined in the DB (unused) so rollback can re-cast. Do not drop it in
  phase 1.

Runtime validation replacing the compile-time enum, without breaking api/web boundary:
- shared `workflowTypeSchema` (schemas/tasks.ts:3-8): relax `createTaskRequestSchema.type` (:66) from the
  z.enum to `z.string().min(1).max(128)`. shared cannot read the DB, so shape-validate only here.
- api route (tasks/index.ts, after parse ~:156): add an explicit DB lookup — load the definition by slug;
  404 if missing, 403/400 if `enabled=false` or `selectable=false`. This mirrors the existing per-type
  precondition checks already in this handler (:170-193). This is where "is this a real, enabled type?"
  lives now.
- shared `WorkflowType` union (types/index.ts:1): keep as a NARROW alias of the built-in slugs for internal
  typing, but it is no longer the authority for task.type. Where code needs "any task type", use `string`.
- web `WorkflowType` (api-client.ts:430): relax to `string` (or `BuiltinWorkflowType | (string & {})`). The
  New-Task page (:251-255, :329-335) currently INFERS type from onboarding status; this stays for the
  built-in auto-detect path, but the type list for an explicit custom-type picker comes from a new endpoint
  (below), never from importing the worker registry or the shared barrel (respects the redis->dns web bundle
  rule).

New public endpoint `packages/api/src/routes/task-types.ts`: `GET /task-types` -> reads
`task_type_definitions` where enabled+selectable, returns `{slug,displayName,description,sortOrder}` for the
New-Task form. api reads Postgres directly (allowed); web consumes REST only (boundary respected).

## 4. Migration safety — two-phase reversible rollout

Convention: TS schema authoritative (`drizzle-kit push --force`); numbered idempotent `.sql` mirror
(migrations/, next free is 0092). Every `.sql` uses `IF NOT EXISTS` / guarded DO blocks.

### Phase 1a — additive, ZERO behavior change (fully reversible)
1. Create `task_type_definitions` + `run_list_strategy` enum (migration 0092). Add `tasks.run_list_snapshot`
   (0093). `tasks.type` STAYS a pgEnum. Built-in buildRunList branches STAY active (no rewrite yet).
2. Seed the 6 built-in rows at worker boot (see #5). Populate each static/fragment row's `stepIds` =
   `listByWorkflow(slug)` ids, and `contentHash` = sha256 of that ordered list.
3. BOOT ASSERTION (fail-to-boot): for every seeded row with strategy `static` (onboarding, onboarding_upgrade,
   kb_author) and the `env_replicate` fragment, assert `row.stepIds` is byte-identical to the ids from
   `listByWorkflow(slug)`. For `workflow`/`run_app` assert only that the strategy resolves (no static list to
   compare). This proves the data model reproduces the hardcoded lists before anything switches over.
   Location: extend registerAllSteps' assertion cluster (steps/index.ts:20-30) or a sibling called from
   bootstrap after registration + seed.
- Phase-1a ROLLBACK (plain English): nothing reads the new table for run-list decisions yet, so reverting is
  pure cleanup. Redeploy the prior worker image; the seed/assert code is gone. Optionally drop
  `task_type_definitions`, `run_list_strategy`, and `tasks.run_list_snapshot`. No task ever depended on them.
  Safe unconditionally.

### Phase 1b — cutover (reversible until the first custom task exists)
4. Rewrite buildRunList to dispatch on `ctx.runListStrategy` (#2). Keep the OLD hardcoded branch bodies inline
   as a dead `resolveLegacyRunList(ctx,db)` fallback for one release, invoked only if a definition row is
   missing (defensive; the boot assert makes this unreachable for built-ins).
5. Convert `tasks.type` enum->text (migration 0094):
   `ALTER TABLE tasks ALTER COLUMN type TYPE text USING type::text;` (drizzle-kit push emits the TYPE change;
   the hand-written .sql MUST include the explicit `USING type::text` — an enum->text alter needs it). Keep
   the `workflow_type` enum type in place.
6. Relax shared zod + web/shared unions (#3); add the api create-time DB validation; at create, snapshot
   `stepIds`->`tasks.run_list_snapshot` and fold `preAnswerDefaults`/`stepLoopLimitDefaults` into
   `tasks.preAnswers`/`tasks.stepLoopLimits` for static types.
- Phase-1b ROLLBACK (plain English), TWO regimes:
  - BEFORE any custom-typed task row exists: redeploy prior worker+api (buildRunList reverts to hardcoded),
    then re-cast the column: `ALTER TABLE tasks ALTER COLUMN type TYPE workflow_type USING type::workflow_type;`
    This SUCCEEDS because every value is still a built-in slug. Fully reversible.
  - AFTER a custom-typed task exists: the re-cast FAILS (custom slug is not an enum member). This is the hard
    irreversible boundary. Undo path: first remap/delete custom-typed rows
    (`DELETE FROM tasks WHERE type NOT IN (<enum members>)` or reassign), THEN re-cast. Because this destroys
    user tasks, treat "first custom task created" as the point of no cheap return and gate the feature behind
    a kill-switch (below) so 1b can be exercised with custom-type CREATION still disabled — giving a wide
    reversible window where only built-ins flow through the new code path.

Kill-switch: `CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED` (default false). When false: buildRunList still runs
data-driven for BUILT-INS (proven byte-identical), but the api create path rejects any non-built-in slug and
the New-Task form hides custom types. This lets 1b ship and bake on built-ins only; flipping the switch on is
the deliberate step that opens the irreversible door. Needs admin GET/PUT + toggle card (per the global-config
UI rule).

## 5. Boot/seed mechanism

New `packages/worker/src/step-engine/task-type-manifest.ts`, mirroring template-manifest.ts:304-343:
- `buildBuiltinTaskTypeDefs(registry)`: returns the 6 rows. For static/fragment slugs, `stepIds` =
  `registry.listByWorkflow(slug).map(d=>d.metadata.id)`; `contentHash` = sha256 of that ordered join.
  workflow/run_app carry `stepIds=null`.
- `syncTaskTypeDefinitions(db)`: for each built-in row, `insert ... onConflictDoUpdate` on `slug`, updating
  ONLY the builtin-owned fields (strategy, stepIds, contentHash, builtin=true) — do NOT clobber admin-tuned
  fields (enabled, sortOrder, displayName, description, preAnswerDefaults, stepLoopLimitDefaults). Use a
  narrow `set` clause. Never delete rows here (custom rows are user data; unlike the template cache this is
  NOT a full mirror-and-prune).
- CONSEQUENCE (must enforce): because the seed rewrites builtin `stepIds` on EVERY boot, a built-in's step
  SEQUENCE is registry-owned and MUST be read-only in the admin UI — otherwise an admin reorder is silently
  reverted on the next worker restart. Admins tune enabled/sortOrder/displayName/params on built-ins; to
  change a built-in's step sequence they FORK it into a new custom (static) type (clone stepIds into a fresh
  slug, builtin=false). This also keeps the byte-identical boot assertion meaningful (it only ever compares
  registry-owned builtin lists).
- Call from bootstrap.ts (after registerAllSteps, alongside :45 `syncTemplateManifestCache`), then run the
  byte-identical boot assertion.

Why boot-seed (not a migration INSERT): the step ids/order live in the worker's registry, exactly the reason
`syncTemplateManifestCache` runs at boot — api/web must read task types from Postgres without importing
worker generators. A migration can't compute `listByWorkflow` order. The seed is the DB-update mechanism
(idempotent upsert), satisfying "DB-only changes must be deployable".

Enable/disable interaction with the New-Task form:
- `GET /task-types` filters `enabled AND selectable` -> only enabled selectable types appear. The built-in
  auto-detect (onboarding-vs-workflow from onboarding status) stays for those two; an explicit picker lists
  the rest.
- In-flight tasks are immune: they read `run_list_snapshot`, never the `enabled` flag.
- Creating a task of a disabled type -> api 403 (the create-time definition lookup checks enabled).
- FLAG: disabling `onboarding` or `workflow` would break the core auto-detect product. Recommend the admin UI
  hard-warns on the two core builtins, or the seed marks them `enabled`-locked (admin may reorder/param but
  not disable). Custom + non-core builtins freely toggle.

## Invariant-break flags (design risks to enforce, not ignore)

1. FORWARD-WALK vs admin edit (SOLVED by 1a snapshot): without `run_list_snapshot`, an admin removing/reordering
   a step in a live definition mutates a running task's list -> findIndex -1 -> premature completion. Snapshot
   pins it. Required, not optional.
2. LOOP-CLOSURE for custom static lists (NEW constraint): a custom list that includes a step with a
   fixLoop/reviseLoop/restartLoop/fixLoopOnError hook but OMITS that hook's target step will jump to an absent
   step -> findIndex -1. execution-paths.ts:98-108 (PATH_REQUIRED_TARGETS) already encodes the workflow
   targets. Generalize it to a `STEP_LOOP_TARGETS` map and VALIDATE custom definitions at save-time (+ boot
   assert seeded rows): every loop-emitting step in the list must have its static target in the same list.
   reviseLoop/restartLoop targets that are computed at runtime (evaluate returns the id) cannot be statically
   proven — recommend EXCLUDING steps with dynamic-target loops from the custom-composable set. This is a real
   limit on "any registered step".
3. STEP COMPOSABILITY (scoping flag, do not fully solve): many steps assume pipeline prerequisites
   (07-phase-2-implement needs 01-worktree-setup; verify steps read env template/execution_path). Exposing all
   ~60 registered steps invites broken custom types. RECOMMEND a curated composable-step allow-list (or
   per-step `composable`/`requires` metadata) rather than the full registry, and treat the full-freedom
   version as out of scope for this half. Flag prominently so the parent scopes the admin UI.
4. pgEnum irreversibility after first custom task (SOLVED by kill-switch gating, #4): documented above.
5. computeGlobalStepIndex offset gap for custom slugs (cosmetic, run_seq authoritative): documented, accept.

## Exact file:line touch points

- database/schema/task-types.ts (NEW) + schema/index.ts barrel (add export).
- database/schema/tasks.ts:47-59 (leave enum defined), :108 (`type` enum->text, phase 1b), add
  `run_list_snapshot` column near :213.
- database/migrations/0092_task_type_definitions.sql, 0093_tasks_run_list_snapshot.sql,
  0094_tasks_type_to_text.sql (NEW; 0094 needs explicit `USING type::text`).
- worker/src/queues/task-queue.ts: ResolvedTaskContext :88-110 (+strategy/+snapshot); buildRunList :112-130
  (rewrite dispatch); resolveTaskContext :180-213 (load definition, drop `as WorkflowType`); buildRunAppRunList
  :146-178 UNCHANGED; all 4 findIndex callsites (:804,1185,1233,1394) unaffected by shape (still fed by
  buildRunList).
- worker/src/step-engine/task-type-manifest.ts (NEW; mirror template-manifest.ts:304-343).
- worker/src/bootstrap.ts:45 (add syncTaskTypeDefinitions + boot assert).
- worker/src/step-engine/steps/index.ts:20-30 (host the byte-identical assertion, sibling to the existing 3).
- worker/src/orchestrator/execution-paths.ts:98-108 (generalize PATH_REQUIRED_TARGETS -> STEP_LOOP_TARGETS for
  custom-list closure validation).
- shared/src/schemas/tasks.ts:3-8 + :66 (relax type to z.string; workflowTypeSchema kept for built-in typing).
- shared/src/types/index.ts:1 (WorkflowType stays a builtin alias; not the task.type authority).
- shared/src/config/config.service.ts:10+ and DEFAULTS ~:209 (add CUSTOM_TASK_TYPES_ENABLED).
- api/src/routes/tasks/index.ts:154-247 (create-time definition lookup + enabled/selectable check + snapshot +
  fold param defaults into preAnswers/stepLoopLimits).
- api/src/routes/task-types.ts (NEW public GET) + admin CRUD (new admin sub-route or extend admin.ts, mirror
  :318-346 GET/PUT toggle pattern; requireAdmin).
- api/src/routes/global-kb.ts:336 and upgrades.ts:395 (VERIFY only — they set built-in slugs that now must
  have a seeded definition row + a snapshot; add snapshot write or let resolveTaskContext legacy-fallback to
  definition.stepIds when snapshot is null).
- web/src/lib/api-client.ts:430 (relax WorkflowType to string) + web/src/app/(app)/tasks/new/page.tsx
  (:251-255,:329-335 keep builtin auto-detect; add custom-type picker fed by GET /task-types).
- worker/src/step-engine/step-runner.ts:1791-1802 (document custom-slug offset gap; no code change required).
```
```
