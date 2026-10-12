# Modular Haive — module system, data-driven task types, integrations (merged plan)

> **Approved 2026-10-12, not started.** Merges `serialized-chasing-thacker.md` (module system +
> integrations, "T") and `rippling-wibbling-puffin.md` + its half A (data-driven task types, "P").
> Both stay as design references; where this file disagrees, this file wins. Re-grounded against
> main @ 3313a5db8; analysis notes in the untracked `.claude/tmp/modularity/analysis/`.

## Context

Haive's extension points are static: task types live in 14 hardcoded sites, steps in a static
registry plus static shared lists, nav/routes/settings in code, integrations in a five-forge map.
T wants installable modules (nav, pages, settings, routes, steps, own DB, integration providers);
P wants admin-authored task types composed from a step catalog. Neither plan is independent: each
core stands alone, but the joints (module steps reaching the catalog, module-seeded task types,
dangling references, dead tasks, deactivation, step integration requirements) need both. Both
plans also got the same thing wrong — they assume the step registry is filled during `bootstrap()`;
it is filled lazily in `startTaskWorker` (`worker/src/queues/task-queue.ts:156-160`, `:3684`, after
`index.ts:66`). So: shared contracts first, three cores in parallel, joints last, distribution after.

## Locked decisions (user, 2026-10-12, plus earlier)

- P: authoring admin-only/global; built-ins migrated into data (all **11** types, incl. plan_build,
  plan_chat, advisory, plan_sequence, plan_merge — static, not selectable); Phase 3 bespoke code =
  prompt templates + vetted custom MCP tool only.
- T: rebuild-on-install; generic renderer + escape hatch; integration decisions 1-5 locked (one
  provider contract; MCP preferred, REST fallback presented as MCP; tokens never in the sandbox;
  per-user connections, admin-shared, explicit grants; write = one switch per user per integration).
- Custom task types may opt out of a repository (`requiresRepository=false`).
- Module-seeded task types sit behind their OWN switch `MODULE_TASK_TYPES_ENABLED`, separate from
  `CUSTOM_TASK_TYPES_ENABLED`; either switch's first non-built-in task crosses the one-way enum boundary.
- A module-seeded type may use non-composable internal steps; only `composableSteps` reach the palette.
- Reference module: core `/stats` MOVES into `modules/statistics`.
- **Integrations are declared-only and category-resolved (DI).** A step gets integration tools only
  if it declares a requirement; requirements name a CATEGORY (or pin a provider). Providers declare
  `categories[]`. Resolution per task and category: task override (task page Integrations section,
  "Also for my later tasks") > user preference ("Preferred by kind" tab) > admin install default >
  the only connected provider > required ⇒ create blocked with picker. Multi-account ⇒ account
  picker. A change on a running task applies from the next dispatch. Agents see the resolved
  vendor's OWN tools; deterministic code (module steps, `integration-op`) pins a provider; canonical
  per-category operations deferred. Repository grants are an ALLOW-LIST (restrict providers/accounts).
- Provider module deactivated ⇒ dependent step PARKS (reconnect banner); uninstalled/missing ⇒ task DEAD.
- GitHub OAuth client id: per-user and install-wide both kept permanently. Precedence: env var >
  user's own id > admin install row.
- Forge REST moves to an `@haive/shared` server subpath; the broker exposes forge tools to agents in v1.
- Distribution in scope in full (registry discovery, BuildKit secret, per-customer images, builder
  image, per-channel manifests), verified against a local registry as on 2026-09-09.

Driver defaults following from the above: P owns catalog sync and task-type seeding (single
writer; modules contribute entries); module-seeded rows deleted only on purge; provider ids
`module.<moduleId>.<id>` (P's `module.google.drive` example is wrong).

## Corrections to the source plans (do not re-derive)

- 11 task types, 104 registered steps (not 6 / ~60); next migration 0189.
- enum→text fails as written (`text = workflow_type`); index `tasks_one_live_upgrade_per_repo_idx`
  must be dropped and recreated in the same transaction (proved on a throwaway pg18).
- A missing step fails the task (not crash); the worse hazard is the forward walk (`:1591`, `:1988`)
  silently completing a task when the step id is absent — degrade must mark DEAD, never filter.
- api and web read static shared step lists (`shared/src/step-engine/types.ts:103,227,243,292`,
  `api/routes/tasks/_helpers.ts:1204`) — non-core steps need flags from data.
- `/integrations` has `use('*', requireAuth)` (`api/routes/integrations.ts:16`); the token-auth
  broker needs its own prefix. Rag token is `{taskId, exp}` without audience — the broker gets an
  audience-scoped `{taskId, taskStepId, cliInvocationId}` token.
- recharts + core `/stats` already exist; dev `tsx watch` never runs `prebuild`; dev node_modules
  volumes never see module deps; a COPY of a missing `modules/` fails (commit `modules/.gitkeep`);
  a frozen install with a missing module dir exits 0 (check must import a module dep in-image).
- ConfigService has a 30 s cache ⇒ the module active flag lives in Postgres. Install namespacing
  shipped ⇒ module DBs/images use `databaseName()` / `imageRepo()` (`shared/src/naming/index.ts`).
- Persona resolver lives in `worker/src/orchestrator/agent-isolation.ts`; fix-loop target also used
  at `07-phase-2-implement.ts:575` and `_prompt-defect.ts:94-98`; 7 stepId panel branches in
  `web/src/app/(app)/tasks/[id]/page.tsx` (:4119-4318).

## Execution protocol

`/opus-sonnet`: driver judges and commits; Sonnet builds from briefs; Full = harness agent +
builder; Light = builder writes controls first. Each task = one branch + PR, merge commit, reviewer
loop per `haive_pr_workflow`. Builds run in worktrees in parallel when files are disjoint; live
checks, smokes and browser checks serialize on the shared dev stack (`flock` on the full-suite
lock). Tasks touching `task-queue.ts` `handleCancelTask`/`runTaskJob`, `routes/tasks/index.ts`,
`tasks/[id]/page.tsx`, `step-banners.ts` rebase after peer PR #594 merges. Ledger:
`.claude/tmp/modularity/ledger.md`.

## P0 — shared contracts (serial; nothing runs beside it)

| id | change | weight | check |
|---|---|---|---|
| P0.1 | `@haive/shared` web-safe subpath: step-id grammar + `parseStepId` (`core` `^[0-9a-z_-]+$`, `module.<m>.<local>`, `custom.<def>.<slug>`), persona id grammar, provider id grammar; `ComposableStepEntry`; `IntegrationRequirement {id, category?|provider?, access, optional?}`; `IntegrationCategory` registry (core: rich-documents, spreadsheets, file-storage, mail, chat, issues, wiki, forge; module `module.<m>.<cat>`); `TaskTypeDefinitionSeed` | Light | unit tests; all 104 core ids parse as core |
| P0.2 | `bootStepEngine(db)` with fixed slots, called in `worker/src/index.ts` before queue starts: core steps → [module steps] → [custom steps] → catalog sync → type sync → asserts + dangling sweep. Zero behaviour change | Full | worker boots; registry identical before/after (dump ids+metadata); full worker suite green |
| P0.3 | `resolveRunList → {steps, unresolved[]}` + `markTaskDead` + nullable `tasks.dead_reason` (migration, declared last); guard the 10 call sites + stalled-redrive/boot-requeue so an unresolved step never walks/completes/fails | Full | unit tests per site with a fake missing id; no existing test changes |
| P0.4 | `step_catalog` table (every registered step: source, composable, title, workflowType, dispatchesCli, allowSkip, providerSensitive, cliRoles, entry jsonb; mirror semantics) + `syncStepCatalog`; api/web read skip/CLI/provider flags and upcoming-CLI from it, not static lists | Full | api+web flags identical for every core step (capture before/after); Skip/CLI picker browser check |

## Track P — data-driven task types (after P0)

- **P1** migrations 0189+: `task_type_definitions` (slug, displayName, description, runListStrategy
  enum, stepIds, preAnswerDefaults, stepLoopLimitDefaults, fixLoop, enabled, selectable, builtin,
  `source`, `requiresRepository`, sortOrder, contentHash) + `tasks.run_list_snapshot`. Full. Check:
  migrate twice on scratch DB, schema-parity.
- **P2** seed 11 rows in the `bootStepEngine` slot; boot assert static rows == `listByWorkflow`;
  upsert registry-owned fields only. Full. Check: unit test all 9 static slugs; admin-tuned columns
  survive reboot.
- **P3** api create path: definition lookup (404/403/not-selectable) at all 4 insert sites
  (`tasks/index.ts:632`, `upgrades.ts:983`, `global-kb.ts:596`, `lib/spawn-plan-task.ts:37`);
  snapshot written for static types. Full. Check: `plan_merge` via POST /tasks still refused.
- **P4** `buildRunList` dispatches on strategy over `resolveRunList`; legacy fallback one release.
  Full. Check: old==new run list for every type × execution path × containerTool; smoke:workflow +
  smoke:onboarding on scratch Redis/DB.
- **P5** migration: drop index, `ALTER … TYPE text USING type::text`, recreate, guarded; relax
  shared/zod/web unions to builtin alias | string. Full + fresh tester. Check: migrate twice on a
  copy of the dev dump; reverse re-cast dry-run; upgrade-single-live smoke; parity.
- **P6** `CUSTOM_TASK_TYPES_ENABLED` + `MODULE_TASK_TYPES_ENABLED` with admin toggle cards. Light.
- **P7** per-type traits from data: `requiresRepository` replaces `REPO_OPTIONAL_TASK_TYPES`
  (`task-scratch.ts:29`), labels (fixes missing `plan_sequence`/`plan_merge` in
  `web/(app)/tasks/page.tsx:34` and the "twelve members" comment in `shared/stats/task-class.ts:5`),
  stats class, revive lock, step-index offsets. Full.
- **P8** `resolveFixLoopConfig` (definition `fixLoop` ?? today's constants) at task-queue `:1809`,
  `:2010`, `07:575`, `_prompt-defect.ts`. Full. Check: smoke:fix-loop unchanged; null target ⇒
  named failure.
- **P9** `STEP_LOOP_TARGETS` (+08d2, plan-chat/merge self; excludes runtime 09_6) + shared
  composition validator; boot-asserts seeded lists. Light.
- **P10** admin `/admin/task-types` CRUD + catalog + public `GET /task-types` + shared
  `resolveTaskTypeAvailability` (pure). Full.
- **P11** web: admin task-types page + composer (BundleComposer model) + New Task type select.
  Full, browser at phone/tablet widths.
- **P12** `UiPanelSpec` + `resolveStepPanels` + `BUILTIN_STEP_PANELS` replacing the 7 branches.
  Full. Check: screenshot + DOM capture before/after for each panel step.
- **P13** prompt-template synthetic steps + `{{agent:<id>}}` markers + start-time persona check.
  Full.
- **P14** custom sandboxed MCP tool (vetted action registry, own route prefix). Full.
- **P15** creator mode (given the step catalog + persona catalog + category registry). Full.

## Track M — module system (after P0; parallel with P and I)

- **M1** `modules/*` glob + `modules/.gitkeep`; `scripts/gen-modules.mjs` (empty registries) as
  predev + prebuild and in `build-libs.sh`; Dockerfiles copy module package.jsons preserving dirs,
  build `--filter './modules/*'`, copy dist; dev volumes/`dev.sh` rebuild path. Full. Check: build,
  typecheck, all three production images with zero modules; fixture module's third-party dep
  importable inside the built worker image; dev stack restarts green.
- **M2** `ModuleManifest` (incl. `composableSteps`, `taskTypes`, `integrations`, `categories`),
  `DashboardSpec` at a web-safe leaf. Light.
- **M3** api loader under reserved `/m/<id>`, requireAuth→requireAdmin composed, prefix collision
  check; `GET /modules`; `GET/PUT /m/:id/config`; public ConfigService seed-if-absent. Full. Check:
  401/403/200; config round-trip.
- **M4** worker loader in the `bootStepEngine` slot: ids `module.<m>.<local>`, workflowType
  `module.<m>`, catalog entries with `composable` from manifest (joint J1), jobs, `ensure-schema` in
  `databaseName('module', id)` under advisory lock, config seed, boot report. Full. Check: fixture
  skippable step shows Skip; duplicate id fails boot by name; ensure re-run no-op.
- **M5** `GET /admin/modules/loaded` (api + worker reports). Light.
- **M6** web nav + generic settings pages from `GET /modules`. Full, browser admin + user.
- **M7** `DashboardRenderer` + `/m/[moduleId]/[[...page]]`. Full.
- **M8** escape-hatch `./web` codegen; check in the PRODUCTION web image. Full.
- **M9** move core `/stats` into `modules/statistics` (routes + escape-hatch pages; `/stats`
  redirects). Full. Check: harness captures every stats endpoint JSON and chart DOM before; byte-equal
  after; Playwright nav→page→data smoke.
- **M10** lifecycle L1: `modules` table (intent, source local/git/registry, entitlementId, missing),
  loaded-vs-intent diff, Modules admin tab. Full.
- **M11** L2: four states; active flag in Postgres; deactivate ⇒ routes 404, nav hidden, steps not
  offered (J5); `pnpm module add/remove` + `./teardown` purge. Full.
- **M12** L3: preflight listing dependents (snapshot `module.<m>.*` ids + grants, J9) with
  urgent/graceful via maintenance primitives (`api/routes/maintenance.ts:79-175`). Full.

## Track I — integrations (after P0; parallel with P and M)

- **I1** shared `IntegrationProviderSpec` (+ `categories[]`) and migration: provider configs,
  connections, grants (task / repository allow-list), user settings (write switch),
  category preferences (user + admin default), calls. Full.
- **I2** forge REST → `@haive/shared` server subpath; five forges registered as core providers
  (category `forge`); `resolveForgeProvider` signature kept (callers: `12-worktree-cleanup`,
  `pr-poll-queue`, `resolve-forge-context.ts:129`). Full. Check: forge tests + workflow smoke open PR
  and poll unchanged.
- **I3** OAuth broker (connect POST, callback, refresh under per-connection lock, disconnect/revoke),
  device flow generalised, GitHub client precedence env > user > admin; `settings/integrations`
  connection list + write switch; admin Integrations tab (provider enablement, OAuth clients). Full.
  Check: replayed/foreign state refused, nothing written; 2 concurrent refreshes = 1 vendor call.
- **I4** category resolution: "Preferred by kind" tab, admin defaults, repository allow-list, task
  page Integrations section with per-category override + "Also for my later tasks" (mirror
  `task_step_cli_choices`), resolution writes task grants. Full, browser.
- **I5** `haive-integrations` broker: own prefix, audience token `{taskId, taskStepId,
  cliInvocationId}`, `resolveMcpSurface` field, tool list built per request from the STEP's declared
  requirements (vendor tools of the resolved connection; writes only with switches on),
  `integration_calls`, usage-panel group, `HAIVE_MCP_SERVER_NAMES` + pin test, forge tools. Full.
  Check: no token in sandbox env/files/MCP config; undeclared step lists none; write refused after
  mid-task flip; panel counts = rows on claude and codex.
- **I6** module-contributed providers and categories (needs M3/M4, I3). Full.
- **I7** `modules/integration-google` (Drive, Docs, Gmail; REST default, remote MCP opt-in). Needs
  a real GCP OAuth client from the user — blocked until provided.

## Joints (after their inputs)

- **J2** module-seeded task types through P's sync, `source='module:<id>'`, behind
  `MODULE_TASK_TYPES_ENABLED` (needs P2, P6, M4).
- **J3** dangling references: availability in create, `GET /task-types`, composer — missing step,
  missing/deactivated module, uninstalled provider, each with a named reason (needs P10, M10, I1).
- **J4** dead tasks: `deadModuleBanner` top+bottom+lists, api refuses advancing actions (cancel
  stays), boot revive when steps resolve (needs P0.3, M10).
- **J6** step integration requirements: `integrations` on catalog entries and prompt templates,
  create-time pickers per unresolved required category, `{{integration:<id>.account}}` (needs I4,
  I5, P11, P13).
- **J7** reconnect park, single owner keyed on connection `status`; deactivated provider parks,
  uninstalled ⇒ dead (needs I5, J6).
- **J8** composer shows each requirement's category, resolvable providers and install state.

## Track D — distribution (after M1, M4, M10)

- **D1** `@haive-module/*` dependency discovery in `gen-modules.mjs`, `.npmrc` scope, BuildKit
  secret mount in api/worker Dockerfiles. Check: `docker history` shows no token; revoked token
  fails install and leaves the running version.
- **D2** per-customer api+worker image build (base release + entitled modules) and channel publish.
  Check vs local registry: a customer-A image's `/admin/modules/loaded` lists only A's modules.
- **D3** `haive-builder` image + one-shot builder service (clones git modules, runs codegen, builds
  api+worker, tags for the updater); per-customer builder variant. Check: own-module install on a
  published-image install with no host toolchain.
- **D4** Modules page git/registry install sources driving D1/D3; token envelope-encrypted.

## Peer hand-overs (from session git-data-readonly-containers)

- Task #2 FNF[cancel-fence] (#262): one lock/epoch shared by cancel's sandbox listing and cli-exec
  docker create. Light, after #594.
- Task #3 DECIDE (#259): Cancel vs unpushed local merge on base — ask the user after #594 merges.

## Order and parallelism

P0.1 → P0.2 → P0.3 → P0.4 (serial). Then P, M, I run in parallel (one builder each at a time).
Joints as inputs land (J2 after P6+M4; J3/J4 after M10; J6-J8 after I5+P13). D after M10.
I7 waits on the GCP client. Final: T's verification items 1-26 and P's per-phase checks re-run
end to end.

## Rollback

- P0/P1-P4/M*/I1-I5: additive; revert the PR; new tables unread by old code.
- P5 before any custom/module task exists: re-cast `USING type::workflow_type` (enum kept defined).
  After either switch creates one: irreversible without remapping rows — both switches default off.
- M9 stats move: revert restores core `/stats`; module removal returns to zero-module state.
- I2 forge move: revert restores worker-only forge code; `resolveForgeProvider` signature unchanged.

## Verification (end to end)

Per task: its check above, run by the driver from the harness. At milestones, in the running app
via Chrome MCP (admin and normal user, phone/tablet widths):
1. Zero modules: build, typecheck, images, dev stack green; every built-in task type runs identically.
2. `modules/statistics` installed: stats pages and endpoints byte-equal to the pre-move capture.
3. A custom static type composed in the UI runs, renders panels via `uiPanels`, fix-loops.
4. A module step + module-seeded type: selectable only with the module switch on; deactivate
   hides it with a named reason; removal + reboot makes its tasks DEAD and cancel-only; reinstall revives.
5. Integrations: a prompt-template step declaring `rich-documents` resolves to the user's preferred
   provider, task override switches it for the next dispatch, the agent lists only that vendor's
   tools, undeclared steps list none, panel counts match `integration_calls`.
6. Distribution: local-registry per-customer image carries only entitled modules; no token in
   image history; builder installs an own module on a published-image install.

## Docs at close

New topic files `docs/architecture/{task-types,modules,integrations}.md` indexed in `AGENTS.md`;
statistics.md updated for the module move; plan README rows.
