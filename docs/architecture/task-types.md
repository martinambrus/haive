# Task types

A task type is a row of `task_type_definitions`, not a branch in code. The twelve built-in types
(`onboarding`, `workflow`, `env_replicate`, `onboarding_upgrade`, `kb_author`, `run_app`, `plan_build`,
`plan_chat`, `advisory`, `plan_sequence`, `plan_merge` and `type_draft`) are seeded from the step
registry at every worker boot; an admin composes
custom types from the step catalog in the task-type editor; a module seeds its own. This file covers
how a type is stored, seeded, created, run and edited, the prompt-template steps an admin type can
carry, the custom tools those steps may declare, and the server side of creator mode. Dead tasks are
in [Worker restarts](worker-restarts.md), module states in [Modules](modules.md).

## Storage

`task_type_definitions` (`database/src/schema/task-types.ts`): `slug` (primary key), display name,
description, `run_list_strategy` (`static`, `workflow_paths`, `run_app_modes`), `step_ids` (static
types only), `pre_answer_defaults`, `step_loop_limit_defaults`, `fix_loop`, `enabled`, `selectable`,
`source` (`builtin`, `admin` or `module:<moduleId>`), `requires_repository`, `sort_order`,
`content_hash` and `prompt_steps` (declared last).

Each source owns its own columns, and every upsert carries `setWhere source = <own source> AND some
owned column IS DISTINCT FROM excluded`:

| source        | written by                        | owns on re-sync                                                                          | an admin may PATCH                                                                                            |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `builtin`     | the worker's boot seeder          | strategy, step ids, content hash, source, selectable, requires repository                | display name, description, sort order; `enabled` only on a selectable type other than onboarding and workflow |
| `module:<id>` | the boot seeder from the manifest | strategy, step ids, description, defaults, selectable, requires repository, content hash | enabled, sort order, display name                                                                             |
| `admin`       | the admin api only                | —                                                                                        | every field of `taskTypeUpdateSchema`                                                                         |

So a row held by another source is never overwritten, and an unchanged row is never rewritten: its
`updated_at` is the version the editor's save precondition reads, and a no-op rewrite at every boot
made every open editor answer 409 after a worker restart. Built-in rows are never deleted. The seeder
never deletes a module row either: a seed the module stopped declaring becomes `selectable = false`,
and only a module purge removes rows (keeping types still used by tasks). An admin row is deleted only
by `DELETE /admin/task-types/:slug` while no task of that type exists.

`content_hash` (sha256 of strategy and step ids) is read only by the seeder's own "did anything change"
test. `fix_loop` is written by nothing today and only its `targetStepId` is read.

On `tasks`: `type` is `text` (it was the `workflow_type` enum until 0193); `run_list_snapshot` pins a
static type's step ids at create (null for the dynamic strategies, for tasks created before snapshots,
and for a built-in created before the worker seeded its row); `custom_steps` pins the type's prompt
steps that the snapshot uses; `dead_at` / `dead_reason` mark a dead task. Only the task INSERT sites
write the two pinned columns — no UPDATE of either exists — so editing a type never reaches a task that
already exists, and Retry reuses the pin.

**The enum stays.** A plain `ALTER … TYPE text` failed (`text = workflow_type`) because the partial
unique index `tasks_one_live_upgrade_per_repo_idx` compares the column with an enum literal; 0193 drops
the index, casts and recreates it in one guarded block. The `workflow_type` enum stays defined: it is
the list of built-ins the seeder, the admin route and the create helper read, and it is what the 0193
rollback casts back to. So a new built-in still needs `ALTER TYPE workflow_type ADD VALUE` (0205 did
that for `type_draft`), and the rollback works only while every task row is a built-in type.

`step_catalog` mirrors every registered step (one transaction at boot: upsert the registered ones,
delete the rest): source, title, workflow type, whether it dispatches a CLI, skip, provider sensitivity,
CLI roles, `composable` and the composable `entry`, step index. Prompt steps are never in it.

## Ids

Core step ids `^[0-9a-z_-]+$`; module steps `module.<moduleId>.<local>`; prompt steps
`custom.<typeSlug>.<stepSlug>`. An admin type slug is `^[a-z0-9][a-z0-9-]{0,63}$` — no underscore — and
a module's stored slug is `<moduleId>__<local>`, so the two can never collide, no built-in holds `__`,
and the module slug has no dot (the web proxy skips dotted paths). `new` and `catalog` are reserved
(the create page and `GET /admin/task-types/catalog`, which is matched before `/:slug`). A prompt
step's id and a module seed's step ids are at most 128 characters, the width of `task_steps.step_id`; a
module's own step id is not checked when it registers (`step_catalog.step_id` is 256 wide).

## Boot

`bootStepEngine(db)` runs right after `bootstrap()` and before any queue worker starts:

1. register every core step, then the static-list asserts (provider-sensitive, CLI-dispatch,
   skippable, closed path sets);
2. assert the core composable catalog (`CORE_COMPOSABLE_STEPS`, 34 entries);
3. register module steps — after the static asserts, so the shared static lists stay authoritative for
   core ids only;
4. `syncStepCatalog`;
5. `ensureModuleSchemas`, then `syncModuleIntent` — before the seed, so a freshly installed module's
   types do not read `module-missing` during boot, and after the schemas, so a failed schema bootstrap
   is never recorded as loaded;
6. `syncTaskTypeDefinitions`: built-ins, then module seeds, in one transaction;
7. publish the worker's boot report (including each module's seeded, conflicting and invalid types).

There is no boot slot for prompt steps: they are built per task from the task's pinned copy (below).
Before P0.2 the registry was filled lazily when the task worker started, so nothing at boot could read
it; `startTaskWorker` still registers the core steps, which is harmless because the real worker always
ran `bootStepEngine` first.

**Built-ins.** The built-in list is the `workflow_type` enum. A static built-in's step ids are
`registry.listByWorkflow(slug)`; `workflow` uses `workflow_paths` and `run_app` `run_app_modes`.
Selectable built-ins: onboarding, workflow, onboarding_upgrade, run_app. After the upsert, in the same
transaction, every built-in slug must be held by a `builtin` row with the registry's step list, or the
worker does not boot. The upsert has already rewritten every `builtin` row that differed, so the check
exists to catch a slug held by another source: a custom type holding a slug that a later release turns
into a built-in fails the boot loudly instead of being converted.

**Module seeds.** Static strategy only; steps are core or the module's own `module.<id>.*`, never a
prompt step or another module's step, never repeated (a repeated step made the queue hand the step to
itself forever). Those rules are manifest checks: a seed that breaks them fails its manifest, and the
worker does not boot. A seed is also checked like an admin type — defaults always, composition only
when every step has a composable entry (an internal step's needs are unknown). A seed that fails those
checks is logged, reported and not written; a slug held by another source is left alone and reported.
Neither of those two fails the boot — an unbootable install is worse, and the other row is not the
module's to change.

**Module steps.** Registered as `module.<id>.<local>` with workflow type `module.<id>`, so a module step
can never shadow a core step or slip into a built-in run list. Composable entries must name the
module's own steps; a `reviseLoop` step cannot be composed yet; a looping step must target
`07-phase-2-implement`, because the runner routes `loop_back` there whatever an entry says.

**Unseeded databases** (smokes, a fresh install before the first worker boot): the run path falls back
to the registry for a built-in with no row; the create path accepts only the four generic built-ins
(`workflowTypeSchema`) on the generic route; the api answers step flags from the static shared lists
without caching that answer; admin create answers 409 until the catalog is synced, and so does an
edit that touches steps, `requiresRepository`, prompt steps or defaults.

## Creating a task

Every task INSERT is in the api, and each calls `definitionForCreate(handle, slug, {generic})` on the
same handle first: `POST /tasks` (including upgrades), the upgrade rollback, KB enrichment, the plan
spawners and the creator drafts route. It reads the definition `FOR SHARE` (an admin DELETE takes
`FOR UPDATE`, so a type cannot vanish between the read and the insert — where the read is in the insert
transaction: KB enrichment and three of the five plan spawns read on the pool, which is safe only
because their built-in types cannot be deleted) and the module rows the type
uses `FOR KEY SHARE` (a deactivation's `FOR UPDATE` waits and then counts the new task, while the boot's
non-key updates of the same rows do not conflict — `FOR SHARE` blocked the boot's intent sync).

**Availability** (`resolveTaskTypeAvailability`, pure, shared by create and every list), first match
wins: `disabled` → `not-selectable` (generic route only) → `custom-types-off` → `module-types-off` →
`module-missing` → `module-deactivated` → `missing-step` → `invalid-composition`. `module-missing` comes
before `missing-step` so a removed module is named instead of "a step is not installed". Without a
synced catalog the step and composition checks are skipped. Over HTTP: disabled, not selectable and the
switches are 403; the module reasons, a missing step and a bad composition are 409 naming what is wrong.
The switch over reasons ends in an exhaustive `never`, so a new reason cannot fall through to a create.

**Traits returned with the definition:** the run list snapshot (a non-built-in static list that
dispatches a CLI and has no canary gets `00-model-health-workflow` prepended; a prompt step counts as a
CLI step even with an unsynced catalog); the prompt steps the snapshot uses, copied as stored; preset
answers and loop limits for non-built-ins (request limits win); `simplifyCode` (a non-built-in with
`07a-code-simplify`); `takesRootLock` (workflow, or a list with `00a-sync-base`, `01-worktree-setup` or
`12-worktree-cleanup`); `pinsDatabase` (a non-built-in with `01c1-restore-database` or
`11g-save-database`); `restoresDatabase` (a non-built-in static list with `01c1-restore-database`);
`requiresRepository`. Module-seeded types get every trait an admin type gets
except prompt steps.

`POST /tasks` reads the definition twice on purpose: the preflight decides the lock, pin and repository
rules before the transaction (400 when a type that requires a repository gets none, built-ins included);
inside the insert transaction the locked read admits, and if a trait the preflight decided on moved in
between (`takesRootLock`, `pinsDatabase`, `restoresDatabase`, `requiresRepository`, `repoOptional`) the
answer is 409 "The task type changed while this task was being created; try again" rather than a silent
retry. Any other edit in that window (run list, prompt steps, defaults, `simplifyCode`) is not refused: the
task takes the values of the locked read. A
repo-optional type records `metadata.anchorRepositoryId`, which is how the worker decides a task is
repo-less.

**The two switches.** `CUSTOM_TASK_TYPES_ENABLED` and `MODULE_TASK_TYPES_ENABLED` (Admin, cards backed by
`GET|PUT /admin/config/task-types`) both default off and gate creation only: built-ins are never
affected, a switch can be turned off again, and running tasks keep running (the run path reads no
switch). They are separate so an admin can allow a paid module's types without opening the composer.
The first task of a non-built-in type makes the 0193 rollback impossible (it re-casts to the enum).
Rows behind an off switch stay listed in `GET /task-types` as unavailable with the reason, so the New
Task form can say why.

## Running a task

`buildRunList` dispatches on the strategy: `run_app_modes` builds the run-app list, `workflow_paths`
orders the workflow steps with the environment prelude for the execution path, `static` resolves the
snapshot (`resolveRunList`).

**A missing step is never filtered out.** `resolveRunList` returns the steps and the unresolved ids, and
an unresolved step marks the task dead (`markTaskDead`). Filtering made both forward walks read "no next
step" and COMPLETE the task, reaping its containers and greening its plan node. A snapshot-less task
keeps the live registry list. `custom.*` ids resolve from the task's pinned copy, everything else from
the registry. The dead-task contract (boot reconcile, revive, admission, display, the api's 409
`task_dead`) is in [Worker restarts](worker-restarts.md).

**Fix loops.** The target is the definition's `fix_loop.targetStepId`, else `07-phase-2-implement`, and
any target other than 07 fails, because only 07 reads the recorded diagnosis. `routableFixLoopTarget` is
the only router; an unroutable target fails the task by name (`fix_loop.unroutable`) before any reset —
before, a run list without 07 ran 07 off-list and then completed the task.

**Composition** (`validateComposition`). A `ComposableStepEntry` declares what a step `requires`
(tokens with a reason), `provides`, `precedes`, `removes`, `entails`, its loop target and whether it
`closes` the run. The walk starts with `repository` unless the type does not require one; issues are
`unknown-step`, `unmet-need` (no EARLIER step provides it), `too-late`, `unfulfilled`,
`missing-loop-target`, `duplicate-step`, `loop-after-closing` and `empty`. `repository` is implicit: no
step can provide or remove it, so a module step cannot fake a repository. Built-in seeded lists are not
composition-checked at boot; a guard test (`worker/test/composable-core.test.ts`) asserts that the
composable steps of the shipped environment and workflow orders raise no ordering issue (`too-late`,
`loop-after-closing`, `missing-loop-target`, `duplicate-step`), so an ordering rule cannot contradict
the shipped workflow. Needs and provides are not guarded that way: a need a non-composable step
provides would read as `unmet-need` once that step is filtered out. There is no `STEP_LOOP_TARGETS`
table: loop targets live on each entry. `validateTaskTypeDefaults`: every preset or loop-limit key must
be a step of the type, and a loop limit only on a `loopBudgetEditable` step (1–50).

**Traits from data.** `requiresRepository` is the column; repo-less tasks get a secret-masked scratch
workspace. List and detail carry `typeLabel` (the display name), so an admin rename shows everywhere.
Statistics put unknown and custom slugs in `other`. Worktree gates (the terminal, the Editor tab, the
upcoming-CLI list, completion release) read the snapshot. Step flags come from `step_catalog` (cached
30 s, never caching the static fallback); a pinned prompt step dispatches a CLI and cannot be skipped.
Beyond a step's own `allowSkip`, only `01-worktree-setup` is skippable from the run list: always on
`run_app`, and on a snapshot task when the composition stays as valid without it.

## The admin api and the editor

`GET|POST /admin/task-types`, `GET|PATCH|DELETE /admin/task-types/:slug`, `GET
/admin/task-types/catalog` (admin); `GET /task-types` (anyone signed in: enabled and selectable rows,
with availability and public traits). Every write is audited (`task_type.create`, `update` with the
field list, `delete`).

- **Create** runs, each stage a 400 with `issues`: built-in slug (409) → strict schema → slug taken
  (409) → catalog synced (409) → prompt steps → composition → defaults.
- **Update** reads the row `FOR UPDATE`; a stale `expectedUpdatedAt` (compared as Dates: milliseconds
  against the column's microseconds) answers 409 `task_type_changed` with the current row and writes
  nothing; a PATCH without it still works. Removing a step prunes its preset and loop limit unless the
  body sends the map. Composition and prompt steps are re-checked only when the body touches step ids,
  `requiresRepository` or prompt steps — a flat edit saves even while the composition has issues.
- The editor sends `expectedUpdatedAt`, shows Reload on a 409, sends only changed fields, guards
  unsaved changes, and takes the fields it may edit from the api's `editableFields` so the web never
  copies the rule. The composer validates live with the same shared validators the api runs.
- **New Task** offers Workflow (onboarding or workflow, inferred) and Run the app, then every other row
  of `GET /task-types` except `onboarding_upgrade`, unavailable ones disabled with the reason in words.
- **Step panels** (`UiPanelSpec`, `BUILTIN_STEP_PANELS`, `resolveStepPanels`) are a web table keyed by
  step id: a custom type reusing a core step gets its panels; module and prompt steps get none.

## Prompt-template steps

An admin type may carry prompt steps (`prompt_steps`, keyed by the step slug; never on built-in or
module rows). Each is `{slug, title (≤512), description?, template (≤16 KiB), paramFormSchema?,
capabilities (tool_use, file_write, vision), tools (≤8), timeoutMs (60 s–30 min), agentPool '*'}`. No
field can turn agent rules, the MCP surface or tools off: a prompt step gets agent rules whenever the
install's agent-rules switch is on, and always gets the containment lines.

**Pinned raw, parsed per tool.** `custom_steps` holds the entries as stored; readers parse tools one by
one and name a bad tool in `invalidTools` while the step survives. A whole-entry parse would drop the
step when a release tightens one tool bound — and a task whose current step is missing goes dead.

**The worker synthesises each prompt step per task** from the pinned copy (memoised per task and id, at
most 256), never from a registry: a registry keyed by id cannot hold two versions of one id for two
tasks, and a template saved after boot is unknown to it. Detect reads the task title and description and
the output of the latest done row of every quoted step at a round no later than the current one (a
retried older round could otherwise quote its future). Apply stores the reply read back from
`cli_invocations` by invocation id, so a later quote sees the exact reply.

**Tokens:** `{{task.title}}`, `{{task.description}}`, `{{field:<id>}}`, `{{agent:<id>}}`,
`{{step:<stepId>}}`; `{{integration:…}}` is refused ("not supported yet"). The renderer makes one pass
and never rescans a value; a value mid-line is collapsed to one line, and a `{{step:}}` quote must sit
on its own line. Quoted step output is fenced; field values, the title and the description are not.
Every value is capped: each quote or other value at most 16 KiB, all quotes 64 KiB, all other values
64 KiB. Any `[[HAIVE_` overlapping a value and any leading `<haive_` opener is broken, so a value cannot
forge a marker or a preamble block. The save check (`validatePromptStep`, `checkPromptSteps`) refuses
unknown tokens, undeclared fields, a persona or a file-writing step on a repo-less type, a step quote
that is not earlier, not on its own line or not quotable, reserved markers, a missing or orphan entry,
and the size and range limits. A step is quotable only when its stored output is purely agent-authored
(a catalog entry, core or module, marked `agentAuthoredOutput`, or another prompt step of the type): a
quote is fenced as
untrusted agent text, and fencing a person's words (gate feedback, a typed command) would tell the next
agent to ignore them.

The prompt is the fence legend (when anything was quoted), the rendered template, and the containment
lines — `REPO_IS_DATA_ACTING_LINES` for a file-writing step, else the ANSWER variant, since a prompt step
has no findings channel. Personas, house rules for prompt steps and the start-time persona check are in
[Prompt containment](prompt-containment.md) and [Global knowledge base](global-kb.md): only the
step's own template ids resolve, dispatch fails closed on a missing persona, and the start check only
records `agent_persona.unresolved` (a persona may exist only on the base branch).

## Custom tools

A prompt step may declare up to 8 tools — `http-get` and `rag-query` — stored on the step and pinned
with it.

- **Wiring** (worker). Before a prompt step with tools dispatches, the runner (`resolveCustomTools`)
  re-checks the pinned tools against today's save rules that do not depend on the task type
  (`pinnedToolsFailure`: a release that tightened a bound fails the step as `custom-tool-invalid`, naming
  the tool). It validates with `requiresRepository: true` because the type's trait is not known there,
  so a `rag-query` scope a repository-less type could not save is not re-checked; nor is it at the call
  route. The runner then checks the install switch `CUSTOM_MCP_TOOLS_ENABLED` and
  `CONFIG_ENCRYPTION_KEY`; each failure names its fix. The dispatch
  requires a CLI that can host MCP servers (`requiresMcp`), and fails by name when no enabled one can.
  The cli-exec resolver repeats the pinned-tool check for a run executed later, signs a `custom-mcp`
  token for that task, step and invocation (valid for the run's timeout plus a grace) and mounts three
  sandbox files: the `haive-custom` server script (`/haive/haive-custom-mcp.mjs`), the tool list
  (`/haive/haive-custom.tools.json`: name, description and the input schema the api also checks) and
  the token (`/haive/haive-custom.token`) — never an environment variable. A run naming custom tools
  fails (`custom-tools-unwired`) when their server could not be added to the CLI; a best-effort server
  failure elsewhere lets the run carry on.

- **Authoring and the switch.** An administrator adds tools in the prompt-step editor's Custom tools
  section (action, name, description, then the URL and query parameters or the scope and result count,
  and typed parameters); a new tool starts with the schema defaults, and switching its action keeps the
  name and description. The editor shows no timeout or response cap: new tools take the defaults, and a
  stored tool outside today's range is fixed by removing and adding it again.
  `GET /admin/task-types/:slug` carries `promptStepIssues`, the save checks run over an admin type's
  stored prompt steps (empty for other rows and while the step catalog is unsynced), so a stored tool
  that no longer passes the schema is named on load as `tool-no-longer-valid`.
  `GET|PUT /admin/config/custom-tools` reads and writes `CUSTOM_MCP_TOOLS_ENABLED` (default on; the
  "Custom tools" card on the admin page), and every PUT records `config.custom_tools` with
  `{from, to}`.
- **Schema** (`custom-tools.ts`): at most 10 typed params per tool, names matching `TOOL_NAME_PATTERN`,
  reserved names `rag_search`, `ddev_status`, `ddev_logs`, `ddev_restart`. `http-get`: an https URL of
  at most 2048 characters with `{name}` placeholders in the path only, a public DNS host (no IP literal
  in any form, no single label, no `.local`/`.internal`/`.localhost`), no userinfo or fragment, no
  control character, whitespace or backslash; every param used exactly once, in the path or in the
  tool's `query` list; descriptions and enum values with no control or invisible characters; GET only,
  1–30 s timeout, 1–64 KiB response cap. `rag-query`: scope project, global or all (project and all refused on a repo-less type),
  1–20 results. The same param list produces the inputSchema the agent sees and the strict schema the
  api checks; `customToolUrl` refuses a URL that would leave the pinned origin or path prefix.
- **`POST /custom-mcp/call`**, in order: a 64 KiB body limit before the token is read; a `custom-mcp`
  task token carrying the step and the invocation (401 otherwise); a live invocation of that task and
  step (401 `invocation-not-live`, no row); the tool declared on that step of that task's pinned copy
  (403 `undeclared-tool`; a name the agent chose is never stored); the kill switch (403
  `switched-off`); strict arguments (400); for `http-get`, the pinned tool re-validated (403
  `tool-invalid`), its URL built from the arguments (400 `invalid-arguments`), and the run's network
  policy `full` (403 `egress-restricted`). Every refusal past the liveness check is a claimed
  row; the budget (50 calls per invocation) is claimed under
  `pg_advisory_xact_lock('custom-mcp-budget:'||invocation)`, and at 50 the answer is 429 with nothing
  written — before the claim rows, parallel calls overshot to 57. `custom_tool_calls` never stores an
  argument or a result, and the agent-facing message never carries the cause (it could name a
  compose-network address).
- **The egress guard** (`egress-guard.ts`): an IP literal is refused before any lookup; names resolve
  with c-ares, not getaddrinfo (a stalled getaddrinfo pins a libuv threadpool slot no deadline can take
  back — MEASURED 19.9 s vs 11 ms behind 8 stalled calls), with the deadline split across the nameservers;
  the connect-time lookup refuses the whole answer if any address is blocked (the v4 rules repeated
  inside NAT64 and 6to4, IPv4-mapped addresses matched as v4); a fresh agent per request, no redirect, no
  proxy, no credential, `Accept-Encoding: identity`, a media-type allow-list (a missing Content-Type is
  refused), a byte cap and one deadline for the whole call. Only a test may swap the resolver.

## Creator mode

`type_draft` is a hidden built-in: static `["01-type-draft"]`, not selectable, no repository, not gated
by the custom switch (its source is builtin), created only by `POST /admin/task-type-drafts`. Draft
tasks are listed in the task list like any other task (a product decision).

- **The step** reads the composable catalog without deactivated modules' steps, Haive's own persona
  specs, every taken slug except the one being edited, and the conversation from its task events. It
  runs with no MCP surface, no agent rules, no repository and no egress, and asks for no built-in tools
  (`disableTools`). Only the adapters that set `supportsDisableTools` (claude-code, grok, openrouter,
  muse, zai and ollama) drop them; codex, gemini, amp and antigravity keep their file, search and shell
  tools inside that empty sandbox, and the dispatcher's no-tools line is withheld from their prompt
  (`dispatcher.ts`, `noBuiltInTools`). The admin's messages are never
  fenced, the drafts and its own earlier replies are. A blank message ends the conversation; an invalid
  draft gets one automatic repair pass. Its only database write is task events — nothing is saved to
  `task_type_definitions` until an admin presses Save in the editor.
- **What a draft may carry** is a positive list: `PROMPT_STEP_DRAFTABLE_KEYS` (slug, title, template,
  capabilities, timeoutMs) and the top-level keys slug, display name, description, requires repository,
  step ids, prompt steps and loop limits. So tools, agent pool, param forms, integrations, switches and
  presets never come from a draft. `validateTaskTypeDraft` runs the create route's shared validation
  stages in its order and returns the same issues; a parity test drives the drafter and the shared
  validator over the same fixtures. A taken slug, a built-in's included, is only a `slug-taken` warning
  on a draft, while `POST /admin/task-types` refuses it with 409 before those stages, so a warned
  draft does not save under that slug.
- **Routes:** `POST /admin/task-type-drafts` inserts the task, writes the opening message and marks it
  queued in one transaction, then enqueues the start (a crash in between used to leave it `created`
  forever); `GET /admin/task-type-drafts/:taskId` answers its owner only, with `awaitingMessage` true
  only while the newest step row is `waiting_form` with `waiting_started_at` set.

- **The panel** (`task-type-creator-panel.tsx`) sits in the editor on the create page and on an
  admin-made type, never on a built-in or module type. It remembers the conversation per viewer and
  slug in localStorage (`haive:task-type-draft:<slug|new>`; the page works without storage), resumes it
  unless the GET answers 404 or a finished status, and polls every 2 s while the agent works. "Load
  into editor" puts the latest draft into the form as unsaved changes and sends nothing; Save stays
  the only write. On a saved type the draft's custom step ids and `{{step:}}` quotes are renamed onto
  the saved slug, since an agent may rename the type against its instruction. The state sent to the
  agent carries only the draftable keys; a start whose state is over 64 KiB goes without it and says
  so. A successful create forgets the create page's conversation (its task stays in the task list);
  it is not carried to the new type's page, whose slug the task would read as taken.
- **The task page** shows only the message box: the step's `draft` field is `hidden`, which the form
  renderer never draws and validation never requires, while its submitted value is still accepted.

## Do not change

1. A missing step marks the task dead; never filter it out of a run list.
2. A static type's run list and the prompt steps it uses are pinned at create, and only INSERTs write
   them; `workflow` and `run_app` keep a null snapshot and assemble their list per path and mode.
3. `custom_steps` is pinned raw and parsed per tool.
4. Prompt steps are never registered; the worker synthesises them per task.
5. The seeder writes only its own columns and rows, skips unchanged rows and never deletes.
6. Every built-in slug is held by a `builtin` row with the registry's list, or the worker does not boot.
7. The `workflow_type` enum stays defined; a new built-in is `ADD VALUE`, declared last.
8. Both switches default off and gate creation only; the first non-built-in task closes the 0193
   rollback.
9. Create admits on the definition read `FOR SHARE` inside the insert transaction wherever a
   non-built-in type can be created (KB enrichment and most plan spawns read on the pool, safe only
   because their built-in types cannot be deleted); DELETE takes `FOR UPDATE`; module rows are read
   `FOR KEY SHARE`.
10. The availability order is fixed and the create switch is exhaustive.
11. Only `07-phase-2-implement` is a fix-loop target; an unroutable target fails by name before any reset.
12. Composition ordering rules never contradict the shipped built-in order (the guard test above).
13. Module steps are namespaced and register after the static-list asserts.
14. A quote comes only from agent-authored output; persona markers resolve only from the step's own
    template.
15. No data field turns agent rules, the MCP surface or tools off (agent rules follow the install's
    switch only).
16. Custom tool calls: declared on the pinned step, live invocation, own audience, budget claimed under
    the lock; a row keeps the tool, action, outcome, reason, HTTP status, size and duration, never the
    arguments or the response body.
17. Egress: every resolved address checked at connect time, c-ares, no redirect, one deadline.
18. Drafts: a positive key list, parity with the create route's shared validation stages (a taken slug
    is a draft warning, a 409 at create), and no surface, rules, egress or repository for the drafter.
