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
description, `run_list_strategy` (`static`, `workflow_paths`, `run_app_modes`, `derived`), `step_ids` (static
types only), `pre_answer_defaults`, `step_loop_limit_defaults`, `fix_loop`, `enabled`, `selectable`,
`source` (`builtin`, `admin` or `module:<moduleId>`), `requires_repository`, `sort_order`,
`content_hash`, `prompt_steps`, nullable `base_slug varchar(128)` and `changes jsonb`, then nullable
`execution_contract jsonb` appended by guarded migration 0245, then nullable
`data_role_bindings jsonb` appended last by guarded migration 0246. Author choices are copied into
the immutable v3 task pin at INSERT; they never update an existing task.

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

On `tasks`: `type` is `text` (it was the `workflow_type` enum until 0193). `run_list_snapshot` pins
static step IDs at creation; built-in dynamic strategies and legacy/unseeded tasks retain their
existing null semantics. Derived tasks pin the full/null candidate initially and the chosen
candidate at first triage. That derived-only, fenced selection is the sole snapshot UPDATE
exception. `custom_steps` pins raw prompt definitions used by the snapshot (candidate union for
derived tasks); `derived_run_plan` pins the derived execution plan (v2 when any candidate applies a replacement, otherwise v1).
Both remain INSERT-only. Definition edits and Retry never recompute existing task pins. `dead_at` /
`dead_reason` mark a dead task.

**Derived storage (shipped in PR2).** Migration 0240 adds `derived` alone, committing the enum value
before 0241 uses it. Migration 0241 appends `base_slug`, `changes` and nullable
`tasks.derived_run_plan jsonb` (last, after `pr_remote_url`), with no backfill or defaults. It uses
`ADD COLUMN IF NOT EXISTS` and a `duplicate_object` guard for every named CHECK/FK; Drizzle mirrors
the names, definitions and column order. Existing builtin/static-admin columns and timestamps are
unchanged, and existing tasks have no plan.

- `task_type_definitions_derived_shape_check`: derived rows have non-null base/changes, null
  `step_ids`, `source = 'admin'`, and JSON-array changes (JSON null is refused).
- `task_type_definitions_non_derived_shape_check`: every other strategy has null base/changes.
- `task_type_definitions_base_not_self_check`: a non-null base differs from the row's slug.
- `task_type_definitions_base_slug_task_type_definitions_slug_fk`: base references the slug primary
  key, with `ON DELETE RESTRICT` and `ON UPDATE NO ACTION`.

The CHECKs use explicit SQL null tests. Builtin-only eligibility, base immutability and inherited
repository policy are enforced at locked API admission, not as cross-row SQL CHECKs. Both JSON
columns are `unknown` in database: shared already depends on database for secrets services, so
importing its types would create a package cycle. Consumers validate the versioned execution plan
at their boundary. API authoring writes base/changes; task creation writes the immutable plan.
Existing builtin/static columns and execution semantics retain their behavior.

**Rollback** is additive code rollback: revert the application commits and leave nullable columns
and the inert enum value. There is no executable down migration or down script. The 0241 header
contains optional manual cleanup as one commented `DO $$` block. It locks tasks and definitions in a
maintenance transaction and refuses if **any** task carries a plan or references a derived type,
including completed, cancelled and dead tasks. Otherwise it deletes unused derived definitions and
drops the named FK/CHECKs and all three columns with `IF EXISTS`, leaving legacy rows and the enum
value intact. Reconcile the applied migration journal before any later roll-forward.

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
2. assert the core composable catalog (`CORE_COMPOSABLE_STEPS`, 60 entries);
3. register module steps — after the static asserts, so the shared static lists stay authoritative for
   core ids only;
4. `syncStepCatalog`;
5. `ensureModuleSchemas` (skipping, and reporting as `deactivated`, every module deactivated at boot),
   then `syncModuleIntent` — before the seed, so a freshly installed module's types do not read
   `module-missing` during boot, and after the schemas, so a failed schema bootstrap is never
   recorded as loaded;
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

Every task INSERT is in the api, and each explicitly calls
`definitionForCreate(handle, slug, {generic, locked: true})` on the
same handle first: `POST /tasks` (including upgrades), the upgrade rollback, KB enrichment, the plan
spawners and the creator drafts route. It reads the definition `FOR SHARE` (an admin DELETE takes
`FOR UPDATE`, so a type cannot vanish between the read and the insert — where the read is in the insert
transaction, including KB enrichment and all five plan spawns) and the module rows the type
uses `FOR KEY SHARE` (a deactivation's `FOR UPDATE` waits and then counts the new task, while the boot's
non-key updates of the same rows do not conflict — `FOR SHARE` blocked the boot's intent sync).

Preset configuration and its copy into a task are separate boundaries. The generic task INSERT
normalizes the locked definition's known push-gate `remoteUrl` preset with the shared
`normalizeStepFormValues` rule before writing `tasks.pre_answers`. It preserves every unrelated
step/key and leaves `task_type_definitions.pre_answer_defaults` untouched. Invalid known Git
values refuse task creation with a static error, no task/event/job and no echoed credentials.
The other `definitionForCreate` callers copy snapshots and prompt steps only; they do not copy
pre-answers. Worker default expansion is guarded separately at the final answer and schema-copy
boundaries ([Secret and git-data masking](sandbox-masking.md)).

A custom type may include `06-run-config`, which writes `tasks.pre_answers` for the steps after it as
the workflow does. Its ordering rule makes it precede every token whose steps read those answers
(`db-migrated`, `implementation`, `reconciled`, `validation`, `tests`, `verification`, `review`), so a
type that places it later is refused `too-late`. Its form shows the type's presets for those steps
(`ANSWER_FIELDS`, inverted in `detect`) as defaults, so an unchanged Save keeps them; a field the person
changes wins, and a field left out (a headless or partial submit) keeps the preset, or gets 06's
default when there is none (`preserveOmittedFormFields`). A preset for 06 itself auto-submits the
step. A Retry shows the answers the previous run stored, which cannot be told apart from defaults 06
wrote itself.

**Insight auto-action.** `06-run-config` records `autoActOnInsights` in its output
and in `tasks.auto_act_on_insights`, a NOT NULL boolean with default false appended
by guarded migration 0243. The column survives step output resets. An explicit
boolean answer wins over the task's explicit 06 preset, then the owner's most
recently completed task with a non-null completion timestamp on the same repository
and type supplies the default; missing, legacy and malformed values resolve false.
Only this switch is remembered: 06 has no whole-form reuse or reconcile hook,
and its recommendation cannot enable it.

`INSIGHT_AUTO_ACTION_AVAILABLE` is true. The checkbox is visible, its default follows
the remembered setting, and an explicit true is accepted. On both API display routes,
submit validation and worker normalization, `upgradeRunConfigSchema` idempotently
replaces persisted hidden checkboxes, including nested accordion fields, and appends
one when absent. It keeps unrelated defaults, saved answers, waiting timestamps and
recommendation results. An omitted switch remains a valid false answer.

Setting `INSIGHT_AUTO_ACTION_AVAILABLE` false is the rollout rollback lever: it hides
and clamps manual opt-ins and makes `insightAutoEnabled` false even for tasks whose
stored column is true. The automatic round claim also checks it under its admission
fence, so previously detected work cannot claim a fresh round. It preserves stored
opt-ins, spent claims and active batch history; settle active batches with capable
workers before reverting them. The existing explicit-preset resolution can still
record true in 06 while unavailable, but that value cannot start automatic execution.

06 no longer generates an empty `08e-insights-triage.selectedInsights` pre-answer. Fresh
08e entry ignores the exact legacy singleton `{selectedInsights: []}` preset, so offered
choices park even with auto-continue on. This includes in-flight tasks whose pre-answers
already hold that legacy empty preset. A type's deliberate `{selectedInsights: []}` 08e
preset has the same shape and is ignored too. Saved answers and a deliberate empty submit still
pass, and manual entry builds no prompt and starts no CLI invocation. Existing parked schemas need no data
migration. Rollback reverts application code and retains the default-false column; never
edit or remove an applied migration.

**Availability** (`resolveTaskTypeAvailability`, pure, shared by create and every list), first match
wins: `disabled` → `not-selectable` (generic route only) → `custom-types-off` → `module-types-off` →
`module-missing` → `module-draining` → `module-deactivated` → `missing-step` → `invalid-composition`. `module-missing` comes
before `missing-step` so a removed module is named instead of "a step is not installed". Without a
synced catalog the step and composition checks are skipped for existing strategies, except prompt
steps using role declarations/tokens or structured mode: these refuse admission with 409
`prompt-role-catalog-unsynced` before any task is written. Derived admission
requires a coherent synced catalog. Derived inspection and structural saves carry the
stored execution contract and trusted predicate schemas through every candidate's
composition check. An unavailable guard predicate or endpoint yields the stable
`invalid-execution-contract` issue (400 at structural save, 409 at locked admission),
before data-edge construction; module-policy refusals retain their earlier priority.
No task pin is rewritten. The editor renders both the per-candidate composition wrapper
and the named top-level refusal with the contract reason, deduplicating identical
path/reason pairs within each validation panel. The top-level issue stays available
to structural-save and admission callers. The composition-message switch is exhaustive
over ordinary and execution-contract issues. Over HTTP: disabled, not selectable and the
switches are 403; the module reasons, a missing step and a bad composition are 409 naming what is wrong.
The switch over reasons ends in an exhaustive `never`, so a new reason cannot fall through to a create.

The execution-contract support refusal remains the final `invalid-composition` check
and also runs without a synced catalog. For a derived definition it retains its named
`invalid-execution-contract` issue even if the overlay is invalid, after module policy.
`definitionForCreate` reports that issue directly rather than evaluating the contract again.
Trusted predicate schemas come from installed modules’ schema-only
`./execution-predicates` exports, loaded at API boot without importing `./steps`.
Availability checks composition and pinned data edges on feasible paths before the
unchanged runtime-support refusal. A missing map/export does not skip conditional
validation: referenced predicates are unknown and fail closed. API catalog JSON
carries no schema or executable authority; guarded definitions remain unavailable. Admin static detail and structural edits carry
the stored contract into validation; strict create/editor/draft schemas still expose no
execution-contract authoring. Availability and the seeder keep inert declarations on the ordinary composition walk; the admin
detail and static PATCH routes still pass a stored inert contract to the contract walk, which
returns the same verdict with different issue indexes.

**Traits returned with the definition:** the run list snapshot (a non-built-in static list that
dispatches a CLI and has no canary gets `00-model-health-workflow` prepended; a prompt step counts as a
CLI step even with an unsynced catalog); the prompt steps the snapshot uses, copied as stored; preset
answers and loop limits for non-built-ins (request limits win); `simplifyCode` (a non-built-in with
`07a-code-simplify`); `takesRootLock` (workflow, or a list with `00a-sync-base`, `01-worktree-setup` or
`12-worktree-cleanup`); `pinsDatabase` (a non-built-in with `01c1-restore-database` or
`11g-save-database`); `restoresDatabase` (a non-built-in static list or derived candidate union with `01c1-restore-database`);
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
snapshot (`resolveRunList`), and `derived` resolves the task's pinned prefix/selected candidate. The pure strategy selection and dynamic step IDs live in
`@haive/shared/run-list`; path ordering lives in `@haive/shared/execution-paths`. The worker
resolves those IDs through its registry and retains the run-app database-compatibility check.
The provider-disable preview uses the same selector with catalog steps, the stored execution
path and the linked environment template, including before a task has a run-list snapshot. It
isolates `DerivedRunPlanError` per task, returning valid counts plus `incomplete: true` and
`invalidTasks: [{id, code}]`; its dialog labels incomplete counts even at zero. The reset guard
`loadLiveRootWriters` instead retains an invalid live task as a named 409 blocker before deletion.
Neither scan marks tasks dead, and other failures propagate.

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
`unknown-step`, `unmet-need` (no EARLIER step provides it), `need-out-of-order`, `too-late`, `unfulfilled`,
`missing-loop-target`, `duplicate-step`, `loop-after-closing` and `empty`. `repository` is implicit: no
step can provide or remove it, so a module step cannot fake a repository. Built-in seeded lists are not
composition-checked at boot. A guard test (`worker/test/composable-core.test.ts`) enumerates
`taskRunListIds`, the same selector `buildRunList` uses, for every `EXECUTION_PATHS` value and the
unset pre-triage path, including the environment prelude. Every shipped step must have a composable
entry, and every complete path must validate with **no issues**, including `unmet-need`; no step or
issue is filtered out. The environment and registered workflow ordering guard stays too. The core
catalog has 60 entries: all 55 registered workflow steps, the four environment steps,
and the explicit-composition no-change cleanup step.

A requirement may declare `after: <token>`: both tokens must be available, and the current provider
of `needs` must strictly follow the current provider of `after`. A shared producer does not satisfy
that order. A reversed order reports `need-out-of-order` on the consuming step, carrying both tokens
and its reason. This is a consumer-local rule: lists without that consumer stay unrestricted. Module
requirements accept the same field; module step namespacing and replacement authority are unchanged.

Requirements describe inputs a step actually uses; optional report sections and explicit fallbacks
stay optional. Sprint planning accepts missing spec and gate-1 feedback; every spec producer and
gate 1 precedes `sprint-plan` when present. Gate 2 accepts missing verification but still requires a
worktree; verification precedes `verify-approved` when present. `04a-spec-audit` requires the draft
spec and reports to `05a-resolve-spec-warnings`; `08c2-code-audit` requires a worktree and reports
to gate 2. Neither audit loops. Adversarial QA also reports only; its human review and gate 2
restart at `07-phase-2-implement`, while business-requirements review revises at
`03b-business-requirements`. None of those review gates closes the run. `06c-dag-execute` requires
the sprint planner that writes its DAG rows; browser verification requires a runtime. Pre-sync and
final RAG indexing have separate scope tokens. The review and broad-audit consumers resolve their
output roles through the immutable task pin; other output reads still address physical step IDs.
Declaring tokens alone grants no replacement role.

A mode selector entails every execution route it can choose: `06b-sprint-planning` requires both
`06c-dag-execute` and `07-phase-2-implement` later in the list, covering single-agent overrides and
planner fallbacks as well as DAG mode. `08a-browser-setup` likewise requires both automated
`08a-browser-verify` and manual `09-gate-2-verify-approval` destinations. Without setup, browser
verification keeps its automated default. External KB sync, external plan sync, spec-warning
resolution and plan reconciliation require a prior worktree; their file, commit or mirror writes
therefore cannot compose without the root-write admission provided by `01-worktree-setup`.

Optional providers constrain ordering when present. For example, `11b-kb-commit` needs the captured
learnings, but not skill sync: `plan_tasklist` ships without `11d-skill-sync`. Skill sync precedes the
knowledge commit when included, using `knowledge-committed`. Run configuration precedes the newly
catalogued sprint, browser, QA and insight consumers of its presets. Implementation and simplification
precede the new audit/browser/approval tokens; insight edits run after reviews as shipped, but revoke
`clean-tree` and precede commit. Built-in step behavior, path membership and boot admission stay as
before.

There is no `STEP_LOOP_TARGETS`
table: loop targets live on each entry. `validateTaskTypeDefaults`: every preset or loop-limit key must
be a step of the type, and a loop limit only on a `loopBudgetEditable` step (1–50).

**Traits from data.** `requiresRepository` is the column; repo-less tasks get a secret-masked scratch
workspace. List and detail carry `typeLabel` (the display name), so an admin rename shows everywhere.
Statistics put unknown and custom slugs in `other`. Worktree gates (the terminal, the Editor tab, the
upcoming-CLI list, completion release) read the snapshot. Step flags come from `step_catalog` (cached
30 s, never caching the static fallback); a pinned prompt step dispatches a CLI and cannot be skipped.
Beyond a step's own `allowSkip`, only `01-worktree-setup` is skippable from the run list: always on
`run_app`, and on a snapshot task when the composition stays as valid without it.

## Successful output contracts

`STEP_ROLE_REGISTRY` is frozen host-owned metadata: role id, exact contract id/version,
cardinality, authorship and canonical legacy producer. Schemas and validators stay private;
modules supply references, never validators. The review/audit physical role ids remain aliases,
and their schemas and v1/v2 decoding are unchanged. Only entries carrying an existing host policy
enter run-list replacement policy; a data port grants no routing or replacement authority.

The spec ports are `haive.spec.draft@1` (04), `haive.spec.checked@1` (05), and
`haive.spec.resolved@1` (05a). All three have mixed authorship and no quote projection. Their
contracts declare the fields consumers use, including draft impact, quality findings/score and
scope questions. Unknown storage fields survive validation; readers project declared fields.
`providesRoles`/`consumesRoles` are also module executable and manifest declarations, checked
for exact host contract references and boot parity. A data declaration grants no replacement
policy. Prompt steps consume agent-only quote projections through named role tokens and may provide only
agent-only data roles through host-parsed structured output; roles carrying host policy or mixed/human
authorship are refused, so no production role is providable by a prompt step yet. The spec definitions and serialized catalog entries have no
`outputContract`. After a successful apply, the runner also validates every declared
`providesRoles` output, including core, module and prompt producers. A data-contract
mismatch fails the producer visibly before summaries and routing, even with
`fixLoopOnError`; it never requests an implementation fix round.
The executable `outputContract` and v1/v2 replacement gates still accept review/audit only;
module data declarations use the separate exact registry reference gate and reject every
role carrying `hostPolicy`, including `08c-code-review` and `08c2-code-audit`, in both
`providesRoles` and `consumesRoles`. Review/audit replacements retain their host-policy
support check even if an executable also carries a data declaration.

The review and broad-audit definitions declare their immutable host output contract.
After a successful apply return, the runner checks cancellation and ownership, then validates
before summary extraction, loop hooks, routing and output writes. It persists the original
return value. Built-in mismatches log a pino warning containing the contract and bounded
issue paths, never values, and keep the existing live-task behavior. Only a producer occupying
a replaced role through a pinned host binding may fail `step-output-contract-invalid`;
that failure never routes through `fixLoopOnError`. The runner resolves replacement occupancy through the immutable task pin before applying that hard-failure policy.

A continuation throw, parked form or skipped step has no new successful output to validate.
The current shouldRun skip writes status and end time without writing output. Recovered done
rows and all stored readers retain their existing behavior; historical rows are neither
validated as new writes nor migrated. Audit parsing stays report-only, including its current
empty-findings fallback for unreadable replies.

## Discovery and requirements data roles

`haive.discovery@1` (03) declares `{summary: string, relevantKbIds: string[], source?: string}`.
`haive.requirements.draft@1` (03b) and `haive.requirements.humanized@1` (03b2) each declare
`{requirements: string, summary: string}`. All have cardinality one, canonical legacy producers,
no host policy and mixed authorship. No agent-only quote projection is declared: discovery's
stub copies the task and repository index, and its normal aggregate inserts host headings and
coverage notes; draft parsing supplies missing fields and final-attempt/bypass fallbacks write
host text; humanization can pass through that mixed draft or a module's document. Module data
producers promise shape, not exclusively agent provenance. Unknown storage extensions remain
outside the declared projection. Neither role quotation nor structured prompt production is
allowed for these roles; the explicit agent-only eligibility rule stays unchanged.

03b and 03b2 remain `{{step:}}`-quotable through their `agentAuthoredOutput` flags in
`worker/src/step-engine/composable-core.ts`, and nothing operator-typed reaches their stored
output: guidance and human review feedback go to prompts, events, form values and 03c's own
output, never to theirs. 03b stores agent prose,
source tags, empty defaults and a fixed bypass stub. 03b2 stores agent prose, or on bypass and
passthrough copies its draft input unchanged; when a module supplies that draft, the copied text
is the module's, and a quote of it is still fenced as untrusted agent output. A physical `{{step:03b-business-requirements}}`
quote still reads that physical row, even when a module supplies the draft role to a downstream
consumer. 03 is not `{{step:}}`-quotable, and none of the three new roles is `{{role:}}`-quotable
or providable by a prompt step.

Module declarations can consume these roles, but a ready mixed-role read through
`ctx.host.loadRoleOutput` refuses with `host adapter unavailable`, even for an optional input:
there is no module host adapter for discovery or requirements. The core adapters below do not
grant modules a mixed-role read or quotation projection.

03b consumes optional discovery; 03b2 consumes the optional raw draft. 03c and 04 use the
explicit host `effective-requirements` adapter, with independently optional ordered inputs
humanized > draft, and 04 also consumes optional discovery. A humanized requirements string
wins only when `trim()` is nonempty, and its original bytes and own summary are returned. A
blank/missing humanized body falls back to the draft, including an intentional empty draft;
missing fields fall back to `''`. This differs deliberately from effective-spec's nullish
precedence. Human review decisions and the revise destination remain physical host control.

New tasks pin these edges through the existing v3 admission writer. Older tasks and valid v3
pins predating an input keep canonical, unbounded legacy reads, including tolerant retained
output. A bound v3 input uses its exact producer and current-round ceiling; Retry cannot
resurrect an older success or retained reset output. An explicit optional absence stays absent.
Malformed/unknown bindings still refuse; no definition edit, Retry or recovery rewrites a pin.
The legacy port display groups a complete effective-requirements role set, regardless of input
names, while a raw-draft-only consumer retains its direct input. Editable declarations and v3
pins expose each stage independently. Rollback follows the v3 policy below: stop new
admission and retain capable readers/workers while any affected task can resume.

## Implementation summary data role

`haive.implementation.summary@1` declares `{summary: string, filesTouched: string[],
similarSites?: {path: string, lines?: string, reason: string}[]}`. Storage extensions
survive validation; role reads project only declared fields. It has cardinality one,
mixed authorship, no quote projection and no host policy. 07's normal reply supplies
agent prose, but salvage can supply host fallback text, no-output/bypass uses a host
stub, and the DAG adapter supplies host empty values. A module's conforming payload
cannot strengthen that guarantee. Generic role quotation and prompt production remain
refused for this role.

Learning has one optional `implementation-summary` input. Admission chooses the host
route structurally from each candidate's run list: 07 when present, otherwise 06c
when present, otherwise an explicit optional absence. A list containing both keeps
07 as the one provider, including its later fix rounds. A module producer still needs
a unique earlier edge or an explicit author binding; matching output shape never
selects a producer. New task catalogs and pinned history use this structural rule. Legacy history,
including inputs absent from older valid v3 pins, retains the canonical 07 edge or
absence, matching the compatibility reader.

06c's new successful outputs add `summary: ''` and `filesTouched: []`. The explicit
host reader adapter also normalizes historical 06c count outputs to these values.
This preserves what learning read from skipped/absent 07 on DAG builds; it does not
invent a summary or file list from DAG issues. Single-path learning retains its `''`
and array fallbacks, and v3 retains current-round ceilings and newest-row Retry
semantics. Old tasks and inputs absent from an older valid v3 pin retain canonical
07 reads. No output or pin is backfilled.

`_impl-changes.ts` keeps its physical 07/DAG/git collection, `_similar-sites.ts` keeps
all physical rounds and DAG issues, and fix-loop routing keeps 07 as its only target.
An implementation-summary binding changes learning context only. It grants no
replacement, skip, loop, root, approval or CLI-seat authority. No migration is needed.
Rollback first disables new v3 admission; retain this contract and capable readers
while any affected task can resume. Never erase, downgrade or regenerate its pin.

## Check result data roles

`haive.validation@1` (07b), `haive.verify@1` (08), and `haive.test-management@1`
(08b) are cardinality-one data roles. Each has an exact host-owned contract,
its canonical legacy producer, mixed authorship, no quote projection and no
host policy. Validation combines agent findings with host coverage, invocation
identity, convergence and iteration budgets. Verification combines command
results with human command selection and host runner discovery. Test management
combines agent edits, human action selection, command outcomes and host framework
discovery. Neither generic role quotation nor structured prompt production is
available for these roles. Module declarations grant data compatibility only.

Every result carries `resultStatus`. Validation and test management distinguish
`not-run`, `skipped`, `incomplete`, `failed` and `passed`; verification also admits
`manual` and `declined`. A manual checklist is not an executed passing check.
Verification's legacy `passed` boolean describes only checks that ran, so it can
remain true when none ran; the explicit status and existing not-run disclosures
must accompany it. Gate recommendations still require executed checks. Canonical validator reports pairing `VALID` with issues or a failed dimension are
stored as `incomplete`, retaining their original verdict and routing. An
alternate producer cannot declare a passing status without the corresponding
valid evidence. Invalid successful module output fails the producer before
routing, including when it declares an error-to-fix-loop hook.

Validation declares its verdict, summary, issues, dimensions, excluded dimensions,
fixes, convergence, churn files, report and report length, validator pass count,
coverage, invocation id, fingerprint and house-rule conflicts. `exhaustedBudget`
projects the host's iteration metadata. Verification declares each test, lint,
optional PHP lint and typecheck result, its own verdict, runtime smoke and the
previously detect-only `declinedConfigs`, `declaredSlots`, `offSlots` and
`slotWithoutRunner`. Test management declares action, created/updated/deleted
test paths, nullable `testsPassed`, and detect's nullable `primary` framework.
Storage extensions survive validation; role projections expose declared fields
only, including at nested object boundaries.

The host normalizes only the three canonical producers' successful returns before
contract validation. New 07b, 08 and 08b `task_steps.output` values permanently
include `resultStatus` and their role metadata (`exhaustedBudget`, verification's
`declinedConfigs`, `declaredSlots`, `offSlots`, `slotWithoutRunner`, and test
management's `primary`). Local-loop `iterations[].applyOutput` values also retain
the normalization performed before the iteration is appended. The final validation
output additionally receives the current exhaustion decision after the loop hook;
the already-appended iteration retains the pre-decision value. These
metadata additions do not change the local loop evaluator, its budget, the
fix-loop diagnosis or routing. Historical canonical rows receive the same
projection at read time without backfill. An alternate module must supply the
complete contract itself; the host never fills missing fields for it.

Gate 2 consumes optional validation, verification and test-management inputs.
Its existing sections, blocking disclosures and default decision retain their
bytes for canonical historical results, including missing sections, skipped
management, declined or unavailable checks, incomplete validation and retries.
A selected alternate input that is unavailable or invalid is incomplete evidence
and holds the approval recommendation. Explicit optional absence remains absent;
an unselected derived candidate never supplies a result. Only the human gate
retains approval and rejection authority.

The house-rules adapter reads the gate consumer's validation edge. Validation
and review share one stamp lookup scoped to `cli_invocations.id`, `taskId` and
`taskStepId`, which must equal the actual producer row id. An alternate validation
producer, or an alternate review producer whose row is done with contract-compatible
output, gets a visible NOT CHECKED row that holds Approve when its invocation is missing
or not its own, including when a later canonical peer ran; an incompatible review row
adds no house-rules row and gate 2's own review hold covers it. An owned module invocation may supply its
host-written stamp, but its output cannot attest `changeFingerprint`: rules in
play remain PARTIAL with a fingerprint caveat. Canonical validator and peer
review rows retain their existing rendering and host fingerprint comparison. Gate 3 declares its own optional
validation edge for its existing house-rules fallback; its gate decisions and
commit receipts remain physical. Learning consumes optional verification and
validation edges. Its history digest mines every round of those bound producers,
retains event provenance and physical source identities, and preserves canonical
history bytes. A row bound to review and also classified as a finding step is
mined once through review, while a producer carrying distinct validation and
review findings retains both sets. Verification consumes test management's framework through its own
optional input. A role result never requires its consumer to inspect a producer's
detect output or iteration rows. The composer and admission share
`validateComposition`: 08b's `precedes: ['verification', ...]` rejects test
management after 08 with `too-late`. The static editor, admin-static admission and derived-candidate validation enforce
this guard. Module-seeded static lists containing an internal step without a
composable entry deliberately skip composition checks (`resolveTaskTypeAvailability`);
such a list may admit 08 before 08b. A new pin for that list records the optional
framework input as explicitly absent: verify reads no framework from the later 08b
and never borrows a future producer. A previously pinned explicit absence is never remapped.

Creation pins these inputs with the existing v3 writer for built-in, static,
module-seeded and derived candidates. Old tasks, and inputs missing from a valid
older v3 pin, retain canonical resolution. Present bindings keep their exact
producer and current-round ceiling, selecting the newest row before checking
readiness; Retry never borrows an older successful row. Malformed or unknown
bindings remain errors. Definition edits and recovery never remap a binding.

Validation rechecks, snapshot comparisons, fix-round decisions, iteration caps,
loop and gate-revise destinations, closing and commit control stay physical.
`07-phase-2-implement` remains the only fix target. No migration is needed.
Rollback first stops new v3 admission and retains capable readers and workers
while any affected task can resume. Keep every persisted result and immutable
pin; never erase, downgrade, regenerate or backfill one to permit an older worker.

## Browser verification and adversarial QA data roles

`haive.browser-verification@1` (08a verify) and `haive.adversarial-qa@1`
(08d) are cardinality-one data roles with exact host-owned contracts, canonical
legacy producers, mixed authorship, no quote projection and no host policy.
Browser reports combine agent testing, host runtime and screenshot evidence,
manual checklists and human method choices. QA combines agent findings with
host-generated gap findings, coverage, aggregate counts, verification collapse
and fingerprint attachment. Neither role is quotable or providable through
structured prompt output.

Browser `resultStatus` distinguishes `passed`, `failed`, `manual`, `skipped`,
`incomplete` and `not-run`. Manual means a checklist was prepared, never that
browser tests passed. `verificationIncomplete` retains its separate evidence
warning. The contract declares executed method, ran/skipped/pass flags,
failures and evidence, visual verdict, checklist, console/network errors,
app URL and optional login outcome (attempted, ok, reason; no credentials).
Passing alternate output requires executed testing, no failures or unstyled
verdict and no incomplete-evidence flag. Canonical contradictory passes retain
their stored verdict and routing while their role status becomes incomplete.

QA `resultStatus` distinguishes `findings`, `clean`, `incomplete`, `skipped`
and `not-run`. Its contract declares ran, level, blocking, counts, findings,
verification verdicts, merged fingerprints, `qaIncomplete` and coverage.
Counts and blocking must agree with the findings. Clean requires an executed,
complete run with no findings; incomplete coverage never becomes clean.
The host adds status only to canonical successful outputs before strict
contract validation and iteration persistence, and projects historical rows
at read time without backfill. Alternate producers supply the entire contract.
A malformed or contradictory successful module output fails before routing,
including an error-to-fix-loop hook; it cannot recommend approval.

Gate 2 reads its optional browser and QA inputs; gate 1.5 reads its optional
QA findings, preserving verification markers, folded findings and every merged
fingerprint. Alternate QA fingerprint references are intersected with physical
`review_findings` rows for the same task, actual producer row and current round;
a module payload cannot waive another producer's findings. The host-owned producer
row id also constrains the physical waiver UPDATE, since the same fingerprint may
exist under several producers. Fingerprint generation, recurrence and canonical
waiver behavior stay unchanged, including the current-round/open guards. Their
canonical detect/form bytes, recommendations, blocking and
defaults remain unchanged, including manual, missing, skipped, incomplete,
fix-round and Retry cases. A selected alternate result that is unavailable
or incomplete holds the approval recommendation. Missing and unselected
inputs supply no passing or clean result. Gate decisions and revise targets
remain human and physical.

QA reads its own pinned browser app URL/login only as prompt context. App boot,
readiness, reach probes, startup, stopping, browser setup choices and gate 2's
live-browser navigation stay physical. Setup receives no separate result role:
its mode and URL choose which runtime is exercised; the verification contract
carries the method actually reported. A data-role binding cannot redirect the
live-browser navigation or establish a session. Web timeline outcomes retain
physical row identity and distinguish manual preparation from tested passes.

Learning history mines every round of its bound browser and QA producers,
validates alternate outputs, and preserves canonical formatting and physical
event provenance. Distinct bound QA and peer-review result ports on one producer
retain both finding sets; the historical canonical review/QA deduplication stays
unchanged. New tasks pin these optional edges through the existing
locked v3 admission for built-in, static, module-seeded and derived candidates.
Old tasks and inputs absent from valid older pins read canonically. Explicit
absence, Retry readiness and round ceilings never borrow another producer;
unknown or malformed bindings are refused.

Finding identity, telemetry writes, recurrence, human waivers, fix routing,
iteration budgets, closing and commit remain physical. No migration is needed.
Rollback stops new v3 admission and retains capable readers/workers while any
affected task can resume. Preserve stored results and immutable pins; never
regenerate, downgrade or backfill a pin for an older worker.

## Pinned output-role reads

`@haive/shared/step-outputs` exports `STEP_ROLES`, `readStepRole(task, role, read)` and
`projectStepOutputRoles`. This is the one role-resolution algorithm for worker queries and API
projections. Builtin, static and no-plan tasks keep canonical identity reads. Derived v1 reads use
identity only when the selected candidate contains the role. Before selection a role is unselected;
a removed role is absent. Neither state borrows another candidate. Required missing/malformed pins,
invalid paths and mismatched snapshots refuse with `invalid-derived-run-plan`, never a live-catalog
or output-shape fallback.

The strict dual decoder accepts unchanged v1 and contracted v2 pins. V2 adds candidate-local
`roleBindings: { [role]: { stepId, outputContract } }`; the existing `composableEntries` pin holds
raw declarations and exact host contract references. Candidate-local `effectiveEntries` are required on every v2 candidate and store only effective replacement declarations; `derivedCandidateEntries` combines them with unchanged pinned declarations. The reader also accepts older full candidate arrays. Each bound entry is checked structurally for the host provided tokens, required-token superset, loop target and closing policy; it is never merged again with today’s code. The decoder replays pinned applied
outcomes to verify surviving physical positions, one-hop contracts, binding removal, unique
producers and canonical-role ambiguity. It does not re-run today's composition rules. Admission emits v2 only when at least one candidate applies a replacement; existing v1 pins are never rewritten.

The worker's previous-output loader accepts an explicit `{ role }` selector; string callers remain
physical. It returns actual row identity/status and the newest round, even when reset, with an
optional historical round ceiling. No producer or no row returns null for every selector. Skipped,
pending and reset contracted rows retain their physical metadata but read as absent output; they
show no review/audit row at gate 2 and impose no approval hold. Only a done contracted row reports
`outputCompatible`: false means non-conforming output, which gate 2 discloses as incomplete and
never recommends approving. A reset newest round never borrows output from an older completed round.
Historical core output fields remain tolerant; no backfill runs. History findings, honored
constraints and both prompt-guidance paths resolve the pinned producer while events, provenance,
human/agent fencing and telemetry keep physical IDs. Gate 3 still reads gate 2's human decision and
its gate-2-less house-rules fallback stays validator-only.

Both owner-scoped task detail and steps/poll responses project optional `outputRoles` on step DTOs,
retaining physical IDs/titles and stripping the full plan. Web history admits explicit role members
while preserving status, CLI evidence, rounds and retry boundaries. Non-role rows omit
`outputRoles`; role producers retain their physical IDs and titles. The ungated
`step-role-source-scan.test.ts` pins remaining executable literals and role-table uses by
file/symbol/context/value/count with reasons; stale pins and new raw readers fail. Its negative
fixtures reject unapproved full role literals in equality predicates, SQL templates with
substitutions, template heads/middles/tails, regexes, loader aliases/wrappers, collections, scalar
aliases and TSX. Concatenated fragments and prefix tests are outside the scan: it performs no
constant folding. Context whitespace is collapsed before matching pins. Scope includes shared,
worker, api, web, database and web-kit source, worker scripts, root scripts and tracked module
source; ignored external-module files are not enumerated by git. The ungated scan adds about 3-4
seconds to the shared test job and has an explicit 20-second cold-run timeout. It changes neither
the gated-file count nor the configured CI time budgets.

For tasks without v3, the worker's core `readRole(ctx, role, maxRound?)` accepts spec, discovery and requirements data roles
and resolves their canonical legacy producer. It returns `ready`, `absent`, `not-ready` or `invalid`, with producer
row id, physical step id, round, status and exact contract. Selection keeps the physical loader's
newest-round ordering, no status predicate and no implicit round ceiling; an explicit ceiling is
forwarded. Review/audit reads continue through `readStepRole` and the immutable v1/v2 task pin.
Newly admitted v3 tasks use the per-input reader described below.

Existing spec consumers use an explicit legacy projection even for invalid or non-done historical
output. Readiness is diagnostic here, not a new gate. `EFFECTIVE_SPEC_INPUTS` drives the host
adapter's resolved > checked > draft precedence, with `??` semantics followed by `|| ''`: an
intentional empty resolved body never borrows an earlier spec. Gate 1 and run config retain their
additional draft-summary fallback; 05a keeps its own `||` fallback. `resolveApprovedSpec`, test
management, gate 1, run config, 05 and 05a use these adapters. Human decisions, revise targets and
own-step replay remain physical.

House-rules task-text SQL intentionally stays physical. It selects non-empty specs by highest
round before stage precedence and caps text in SQL; the effective-spec adapter instead selects by
stage before round and preserves empty strings. Replacing that bounded SQL would change behavior.
Prompt steps have named `{{role:<input>}}` tokens for agent-only projections; neither role tokens nor
existing `{{step:}}` quotes can quote the mixed spec producers.
The original PR1 registry/spec adapters introduced no persisted spec pin or serialized catalog
reference. With v3 admission now available, follow the v3 rollback policy below and retain the
pre-existing v1/v2 support described below.

Rollback stops new replacement creation and retains v2-capable readers and workers for every resumable v2 task. Never downgrade pins to v1 or revert runtime support underneath those tasks.

## V3 per-consumer data-edge pins

New static, module-seeded, builtin workflow and derived tasks carry nullable
`tasks.data_edge_plan`, version 3, separate from the frozen v1/v2 derived plan.
Locked admission records ordered candidates, declarations, each position/input's
exact producer and contract, explicit optional absences, and a SHA-256 fingerprint
with recursively sorted object keys (array order stays significant). Admission caps
each candidate at 256 steps before edge validation. Ambiguous or dangling required
inputs refuse creation with no task, event or job. An ambiguous builtin workflow
catalog order refuses with 409 `catalog-order-invalid`.

The `locked` option of `definitionForCreate` is a required boolean, with no default.
All five task INSERT creators pass `locked: true` in their INSERT transaction:
`POST /tasks`, upgrade rollback, KB enrichment, `spawnPlanTask` and creator drafts.
Catalog table SHARE and row locks cover that INSERT, including module admission.
The saved-step CLI and integration previews, plus task-create and KB-enrichment
preflights, explicitly pass `locked: false`. These ordinary reads take no definition,
module or catalog locks and do not report `data-edge-catalog-busy`; locked admission
can still refuse a busy catalog.
Task list, detail, create and PATCH responses omit the full `dataEdgePlan`.

Spec stage inputs are independently optional; the host's effective-spec adapter keeps
resolved > checked > draft precedence, including intentional empty bodies. 06-run-config
and 08b declare the same inputs they read. Module declarations enter the same edge validator;
prompt declarations enter it too. Required prompt inputs are re-read before dispatch, including
a replayed detect snapshot; Retry and definition edits retain the pinned producer.
A present v3 binding is authoritative: the read uses the pinned producer and the
consumer's current-round ceiling, selecting the newest row before testing status.
A non-done pinned row cannot expose stale successful output. A done but schema-invalid
row reports `invalid`, with bounded issue paths, and retains the explicit legacy
projection from that same row so compatibility consumers do not silently lose findings.
Required invalid inputs still fail by name.

An input or whole consumer absent from an otherwise valid v3 pin reads through the
canonical no-v3 path, with exactly the same states and round semantics. It did not
exist when the task was admitted, so this is not a binding remap. Each such read logs
once at debug with task id, consumer and input only. An explicitly pinned optional
absence remains absent, and a present binding still wins over a canonical producer.
Malformed, tampered and wrong-version pins fail loudly before this fallback.
Without v3, canonical legacy resolution stays unchanged. Definition/catalog edits,
Retry, Resume, boot and dead revival never rewrite bindings.

Rollback stops new v3 admission and retains capable readers/workers until no v3 task
can resume. Leave the nullable column and applied migration; never regenerate,
downgrade or backfill pins. Compose passes `HAIVE_DATA_EDGE_ADMISSION_ENABLED` to the API,
with a default of `true`; `.env.example` documents it. Set the exact lowercase value `false`
and recreate the API through the install's supported lifecycle command to refuse ALL new
tasks whose plans would be pinned, with 503 `data-edge-admission-disabled`. This covers all
seeded static built-ins (`onboarding`, `env_replicate`, `onboarding_upgrade`, `kb_author`,
`plan_build`, `plan_chat`, `advisory`, `plan_sequence`, `plan_merge`, `type_draft`), `workflow`,
static admin/module types and derived types, including plan spawns, upgrade rollback and KB
enrichment. `run_app` uses an unpinned dynamic list and is unaffected, as are legacy/unseeded
fallbacks without a pin. Preflights remain available. The switch never touches existing
tasks: their readers, Retry, Resume and boot recovery never consult it. Keep capable readers
and the nullable authoring column while any affected task can resume.

## Pinned execution declarations (P6; admission only)

Migration 0245 appends nullable `execution_contract jsonb` LAST on
`task_type_definitions` and `tasks`, and nullable `guard_state jsonb` LAST on
`task_steps`. Database types are `unknown`; the shared strict version-1 decoder
owns their interpretation. No default, backfill, guard-state writer or guard
runtime ships in P6.

A static module seed may declare `executionContract: {version: 1, guardedSpans,
fixTarget?}`. A span is `{id, firstStepId, lastStepId, predicateId, args,
requiresSpan?, when?}`. Endpoints must be real, ordered run-list members; spans cannot
overlap or nest. `requiresSpan` names a strictly earlier span by run-list order,
so unknown, later, self and cyclic references are refused. Its runtime promise
for P7 is that the dependent span skips whenever the required span skipped,
regardless of the dependent predicate. Disjoint spans sharing a predicate id
share one task decision and must carry identical JSON args. `when` is an optional
boolean selecting the expected result, defaulting to true; `when: false` consumes the
false branch of that same decision, not a separate predicate. `requiresSpan` still
requires the earlier span to run, including on a false predicate branch.

Trusted predicate schemas come from the module’s optional schema-only
`./execution-predicates` export. Worker boot binds each declaration to the matching
`guardPredicates` callback in step code and requires the exact same args-schema
object in both exports; missing declarations/evaluators, duplicate or non-local ids
and schema mismatch refuse boot. See [Modules](modules.md#schema-only-predicate-registration-fence-closed)
for the SDK shape and comparison rationale. Stored ids or source strings grant no
executable authority. API never loads step code or evaluates predicates. Composition
projects every feasible predicate combination through the existing token,
ordering, entailment, loop-target and closing checks. A skipped producer cannot
supply a later mandatory requirement. The walk permits at most eight independent
predicate decisions (injectable in tests), with at most 32 spans in the DTO.
Empty execution paths remain invalid. `requiresSpan` excludes merged-without-
planned; it does not waive any token requirement. The scan validation fixture puts
normal `12-worktree-cleanup` inside the merged span and `12-no-change-cleanup`
in a separate `merged`-predicate span with `when: false, requiresSpan: planned`.
Its three feasible paths reach the unguarded report: no planned issues, planned with
no merges (no-change cleanup), and merged (normal cleanup). No scan seed is installed.
Normal cleanup still requires `commit`; no conditional requirement is introduced.

Draft/seed checks and the v3 admission writer select data edges once from the full
immutable run list and verify those same edges on every feasible guarded path.
A pinned producer may not skip independently of its consumer, even for an optional
bound input. Shared predicate results and `requiresSpan` can prove that a producer
always runs whenever its consumer does; being in different spans is not itself an
error. Explicit author choices must remain earlier and exactly compatible; the
validator never chooses a different producer on a filtered path. Optional null
bindings stay absent. No task pin, fingerprint, retry reader or recovery path is
rewritten by these planner checks. Predicate schemas are supplied by trusted schema-only
module registration, never reconstructed from stored JSON; validation never calls
predicate evaluation. The API passes its boot map to public/admin availability,
stored static detail and structural edits, guarded author-binding checks and the
final locked `buildDataEdgePlan` call inside `definitionForCreate`. All INSERT
callers share that writer. Schema registration changes no pin bytes or recovery
protocol and leaves the execution fence closed. Guard decisions, skipping and custom-fix execution remain
fenced off until their runtime PRs.

An optional `fixTarget: {stepId, capabilityVersion: 1}` must be an earlier,
capable run-list target on every path where an emitter runs. For validation,
core emitters aimed at 07 resolve through that selected target. A prompt step,
off-list id, non-capable executable or wrong capability version is refused.
This declares no output replacement role or host policy. The existing live
`fix_loop` runtime, target-specific CLI readers and diagnosis services remain
unchanged until P8.

The seeder owns execution declarations with its existing source-guarded upsert,
no-op test and hash; absent contracts preserve the previous hash bytes. All five
task creators copy the locked definition's execution contract beside
`data_edge_plan` in the same INSERT transaction. Task pins are never rewritten
by definition edits, Retry, Resume, boot or revival. Existing definitions and
tasks retain NULL semantics. An explicit empty contract is inert and pinnable.

P6 refuses any guarded span or selected fix target at create, API START and
worker START/advance with `invalid-execution-contract` and “not yet supported by
this worker”. A rejected create or API START writes no task state, event or job.
A worker START or ADVANCE refusal instead marks the existing task dead under
its held epoch, keeps its status and immutable pin, and records one `task.dead`
event with the named reason. Duplicate delivery and the stalled sweep leave
that dead task alone. Boot marks unsupported snapshot-task pins dead; revival
refuses while support is still missing (see [Worker restarts](worker-restarts.md#dead-tasks)).
Main task responses omit the full contract. Admin create/PATCH and creator
drafts expose no contract authoring.

The API also checks the immutable execution pin before task Retry at a step
(including direct helper callers), step Retry, Resume, Skip or AI Retry, form
or clarification submission, and step CLI changes. Turning on auto-continue
while a task awaits an answer uses the same refusal. Owner and administrator
pause Resume refuse unsupported pins before clearing a standing hold.
An unsupported or malformed pin returns 409 `invalid-execution-contract`
before any row reset, answer/event write, sandbox kill or job enqueue.
Lifting the global pause succeeds for ordinary work while leaving unsupported
tasks held: an existing per-task pause keeps its timestamp; normally a task held
only by the global switch receives an audited administrator pause before the
switch is released. Before borrowing the configuration save's connection or taking
its advisory lock, the lift reads the stored switch and commits each hold in its
own compare-and-set transaction with its pause event and audit row. This prevents
a lock owner from waiting for a second connection while concurrent saves fill the pool.
An already-off switch leaves task rows and pause evidence unchanged. A concurrent
switch-off or a later lift failure can leave extra holds on unsupported tasks.
The configuration save returns the previous values it read under its own lock,
which also supply the audit's `from`. If the pre-read said off but the locked
previous value was on, the lift runs the same hold pass once after the save,
outside the configuration transaction. This narrows, but does not close, the gap:
a task the worker starts between the save and its hold is stopped by the worker's
fence and marked dead rather than held.
Each task hold has the same 30-second lock timeout as the configuration save;
a lock timeout answers 503. A failure before the configuration write leaves the
global switch unchanged. A failed post-save pass leaves the switch off without
holds; turn the switch on and lift it again to re-run the holds.
Earlier committed holds remain if a later hold or configuration write fails.
The response lists `skippedTasks` with task id, refusal code and reason when any
were held back.
The worker's existing boot and duplicate-advance fence remains authoritative
for already queued work. Stop, Cancel and step Abort
remain available; NULL and explicit empty execution contracts retain their
existing behavior. This adds no guard evaluation, skip writer or custom fix execution.

Deployment is worker first: deploy workers carrying the independent
`worker/src/step-engine/execution-contract-support.ts` refusal before deploying an API
that can admit active contracts. START/advance run-list construction and boot/revival
check this worker-local capability even if shared/API admission has become permissive.
An unsupported admitted task is marked dead with its immutable pin and resumable state
retained; it never executes an unguarded list. Both admission and worker
fences stay closed. A future activation must wire the worker runtime before lifting the
local refusal, then enable API admission. Workers predating the execution contract fence (#1222)
cannot safely receive admitted guarded tasks; upgrade them first.

Rollback stops creation of contract-bearing types and retains nullable columns,
the applied migration and every immutable pin. Never erase or remap a pin to
make rollback appear safe; once P7/P8 admit active pins, retain capable workers
for every resumable task.

## Guard decisions (PR4a; dormant)

`worker/src/step-engine/guard-decisions.ts` adds an unwired decision service.
The API admission, worker START/advance, boot and revival fences remain closed.
No production caller invokes it or the dormant span skip/advance service described
below. The decision service itself writes no skip, task pointer, recap, output,
event or enqueue. Ordinary NULL and explicit empty
contracts return without opening a transaction. No scan seed is installed.

A future caller supplies the owned pending span-entry row, round, rerun generation
and epoch. The service reads the immutable task contract and run-list snapshot,
locks extant task steps in id order, reads the task FOR SHARE, then validates
the PR3 span/predicate rules under those locks. It refuses foreign owners, off-pointer
work, stopped, failed, dead or completed tasks and stale epochs/generations. It never creates a
missing entry row. It considers only held rows and never waits for another step
row after taking the task fence.

A fresh predicate receives a narrowed transaction-bound context identifying the latest
settled predecessor row at or below the decision round: exact taskStepId, producer
round and producer generation. It must query structural rows using that identity,
including task_dag_plans.task_step_id, rather than task-only plan selection.
Missing, skipped, failed or unfinished producers refuse; trusted predicates must
throw for absent/unreadable structural data. Only a literal boolean is accepted;
exceptions and non-booleans roll back rather than becoming false. Failures keep their
original cause and log through the sanitising logger with task/span identity; public
errors contain no predicate text. TaskCancelledError passes through unchanged, and
non-booleans have the separate predicate-non-boolean reason. Failures persist no
decision row.

The context carries only task/user/producer ids, producer round and generation,
the transaction, logger, cancellation signal and cancellation check. Repository,
workspace and sandbox path getters throw; emitProgress rejects, so it cannot wait
on its own held row through the runner's pool connection. No host service or CLI
configuration is supplied. This is defence in depth for trusted module code, not
a sandbox: predicates must use structural reads only, with no external effects or
detached work.

The transaction first sets LOCAL statement_timeout to 5000 ms and lock_timeout to
1000 ms before its step batch. Predicate evaluation races a 5000 ms deadline;
expiry becomes predicate-evaluation-failed and rolls back. An in-flight SQL query
can delay rollback until its own server statement deadline. The predicate signal
also aborts when its lifetime ends, and its timer is always cleared. These limits
are injectable for controls and must be positive safe integers at most
2147483647 ms (the common Node/Postgres maximum); invalid limits refuse as
invalid-deadline. They do not preempt synchronous JavaScript. A late query through
the predicate's rolled-back transaction rejects with UNSAFE_TRANSACTION.

The strict v1 record in existing task_steps.guard_state binds task, round, span,
entry generation, the SHA-256 hash of the pinned list/contract (object keys sort
recursively by code unit, integer-like keys numerically as JavaScript objects
order them, independent of locale), producer identity and
predicate source/result. A requiresSpan reference binds its earlier entry and
generation. Dependency suppression records run:false without evaluating another
predicate. Disjoint spans reuse an earlier committed result for the same predicate;
when:false consumes its opposite branch. An earlier dependency-suppressed span has
no result to reuse, so the first eligible span evaluates at its own predecessor.

Evaluation and the one guard_state UPDATE share the transaction and ordered locks.
Concurrent duplicate requests serialize; a committed replay reads the same result,
including across process/client and recovery-epoch changes. A rollback before the
write, after it or at commit leaves no decision and may evaluate again. This is
exactly-once committed persistence, not exactly-once invocation of a callback.
Malformed, stale and inconsistent references refuse rather than recomputing.
It currently requires same-round span-entry decisions and a pinned static list.
A stored decision also replays on its skipped entry; no predicate runs again.

No migration is needed: 0245 already appended the nullable column. Rollback reverts
this dormant code and leaves 0245, guard_state and every execution pin intact.
Once execution is enabled, retain capable workers for all resumable guard-bearing
tasks; never erase a pin or decision to permit an older worker.

## Owned span skips (dormant)

`worker/src/step-engine/guard-span-skip.ts` provides the unwired skip writer and
advance caller seam. Admission, START/advance, boot and revival still refuse
nonempty execution contracts; a source-tree control refuses production callers
of either guard service. No scan seed or runtime activation ships here.

The skip writer takes the same bounded id-ordered task-step batch, then the task
FOR SHARE fence, validates owner, live status, epoch, round, pointer and entry
generation, and revalidates the stored decision and its producer/dependency
references. It requires run:false and never evaluates a missing decision. Every
member must already exist in the same round among the held rows. The activation must
materialize every member row before the decision/skip lock batch, never after
taking step locks or the task fence; missing members return a non-retry refusal. A pending member
must have no detect/form/output, apply receipt, recap, iterations, active wait or
started/ended timing, and no unsuperseded invocation (including recap invocations)
or agent-mining row. A non-pristine member refuses the entire transaction.

All member skips commit in one transaction, stamping ended_at and updated_at at
the same instant so finished-row redelivery deduplicates step.skipped by endedAt.
The entry retains its strict decision;
other members receive version-1 guard-skip receipts binding task, round, span,
entry row/generation, contract hash and their own generation. Already skipped
members replay only with the matching receipt and empty work fields; ended_at
and updated_at do not participate in replay identity. A duplicate
writes nothing, a partial transaction rolls back in full, and stale jobs cannot
adopt a newer generation's skip. No output, recap, event, task pointer or queue
write occurs in this transaction. The unchanged entry pointer remains a durable
handoff recovery anchor. The advance seam calls a supplied, epoch/pointer-fenced
finished-row handoff only after commit. Failure before enqueue or loss of its
acknowledgement can retry from the same decisions/skips without step work. A
future runtime integration must use that fenced handoff and retain duplicate
advance checks. Only producer-not-settled, decision-write-lost and skip-write-lost protocol reasons, plus SQLSTATE
55P03/57014/40P01/40001 (including raw lock batch errors), return retry.
Predicate errors without a transient SQLSTATE, including deadline expiry and
non-boolean results, refuse. Other GuardDecisionError reasons also return
{kind: refused, reason} without handoff:
member-not-pristine, missing-member, stale producer/decision/dependency identities,
malformed-state, invalid-span and lost owner/epoch/pointer fences cannot heal by
redelivering the same job. Unknown errors propagate. The activation must handle refusal
explicitly rather than scheduling another retry indefinitely. In particular,
`refused` from a predicate deadline means this pass stops and an existing redrive
path decides what happens next; it is not an instruction to immediately retry.

The runner's `holdReopenedForm` and its `nextGeneration` branch are one generation
write, not two independent bumps. A guarded in-place new attempt consumes folded mining
rows first, takes the task's id-ordered step batch, then checks the owner, live task,
epoch, pointer, round and expected generation under the task SHARE fence. In that same
transaction it rebinds the retained run:true decision and its shared-predicate,
requiresSpan and producer references to the new generation, clears old form inputs
and sets the durable form hold. It preserves committed branch results and owned skips;
it never evaluates a predicate or reopens a suppressed span. Missing ownership,
stale references and suppressed entries refuse and roll consumption back. A crash
before commit rolls everything back; a lost acknowledgement cannot bump the old pass
again. Recovery sees the held new generation. Explicit upstream reset still clears
that generation's decision and form through the normal reset helper. Production
execution remains fenced; this reconciliation does not activate guarded execution.

Explicit upstream Retry/rerun clears forward guard decisions and skip receipts
in the same round, including pending decisions observed after the ordered lock
batch. Owned skipped members reopen pending with a new rerun generation, alongside
the ordinary reset. A row whose guard state appeared after the initial read is
swept with NOWAIT on its runs and agents before it is reset; a busy run rolls the
transaction back rather than reversing the run/step lock order. Selection follows
run_seq with legacy step_index fallback,
conservatively invalidating all forward decisions rather than reinterpreting
predicates. Task Retry and the owner step Retry share the API reset helper; worker
revise/recheck/fix resets use the same loaded-row selection. A full START Retry
also invalidates recorded branches. Resume of a degraded done fan-out invalidates
its regenerated downstream producers, decisions and owned skips by the same rule.
A degraded done producer's Resume rescans forward from the clicked row under the
ordered batch even when its initial downstream reset set was empty. Decisions and
owned skips committed between that read and the lock are reset; the clicked producer's
saved work and generation remain intact. Extra runs/agents use NOWAIT, and a busy run
rolls back the entire Resume. Resume preserves guards only on rows whose work it retains
(left-active recovery and the loop arm). Recovery preserves decisions and member generations; guard-owned skips are excluded from recovery resets. Stop,
BullMQ boot requeue, stalled handoff redrive and dead revival do not erase them.
The immutable execution contract and run-list pin never change.

The pin gates wider reads and locks: ordinary worker resets keep main's exact
inArray(allStepIds + heldStepIds) lock and inArray(id, allStepIds) reset read;
ordinary API resets keep their existing task-wide lock and caller-ids-only read.
Neither reset emits a no-op guard_state SET for an ordinary pin. Both reset helpers
accept an optional executionContract: callers pass their already-loaded immutable
pin, so ordinary production resets add no statement. Worker orphan reconcile carries
the pin in its existing joined task/step read. Only when the argument is undefined
does the worker project the pin before its transaction, or the API project it on
the supplied transaction handle, respectively. Explicit null and empty contracts
do not trigger a fallback read. START uses its already-loaded pin and adds no
ordinary full-step SELECT. Only
guarded tasks widen to same-round rows at or after the target (run_seq, else
step_index), with explicit owned handoff ids still held as before. The API's
existing task-wide lock remains necessary for its later bulk writes. No reset
lock_timeout is added, preserving ordinary behavior; the dormant guard services'
bounded timeouts remain unchanged.

The API helper returns extra rows with their pre-reset liveness. Retry, task moves,
fan-out Resume and pending provider changes include these in audit/touched sets
and post-commit sandbox cleanup. A separate retained Resume reset after the batch
sweeps runs with NOWAIT, never waiting backward across the run/step lock order.
On guarded pins, reofferParkedSteps and settleActiveStepsIn clear guard_state
alongside every rerun_generation bump: retained form/detection data is not a reusable old-generation
guard decision. Production callers supply the already-loaded pin, so ordinary
START adds no pin read and ordinary park SET clauses also omit guard_state. Direct
helper callers may omit the pin and get a cheap projection pre-read. Guard-aware
resets retain ownership of their forward cascades.

Real-Postgres controls cover duplicate/stale requests, a crash after the first
member UPDATE, enqueue cuts, both API Retry paths, worker rerun, Stop/provider
Resume, orphan boot reset, stalled handoff and dead revival. Capability refusals
are isolated at the test seam for these dormant recovery controls; production
refusal controls remain unchanged. Unit variants exercise pristine-state and
receipt checks. No DDL is added. Rollback reverts the dormant services/reset
support and retains migration 0245, nullable guard_state and all immutable pins;
once execution is enabled, retain capable workers for every resumable pin.

## Derived overlays (PR4 of 4)

Derived types are admin-authored overlays of the built-in workflow. The API and worker support
admission, task pins and triage; the existing web editor authors the overlay. V1 accepts only the builtin `workflow`
with `workflow_paths`. Admin/module/derived parents are refused. `run_app` remains ineligible:
it chooses a runtime after `01-declare-deps`, lacks complete composable lists and needs a
finalization seam separate from triage. Derived `requiresRepository` follows the locked base.
The base and strategy are immutable after creation. Module manifests remain static-only.

`derivedChangesSchema` accepts strict `{replace, with}`, `{insertAfter, step}` and `{remove}`
operations. Extra keys, invalid namespaced IDs and IDs over 128 characters are refused. An empty
overlay is legal. All HTTP routes use the fixed `MAX_DERIVED_CHANGES` (64), never a request-supplied
bound; small injected bounds exist for controls only. Operations apply sequentially to actual IDs:

- `applied` changes the list. A target known on another base path is `path-absent`; a target absent
  from the whole base and not earlier introduced is `stale-target`. Both skip without inferred renames.
- A consumed target is `target-removed-by-change`, a hard issue. Removed IDs never alias replacements.
  Earlier inserted steps may anchor later changes; a skipped producer propagates its reason and root
  operation index through chains. Repeated inserts put the later insertion nearest the anchor.
- Active replacements are one-hop and limited to code review and broad code audit. An installed composable payload must explicitly declare `replaces`, name the exact host contract id/version, explicitly provide every role token, preserve host policy and remain the unique producer. All candidates must compose. Applied replacements splice the physical ID at the target position and consume the canonical anchor. A stale or off-path replacement still has an explicit skipped outcome. Implementation, gates and the prefix are forbidden replacement targets.
- Replacement diagnostics name path, operation, target, payload and expected/actual contract references: `replacement-target-forbidden`, `replacement-not-composable`, `replacement-not-declared`, `replacement-contract-mismatch`, `replacement-policy-incompatible`, `replacement-role-ambiguous` and retained `replacement-contract-unavailable`.
- Missing active payloads, duplicate final IDs and every `validateComposition` issue refuse the
  overlay. Prompt quotes are checked per candidate; orphan prompt definitions against the union.
  No additional server rule forbids removing an implementation step or gate: composition decides.
- The exact prefix `00-model-health-workflow`, `00a-sync-base`, `00-triage` is protected on every
  candidate. Remove/replace and insertion inside it are refused; insertion after triage is legal.

Warning summaries are deduplicated by `operationIndex`, name the operation/target and list affected
candidates inside each warning. Save/create permit stale anchors only when every candidate validates.
Missing/deactivated active module payloads are hard failures. Editor/detail diagnostics use today's
base; task warnings remain the history pinned at creation. Obsolete-default notices are pinned separately in
`defaultWarnings` and returned with task warnings. Neither seeding nor a later preview rewrites history.

**Locked admission.** `workflowBaseCandidates` expands null/pre-triage and every `EXECUTION_PATHS`
value through the existing selector, including the environment prelude. The API reads coherent
`step_catalog` workflow type/index data under share locks and reconstructs registry index order;
ID sorting is insufficient. Unsynced catalogs, NULL indices, duplicate IDs and ambiguous indices
are named admission issues. Catalog/registry parity controls include every ordered candidate.

Task creation reads overlay/base `FOR SHARE` and referenced modules `FOR KEY SHARE` in the INSERT
transaction, evaluates all complete candidates and applies existing module/switch policy. `inspectDerivedDefinition` parses the proposed pin before any write and reports `invalid-derived-run-plan` if replay fails. Authoring answers 400 and task admission answers 409; a replace-then-remove whose payload declaration is no longer retained is refused here. Invalidity
returns 409 with structured path/operation issues and no task, event or job. Existing preflight versus
locked trait checks still refuse changed root/database/repository policy. No connection is held over
queue IO. Module-state checks include active attempted payloads even when installed-step
validation refuses their insertion, so a removed module is named before a composition error.
Stale/off-path skipped operations and payloads behind skipped producer chains do not introduce
module dependencies.

At INSERT, `derived_run_plan` stores base identity/strategy, overlay revision/changes, ordered base
candidates and catalog fingerprint, composable declarations, all final candidates/outcomes, common
prefix and warnings. Applied replacements additionally pin v2 contract refs, candidate bindings and effective declarations under the same definition/base/catalog/module locks. For v2 the fingerprint covers actual order/declarations/bindings; v1 retains the byte-identical catalog-only fingerprint. Neither uses workflow's null-list
`content_hash`. `run_list_snapshot` initially holds the full/null candidate; `custom_steps` pins raw
prompt definitions used by any candidate. Traits, canary, module admission, integration admission and
saved-step CLI previews use the candidate union before selection. Integration previews identify steps
that may run after path selection. Dispatch still resolves each required account.

`assertStepOutputDeclaration` refuses `replaces` together with `metadata.allowSkip: true` at registration or override, preventing a failed review replacement from being skipped past gate 2. A bound replacement receives the host role requirements, ordering, entailments, loop target and closing policy; its own declared tokens must satisfy them. Runtime review uses the host run decision and canonical finding-based fix evaluator: a module’s `shouldRun` cannot suppress a bound review. A standalone module step retains its own run decision. Audit stays report-only, retaining the host broad-audit/worktree skip AND the module’s own `shouldRun` when present. Replacement-capable executables cannot supply conflicting loop/error hooks. No binding inherits host CLI seats, dispatch preferences or grants.

**First triage.** Only the common prefix executes before selection. The derived-only selection
transaction locks the owned step before the task, checks current step/round, epoch, live status and
selection state, then validates the chosen candidate against pinned declarations and resolves its IDs.
Missing executable code marks the task dead by name. Missing support for a pinned contract or role policy is `pinned-step-support-unavailable` at triage, START, advance and boot recovery; it never remaps a producer. It atomically stores path, broad-audit choice,
chosen snapshot and event; an event failure rolls back selection. This is the sole UPDATE exception
for `run_list_snapshot`, only on an unselected derived workflow. `derived_run_plan` and `custom_steps`
remain INSERT-only. Same-choice replay is idempotent. A different choice is `derived_path_pinned`:
“Create a new task to change path.” Triage Retry displays the pin; Skip before selection is refused.

`handleResult` refreshes path/snapshot before choosing a successor. Retry, full Retry, Resume,
fix/revise resets, duplicate delivery and boot recovery reuse the pin, including death after selection
but before handoff. Execution, dead-task, provider-disable and context readers prefer pinned state
independently of definition edits. Read paths validate strict pinned shape/invariants only, without
re-running composition rules; composition is validated at admission, preview and first triage for
the selected candidate. An unselected derived task that exhausts the common prefix fails by name
with derived_path_unselected instead of completing. Malformed/missing required plans fail by name and never fall back
to an empty custom-slug registry list. Module dependency/deactivation/purge checks inspect the pinned
candidate union before selection and chosen snapshot afterward, without reading live overlay JSON.
A non-secret per-category module admission map is pinned at task INSERT so retained integration
admissions, choices and grants from an unselected-only candidate do not keep its module dependent.
Live invocation bindings still protect modules they use; selection does not delete those bindings.

Presets and loop limits belong to the derived row; there is no live inheritance of base defaults.
Keys are validated against the candidate union, with limits 1–50 only on `loopBudgetEditable` steps.
Request limits win. After an upgrade, obsolete saved defaults are reported and omitted from a new task;
explicit invalid default edits still fail. Selection prunes irrelevant task defaults without editing
the definition. `06-run-config` retains omitted-answer semantics and reads pinned derived membership
for QA/browser options.

**API.** The strict derived POST branch is mutually exclusive with static `stepIds` and accepts
`runListStrategy: 'derived'`, `baseSlug` and `changes` alongside admin metadata/defaults/prompts.
PATCH permits changes only on derived rows and cannot change slug, source, strategy or base. Existing
field ownership, `expectedUpdatedAt` 409/Reload, transactional audit and refusal to DELETE while any
task uses the type remain. Flat edits can save with diagnostics while an overlay needs attention.
`POST /admin/task-types/preview` is registered before `/:slug`, requires auth plus admin, and writes
nothing (no audit). It accepts an unsaved payload and returns eligibility/revision, candidates,
operation outcomes, warnings, composition/default/prompt issues and fingerprint. Save/preview
invalidity is 400; authoritative task admission is 409. Detail recomputes the same diagnostics.
`GET /task-types` returns a non-secret warning/availability summary; creation and task detail expose
stored application diagnostics. Task list and detail/poll payloads omit the full pinned plan; detail
still computes and returns historical warnings before stripping it. A persisted derived row never
makes either list endpoint return 500.
The creator protocol and panel remain static-only; existing static editor/draft behavior is unchanged.

**Editor.** Built-in list/detail actions use catalog eligibility: “Duplicate and customize” opens the
existing create editor with a blank slug, copied display metadata, the base slug and no changes,
without writing. An empty base query opens the static editor. Ineligible actions show the catalog's
precise reason. The Operation dropdown renders “Replace — Only steps declaring this role and its output contract can replace it” as its option label; the replacement row shows expected and actual contract references and the protected-target reasons. FormRenderer authors ordered operations live, including incomplete/invalid rows,
without a separate per-operation submit action; the composer reuses its palette, prompt
editor, loop limits and integration overview beside a read-only path preview. There is no editable
flattened base list. Shared evaluation runs on edits; server preview is debounced 350 ms and aborts
or ignores superseded responses. Neither response replaces unsaved fields or operations.
Skipped-on-path and stale-target warnings remain separate. Stale warnings merge by operation index
and warning kind, with server diagnostics taking precedence. Removing a core gate (matched by exact
step id) or implementation step warns without adding a prohibition beyond server composition validation. Orphan prompt definitions
stay repairable. Presets/limits belong to the derived row, with obsolete defaults reported rather
than inherited from the base. Saves send overlay/admin fields only, respect editableFields and
expectedUpdatedAt and retain Reload on 409. Derived authoring stops retries after 403 and keeps the
reason visible until a successful reload; static saves retain their existing retry behavior. Create
preserves the base's repository requirement even though that field is absent from the derived form.
The admin list shows current
diagnostics; task detail renders the warnings historically pinned at creation through MarkdownView.

Pins freeze ID order/selection and raw prompts, not historical code or account availability.
Rollback disables new derived creation and retains a capable worker until existing derived tasks
cannot resume; reverting runtime while those tasks remain is unsafe. The additive storage and
maintenance cleanup policy above still apply. See the [delivery plan](../plans/deeppattern-module.md#part-a-derived-task-types-core).

## The admin api and the editor

`GET|POST /admin/task-types`, `GET|PATCH|DELETE /admin/task-types/:slug`, `GET
/admin/task-types/catalog` (admin); `GET /task-types` (anyone signed in: enabled and selectable rows,
with availability and public traits); `GET /task-types/:slug/saved-step-clis` (anyone signed in: the
steps of that type's run list, prompt steps included, on which the caller saved a per-step CLI, and
`defaultProviderId`, the provider every other CLI step falls to; see
[Step summaries](step-summaries.md)). Every write is audited (`task_type.create`, `update` with the
field list, `delete`). The row is inserted in the change's own transaction and logged after
commit, so an audit refusal undoes the create, update or delete. Draft start records
`task_type_draft.start` with the task, opening message and queued state in their transaction,
before enqueueing START; it never records message or prompt content.

- **Static create** runs, each stage a 400 with `issues`: built-in slug (409) → strict schema → slug taken
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
- The admin catalog's optional `unavailableSteps` contains already-persisted, parsed declarations
  filtered out of `steps` because their module is deactivated. Selected rows may read these only
  for the integration overview. Palette, validation and availability still use `steps`,
  `registeredStepIds` and module state; an absent module's lost declaration is never reconstructed.
- **Step panels** (`UiPanelSpec`, `BUILTIN_STEP_PANELS`, `resolveStepPanels`) are a web table keyed by
  step id: a custom type reusing a core step gets its panels; module and prompt steps get none.

The Steps section offers List (the default keyboard view) and a client-only Canvas.
With no author bindings, the canvas and binding list retain the server's display-only
projection of the current serialized draft from `POST /admin/task-types/ports`, including
catalog titles and server diagnostics. `GET /admin/task-types/:slug/ports` projects a stored
static type or each derived path. With author bindings, one memoized local projection uses
the same declarations, catalog labels, selected candidate's v2 `roleBindings` and
candidate-local `dataRoleBindings` as server validation. Canvas and list share it. A stale
choice or an invalid declaration becomes a visible issue; the step list and selected-binding
Clear binding actions remain usable, even after a module or input disappears or changes.
Draft port projection alone caps static lists at
`MAX_PORT_DRAFT_STEPS` (256), over four times the 59-step stock workflow (including the environment
prelude). Invalid or reserved in-progress editor slugs use a projection-only placeholder.
Ports show role, exact contract version, authorship, optionality and
wired/ambiguous/dangling/optional-absent state from the shared pure `validatePortEdges`.
The validator indexes earlier producers by role and exact contract once, with work linear
in ports plus the candidate identities returned. Bindings and canvas endpoints carry run
positions so transient duplicate step IDs remain distinct. The effective-spec input shows
the existing ordered host adapter, not a new direct consumer declaration. Worker controls
compare spec declarations and adapter/review reader inventories with this projection.
Ambiguous and dangling required inputs block save and admission. An optional absence is
allowed; an explicit producer choice must still be earlier and exactly compatible.

Static canvas drag and list reorder share the existing draft mutation and
`validateComposition` diagnostics. A move introducing a composition problem is refused
with the existing message; an already invalid draft can still be repaired. List announcements
stay screen-reader-only; Canvas displays them while open. Derived path order remains
read-only in both views; overlay operations are the editor's writer.
`GET /tasks/:id/ports` is owner-scoped and projects canonical history or the validated
v1/v2 candidate pin. Selected paths show their review/audit bindings. An unselected task
shows only the null-path candidate, clears replacement bindings and labels the graph as
candidate-only. A missing selected path displays an explicit unavailable state. Edges never
consult a live catalog or definition; the route may read the live definition's strategy
only to identify a missing required derived pin, as the existing output-role projection does.
The response omits the full plan and output bodies. History nodes use persisted step titles.
Task history defaults to its existing list; opening Canvas keeps step cards and approval
forms visible, and an empty task has no view toggle. Canvas positions and selection never become task or definition state. A connection and the
List producer selector both update the same serialized `dataRoleBindings` list of
`{executionPath, consumerStepId, input, producerStepId}`. Static choices use a null path;
derived choices are candidate-local. Clear binding removes an author choice. No independent
graph store is saved. Catalog entries now retain data declarations; old v1/v2 pin bytes and
reads remain unchanged. For a core input absent from a valid v3 pin, history adds the canonical
compatibility edge that the worker reads, without changing the pin.
`@xyflow/react` is pinned to 12.9.3; its stylesheet and inline positioning styles pass the
existing CSP without a policy change.

## Prompt-template steps

An admin type may carry prompt steps (`prompt_steps`, keyed by the step slug; never on built-in or
module rows). Each is `{slug, title (≤512), description?, template (≤16 KiB), paramFormSchema?,
capabilities (tool_use, file_write, vision), tools (≤8), integrations? (≤8), timeoutMs (60 s–30 min),
agentPool '*', consumesRoles?, providesRoles?, outputMode?: 'structured'}`. No field can turn agent rules, the MCP surface or tools off: a prompt step gets agent
rules whenever the install's agent-rules switch is on, and always gets the containment lines.

**Pinned raw, parsed per tool and per requirement.** `custom_steps` holds the entries as stored; readers
parse tools and `integrations` one by one and name a bad one in `invalidTools` / `invalidIntegrations`
while the step survives. A whole-entry parse would drop the step when a release tightens one tool bound
— and a task whose current step is missing goes dead.

**The worker synthesises each prompt step per task** from the pinned copy (memoised per task and id, at
most 256), never from a registry: a registry keyed by id cannot hold two versions of one id for two
tasks, and a template saved after boot is unknown to it. Detect reads the task title and description and
the output of the latest done row of every quoted step at a round no later than the current one (a
retried older round could otherwise quote its future). Raw-mode apply stores the reply read back
from `cli_invocations` by invocation id, so a later quote sees the exact reply. Structured mode stores
only the validated role payload; physical step quotes and history render its contract/data as JSON.

**Tokens:** `{{task.title}}`, `{{task.description}}`, `{{field:<id>}}`, `{{agent:<id>}}`,
`{{step:<stepId>}}`, `{{role:<input>}}`, `{{integration:<id>.account}}`. The renderer makes one pass and never rescans a
value; a value mid-line is collapsed to one line, and step/role quotes must sit on their own line.
Quoted step output is fenced; field values, the title, the description and account texts are not.
Every value is capped: each quote or other value at most 16 KiB, all quotes 64 KiB, all other values
(account texts included, each occurrence counted) 64 KiB, and a cut value's `[truncated: …]` notice
counts inside its share. Any `[[HAIVE_` overlapping a value and any leading `<haive_` opener is broken, so a value cannot
forge a marker or a preamble block. The save check (`validatePromptStep`, `checkPromptSteps`) refuses
unknown tokens, undeclared fields, a persona or a file-writing step on a repo-less type, a step quote
that is not earlier, not on its own line or not quotable, reserved markers, a missing or orphan entry,
undeclared, inline/nested or non-agent-only role inputs, invalid role/contract versions,
structured mode without exactly one providable role, role providers without structured mode,
providers carrying host policy or human/mixed authorship, and the size and range limits.
Required role edges must have one earlier compatible producer or an explicit author binding;
dangling or ambiguous edges refuse Save. These role checks also run for creator drafts,
stored-definition admission and worker execution. A step is quotable only when its stored output is purely agent-authored
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

**Role inputs and structured output.** A prompt input is
`{input, role, contract: {id, version}, optional}`. The own-line token names `input`, not a
physical producer or role id. Inline and nested role tokens are refused at save, admission
and render. Only registry entries with `authorship: 'agent'` and the explicit agent-only
`quoteProjection` qualify. Unknown, human and mixed roles are refused even when a stored
entry bypassed Save. Successful reads project declared fields at every object boundary;
passthrough storage keys and iterations never become quoted text. Quotes use the same
16 KiB per-occurrence and 64 KiB combined step/role budget, fencing and persona-marker
neutralisation as step quotes. Detect and pre-dispatch refresh persist only projected quote
text capped at 16 KiB per input, with bounded metadata, never a full duplicate role body. Older
detect snapshots containing role data remain readable. House-rules path text excludes both kinds of quote.

A prompt step can provide only a registry role with no `hostPolicy`, `authorship: agent`
and an explicit agent-only `quoteProjection`. Review, audit and all spec stages are refused
at save, draft validation, admission and execution; module seeds cannot contain prompt steps.
Today no production role qualifies. Positive controls register an agent-only
role through test mocks, never in the production registry. A prompt step can provide exactly
one eligible role with `outputMode: 'structured'` and
`providesRoles: [{role, contract: {id, version}}]`. Haive appends a fresh host-owned JSON
schema and requires a strict JSON envelope `{contract: {id, version}, data}` with no prose
or fences. The host parses the recorded raw reply itself, not the CLI's repaired/extracted
parse. Before parsing, the UTF-8 reply must fit the 256 KiB limit (injectable in tests).
Oversized valid JSON, missing text, an unavailable/wrong version or invalid data raises
`StepOutputContractInvalidError`, visibly fails the producer and cannot route to 07.
Structured `task_steps.output` stores only `roleOutput: {role, contract, data}` once,
without duplicate `raw` or `parsed` bodies. Successful-output validation and role readers
use the same unwrapping helper, checking the envelope role and exact contract before
validating its data. Core and module producers still validate their direct payloads.
Role readers revalidate that payload; physical step quotes and history serialize its
contract/data envelope. The invocation retains its existing CLI capture. Raw-mode output remains `{raw, parsed}` and cannot provide roles.

Both arrays are data declarations: they grant no `replaces`, executable `outputContract`,
review/audit policy, seat, persona, skip or fix-loop authority. Module declarations retain
their separate restrictions. Admission and the canvas use the merged prompt catalog,
including producer choices. The existing editor authors inputs and optionality, inserts
own-line tokens and rewrites matching `{{role:}}` tokens when an input is renamed.
The parent editor moves that step's author bindings to the new input name on every
candidate path, preserving their producers. A target name that already has an input or
binding is refused visibly without changing either declaration or binding.
Structured mode starts with no provided-role selection; the select lists only eligible roles.
With none registered, the toggle and select are disabled with an explanation.
Mode/declaration edits count as unsaved.
Creator drafts retain these keys and validate data edges with the same shared validator.

No migration or task-pin rewrite is needed. Rollback stops admission of feature-bearing
types and retains capable readers/workers while their tasks can resume; do not erase
`custom_steps`, role payloads or v3 pins to permit an older worker to run them.

**Integrations.** A prompt step may declare up to 8 integration requirements `{id, category, access,
optional?}`, pinned with the step and read per requirement like its tools. The save check refuses an id
outside `^[a-z][a-z0-9-]{0,15}$` or repeated within the step, two requirements of one category (a step
gets one account per category), a category the install does not register (the api passes
`listIntegrationCategories()`; the web composer loads core and active-module categories from `GET /integrations/categories`), a pinned `provider` (a
prompt step names a category and Haive resolves the account) and a repository-bound category (`forge`)
on a repo-less type. Dispatch hands the pinned requirements to the broker exactly as a catalog entry's
(see [Integrations](integrations.md)); one that no longer parses fails the step
`integration-requirement-invalid` before anything resolves. Drafts carry none, so a draft's
`{{integration:…}}` is refused as undeclared.

The prompt-step editor's Integrations section authors the requirement id, category, read/write
access and optional flag, and shows its `{{integration:<id>.account}}` token. Module categories
come from the authenticated categories list; the editor uses the same ids for its live validation.
A stored unavailable category stays visible, and malformed entries stay in the form until repaired
or removed. Editing one entry never drops an invalid sibling; choosing a category replaces a stored
unsupported provider pin. Integration-only edits count as unsaved composition changes and are sent
on save. Selected rows also show the category, required/optional access and registered provider install
state in create, edit and read-only views (see [Integrations](integrations.md#composer-capability-overview)).
The overview reads raw prompt requirements so an invalid entry or unsupported provider pin remains
visible until repaired; changing a requirement updates that row immediately. Generated integration
drafts remain separate work. The New Task picker and transactional create admission are documented in
[Integrations](integrations.md#new-task-admission).

`{{integration:<id>.account}}` names the account the declared requirement `<id>` resolved to at this
dispatch: the connection's account label when, cut to 200 characters, it is one line, survives the
fence, opens no code fence and names no agent path; otherwise the provider's name; and
`(no account connected)` for an optional requirement that resolved to nothing. It is always collapsed
to one line and treated as a dynamic value, so `[[HAIVE_` and a leading `<haive_` in a label are
broken. House-rules text gets no account. The stamped run must carry the connection each named
account was rendered from; if the task's choice moved in between, the dispatch writes nothing and
fails `integration-account-changed`, and a retry renders the new account. The save check refuses an undeclared id
(`integration-not-declared`) and any other property (`integration-property-unknown`).

## Custom tools

A prompt step may declare up to 8 tools — `http-get` and `rag-query` — stored on the step and pinned
with it.

- **Wiring** (worker). Before a prompt step with tools dispatches, the runner (`resolveCustomTools`)
  re-checks the pinned tools against today's save rules that do not depend on the task type
  (`pinnedToolsFailure`: a release that tightened a bound fails the step as `custom-tool-invalid`, naming
  the tool). It validates with the task type's own `requiresRepository` (`loadPinnedTools`; a type row
  that is gone reads `true`), as the call route does. A pinned template that no longer parses fails the
  step at dispatch as `custom-template-invalid`, naming the first 8 problems. The runner then checks the
  install switch `CUSTOM_MCP_TOOLS_ENABLED` and `CONFIG_ENCRYPTION_KEY`; each failure names its fix. The
  dispatch
  requires a CLI that can host MCP servers (`requiresMcp`), and fails by name when no enabled one can.
  The cli-exec resolver repeats the pinned-tool check for a run executed later, signs a `custom-mcp`
  token for that task, step and invocation (valid for the run's timeout plus a grace) and mounts three
  sandbox files: the `haive-custom` server script (`/haive/haive-custom-mcp.mjs`), the tool list
  (`/haive/haive-custom.tools.json`: name, description and the input schema the api also checks) and
  the token (`/haive/haive-custom.token`) — never an environment variable. A run naming custom tools
  fails (`custom-tools-unwired`) when their server could not be added to the CLI, a CLI with no MCP
  configuration included; the failure names each server whose `mcp add` failed (`failedMcpAddNames`),
  and keeps the general cause when none is known. A best-effort server
  failure elsewhere lets the run carry on.

- **Start gate** (api). `assertCustomToolsUsable` (`lib/custom-tools-start-check.ts`) runs in
  `markQueuedForStart`, so every first Start (create-and-start, the Start action, a plan-link spawn, a
  draft run) passes it, and in the full-Retry branch of the task action. A step Retry, a resume and an
  auto-resume are not gated: the runner's check covers them. It applies the runner's checks to every
  pinned step and refuses with 409 `custom-tool-invalid` or `custom-tools-switched-off`, naming the
  first failing step in id order (its title on one line, tool names cut to 64 characters, 8 listed then
  "and N more"); the task stays as it was and nothing is queued. Every declared tool counts as required:
  there is no tool-level optional flag. A repeat Start of a started task stays a no-op, a config store
  outage answers 503 `config_unavailable` and starts nothing, and `start-entry-points.test.ts` pins that
  only the two gated writers set `queued`. It does not check `CONFIG_ENCRYPTION_KEY`.
- **Authoring and the switch.** An administrator adds tools in the prompt-step editor's Custom tools
  section (action, name, description, then the URL and query parameters or the scope and result count,
  and typed parameters); a new tool starts with the schema defaults, and switching its action keeps the
  name and description. Its timeout (seconds, http-get only) and response cap (KiB) fields hold the
  same bounds the save checks, so a stored tool outside today's range is fixed in place.
  `GET /admin/task-types/:slug` carries `promptStepIssues`, the save checks run over an admin type's
  stored prompt steps (empty for other rows and while the step catalog is unsynced), so a stored tool
  that no longer passes the schema is named on load as `tool-no-longer-valid`.
  `GET|PUT /admin/config/custom-tools` reads and writes `CUSTOM_MCP_TOOLS_ENABLED` (default on; the
  "Custom tools" card on the admin page), and every PUT records `config.custom_tools` with
  `{from, to}`. `resolveCustomToolsEnabled` (`@haive/shared/modularity-server`) is the one reader: the
  call route, that GET, the runner, the cli-exec resolver and the Start gate use it, and a config outage
  propagates from it (fails closed). The admin PUT is the only writer.
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
  `switched-off`); strict arguments (400); the pinned tool, of either kind, re-validated with the type's
  `requiresRepository` (403 `tool-invalid`); for `http-get`, its URL built from the arguments (400 `invalid-arguments`), and the run's network
  policy `full` (403 `egress-restricted`). Every refusal past the liveness check is a claimed
  row; the budget (50 calls per invocation) is claimed under
  `pg_advisory_xact_lock('custom-mcp-budget:'||invocation)`, and at 50 the answer is 429 with nothing
  written — before the claim rows, parallel calls overshot to 57. `custom_tool_calls` never stores an
  argument or a result, and the agent-facing message never carries the cause (it could name a
  compose-network address).
- **The egress guard** (`egress-guard.ts`, in `@haive/shared/egress`; custom tools use `guardedGet`,
  which takes no allowlist by design: a custom tool never reaches a private address): an IP literal is refused before any lookup; names resolve
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
  capabilities, timeoutMs, consumesRoles, providesRoles, outputMode) and the top-level keys slug,
  display name, description, requires repository,
  step ids, prompt steps and loop limits. So tools, agent pool, param forms, integrations, switches and
  presets never come from a draft. Role keys are optional. The creator prompt identifies
  providable roles and warns that core producers may be implicit: multiple earlier producers
  cause ambiguity, and drafts cannot carry `dataRoleBindings`. The admin can resolve a choice
  in the editor. `validateTaskTypeDraft` runs the create route's shared validation
  stages in its order and returns the same issues; a parity test drives the drafter and the shared
  validator over the same fixtures. A taken slug, a built-in's included, is only a `slug-taken` warning
  on a draft, while `POST /admin/task-types` refuses it with 409 before those stages, so a warned
  draft does not save under that slug.
- **Routes:** `POST /admin/task-type-drafts` inserts the task, writes the opening message and marks it
  queued in one transaction, then enqueues the start (a crash in between used to leave it `created`
  forever); `GET /admin/task-type-drafts/:taskId` answers its owner only, with `awaitingMessage` true
  only while the newest step row is `waiting_form` with `waiting_started_at` set.

- **The panel** (`task-type-creator-panel.tsx`) sits in the static editor on its create page and on an
  admin-made static type, never on a derived, built-in or module type. It remembers the conversation per viewer and
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
3. `custom_steps` is pinned raw and parsed per tool and per integration requirement.
4. Prompt steps are never registered; the worker synthesises them per task.
5. The seeder writes only its own columns and rows, skips unchanged rows and never deletes.
6. Every built-in slug is held by a `builtin` row with the registry's list, or the worker does not boot.
7. The `workflow_type` enum stays defined; a new built-in is `ADD VALUE`, declared last.
8. Both switches default off and gate creation only; the first non-built-in task closes the 0193
   rollback.
9. Create admits on the definition read `FOR SHARE` inside the insert transaction at all five task INSERT sites; DELETE takes `FOR UPDATE`; module rows are read
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

## Conditional insight tail on shorter workflow paths

The physical `08c-code-review` and `08e-insights-triage` steps are reachable on
`quick_bugfix`, and 08e is reachable on `plan_tasklist` (whose code review already ran).
Newly added visits skip unless an insight continuation is active; an existing plan-tasklist
code review keeps its normal behavior. Dormant visits bypass new-work pause/provider holds
and dispatch nothing. Thus ordinary work and decisions remain unchanged, with only the
new conditional skipped cards added to those run lists. An active route runs fresh review
and the automatic 08e checkpoint. Existing snapshots are never rewritten.

The composable 08e entry requires earlier verification/review tokens and a verify loop
target. Its review requirement declares `after: verification`, so the review provider must
follow the verification provider before triage. Editor, preview, admission, seed and derived-path
checks all use this shared rule; review before verification stays valid without 08e. Runtime
preflight checks ordered verification, the pinned code-review producer, and triage before a
nonempty selection can dispatch an editor, and again before handoff.
A standalone module declaration is not a pinned replacement role. An old/custom pin that
lacks the required destinations refuses visibly rather than jumping off-list.

Dormancy applies only to members added by the built-in path filter. Explicit stored
snapshots, derived pins and admin/static lists keep their own listed step behavior.
Stored derived pins retain their original base membership. New derived bases include the
conditional tail as described below; existing pins are never recomputed.

08e now requires earlier verification (`08-phase-5-verify`) and review (`08c-code-review`,
or its pinned replacement) as well as its existing worktree, with verification as its
revise target. Stored admin/module/derived types missing these requirements become
unavailable when revalidated for new task creation; repair their composition before
creating another task. A pending failed-insight approval overrides task/type gate-2
presets, prior-task form reuse and auto-continue: gate 2 parks with its own computed
form defaults and `autoSubmit: false`. Preset overlays never change that recommendation.
Only a fresh explicit owner submission bound to the row and rerun generation can clear
it; latch-free gate-2 preset behavior is unchanged.
Existing tasks retain their immutable lists and fail the source
step retryably if their destinations are incomplete. No data migration weakens the rule.
The development install had no such stored types when checked by the session.

## Gate-3 insight destinations

Gate 3 declares 08e as a conditional revise target with `loopTargetWhenPresent: true`.
Composition validates its ordering and closing barriers when 08e is present; absent
08e does not create a missing-loop-target issue. Existing admin/module types and
stored derived candidates without 08e remain valid. The boot-only built-in path
closure still retains 08e; it never expands or validates a stored task list.
08e's existing requirements order verification before code review. Gate 3 explicitly
declares `loopBeforeClose: true`: its revise branch is
chosen before the commit action. Ordinary closing-and-looping entries remain barriers,
and later steps still cannot loop across a commit. The flag requires both a closing
entry and a loop target. `loopTargetWhenPresent` also requires a declared target.

New derived base candidates include the conditional insight tail, matching builtin
runtime membership. Quick paths also include conditional gate 2 so a failed insight
verify can receive a fresh approval. Runtime dormancy reads each stored derived base,
not today's live membership: old pins stay unchanged, while explicit overlay inserts
and replacements retain their listed behavior. New base membership makes those anchors
reachable for new overlays. No existing pin is rewritten.

Gate-3 detect resolves stored membership first: without 08e it offers no picks and
retains summary access and the ordinary commit path, including pre-INS5 quick pins
without gate 2. Apply rechecks membership before any picked intent can route to 08e.
When a pick is offered, run-list preflight resolves the pinned review producer and
ordered verify/review/08e/gate-3 destinations before dispatch or reset. It also requires
gate 2 before gate 3, so a pick cannot edit and later park on a missing approval step.
Incomplete pick paths fail visibly with Retry guidance. This conditional gate-3 branch
does not weaken 08e's own admission requirements or rewrite existing task pins.

## No-change worktree cleanup

`12-no-change-cleanup` is a deterministic core step available for explicit composition
only (`workflowType: core`); registering it does not add it to a built-in run list. It
requires `worktree` and `clean-tree`, provides `cleaned`, removes `worktree` and closes
the run. It neither provides nor requires `commit` or `pr`. Ordinary
`12-worktree-cleanup` still requires `commit`. No guarded-span runtime or seed wiring
is enabled by this addition.

The step reads the recorded `01-worktree-setup` output again in apply. It refuses a
dirty or unreadable tree, an open merge/rebase/cherry-pick/revert (including sequencer
state), a locked, different or shared checkout, or branch history not contained in the local
base. An advanced base is allowed when it contains every branch commit. It never
merges, commits or pushes. Ignored files follow the existing cleanup policy and are
not uncommitted changes and are removed too. Completion defers to this step as it
does to ordinary cleanup.

## Composed LSP final verification

`01b1-verify-composed-lsp` is a deterministic, provider-sensitive workflow step at index 1.21. Every
built-in workflow path that has 01b includes it right after 01b, before browser, app and discovery
work. Its shouldRun skips templates whose LSP install contract is absent or 1, so they get no form
and no Docker probe. Its composable entry requires the environment image and the worktree; 04 and
01b order themselves before it through their own precedes lists. It dispatches no CLI and grants no
output replacement role.

Derived candidates built on the stock workflow inherit the step. An overlay that removes 01b or 04
is accepted: it cannot become contract-2 eligible, so the final step fails closed at detect. Existing static snapshots and derived pins stay
unchanged: a list that lacks 04, worktree setup, 01b and the final step in that order is ineligible
for contract 2, and the step's detect refuses it without rewriting the list. run_app's dynamic modes
and env_replicate's standalone list are unchanged. The contract-2 environment writer is still
refused. See [Sandbox](sandbox.md) for the evidence, Retry recovery and the registered-step
rollback requirement.
