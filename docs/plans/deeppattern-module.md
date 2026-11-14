# Derived task types, and DeepPattern as a steps-only public module

> **Not implemented; planned 2026-11-14, revised the same day.** Two parts. Part A is a core feature:
> a person derives their own task type from a built-in one and replaces or adds a step or two.
> Part B is DeepPattern's review as a public module that ships only a composable step, used through
> Part A. Part B's Phase 0 decides whether it is built at all; Part A stands on its own.

## Context

DeepPattern (deeppattern.ai) was assessed on 2026-11-11 on the owner's free invite. Nothing was built.

- **AQG** is a set of local MIT skills, hooks and rule blocks for interactive desktop agents. Skip it:
  it duplicates Haive's deterministic gates.
- **DE (Decision Engine)** is a hosted, cross-vendor review panel. Its server is closed; the GitHub
  repositories `deeppatternai/decision-engine` and `agent-quality-gates` hold squashed client
  snapshots only. It is an invite-only preview with no SLA.

DE could sit beside Haive's review steps as an independent second reader. It sees only the text it is
sent, so it is added beside 08c (code review), never in place of it.

Haive has internal modules (`modules/statistics`, in this repository) and private external modules
(translator and deep-analysis, in private repositories since T669). It has no public external module.
Shipping DE as one tests that path: a public repository, installed into a stock Haive.

## DE interface (as measured 2026-11-11)

Remote MCP endpoint: `https://endpoint.deeppattern.ai/plugin/mcp/v1/audit`. An unauthenticated
`initialize` and `tools/list` work. It answers plain JSON with no session id.

- `audit_skill_submit(idempotency_key, title<=200, content, tier: fast|standard|deep, context?, focus?, domain?, stakes?, artifact_intent?)`
- `audit_skill_status(task_id, wait_seconds<=25)`
- `audit_skill_result(task_id)` returns `json` (an untyped object) and `markdown`
- `audit_skill_events(task_id)`

Limits: about 480 KB of content for fast/standard, about 240 KB for deep. A deep run takes 15-30 min.
One idempotency key gives one task and at most one charge.

Auth: OAuth 2.1 with a public PKCE client (token auth method `none`). CIMD is supported; DCR and
userinfo are not. The client id `deep-pattern-audit-harness` is preregistered for DeepSeek Harness;
do not reuse it. A legacy device route also exists: `POST /v1/devices/activate` returns a bearer
token, then `POST /mcp`.

Re-measure all of this in Phase 0: it is a preview and may have changed.

## Part B Phase 0: value test, outside Haive (decides go or no-go)

1. Install the Claude Code plugin `audit@deeppattern-plugins` and run DE on 5-10 real Haive diffs
   that already passed 08c, plus 2-3 with known escaped bugs (pick from the board's REGRESSION items).
2. Record per diff: tier, wall time, cost, findings, and for each finding whether it is new versus
   08c's review, a duplicate, or wrong.
3. **Go** if DE finds at least one consequential issue 08c missed across the set, at a cost and
   latency a review step can carry (a fast/standard tier within the step's timeout). **No-go**
   otherwise: record the numbers here and park the plan.

## Part A: derived task types (core)

### What exists today (verified 2026-11-14)

- A module manifest may declare `composableSteps` without any `taskTypes`; both are optional
  (`packages/shared/src/modularity/manifest.ts` ~:340-341). A steps-only module is already legal.
- Module steps register as `module.<id>.<local>` and join the admin catalog. An admin composes a
  custom type from core and module steps in the task-type editor, validated by `validateComposition`
  (see [Task types](../architecture/task-types.md)).
- An admin type is a `static` run list. The built-in `workflow` uses the `workflow_paths` strategy:
  triage picks the execution path and `buildRunList` (`worker/src/queues/run-list.ts`) builds a
  path-aware list.
- The editor has no way to start from a built-in type.
- `CORE_COMPOSABLE_STEPS` (`worker/src/step-engine/composable-core.ts`) had 35 entries; 04a, 08c2,
  08d and 09 were among the 23 workflow steps without one. Prerequisite 1 below added them all.
- Later steps read earlier ones by id: gate 2 (`09-gate-2-verify-approval.ts`) reads 08c2's output by
  id, so a different step in its place is invisible to it.
- The fix loop targets only `07-phase-2-implement`, the one step that reads the recorded diagnosis.

### Design: an overlay, not a copy

The accepted design stores a base and a strict, ordered changes list, never a flattened copy:

```
baseSlug: 'workflow'
changes: [
  { insertAfter: '08c-code-review', step: 'module.deeppattern.review' },
  { remove: '04a-spec-audit' }
]
```

An overlay picks up the base's current order at task creation and keeps triage's paths; a static
copy would silently miss core additions and fixes. The editor calls this “Duplicate and customize”,
but saves the overlay only. V1 accepts built-in bases only, with **workflow the sole eligible base**.
Admin, module and derived parents are refused, so there is no derived-of-derived chain.
`run_app` is ineligible: it chooses its runtime after `01-declare-deps`, lacks complete composable
coverage, and needs a mode-finalization seam separate from triage. Show that precise disabled reason.

**Authoring and execution.** Admin-only means authoring, as for static custom types. Signed-in users
may create enabled/selectable derived types under `CUSTOM_TASK_TYPES_ENABLED`; module-state admission
still applies. No new user-owned type model or module manifest strategy is introduced.

**Changes and diagnostics.** Each strict operation is `{replace: id, with: id}`,
`{insertAfter: id, step: id}` or `{remove: id}`; reject extra keys, invalid namespaced IDs and IDs over
128 characters. The list holds 0–64 operations with an injectable bound. Apply in order to actual IDs:

- A target on another base path is `path-absent`; a target absent from the whole base and not
  introduced by an earlier valid change is `stale-target`. Both skip. An inserted step is a legal
  later anchor, and a skipped producer's reason propagates through its anchor chain.
- A target consumed by an earlier applied operation is `target-removed-by-change`, a hard issue.
  Never alias an old ID to a replacement. After a future supported replacement, anchor to its explicit
  new ID. Repeated inserts at a surviving anchor put the later insertion nearest the anchor.
- Record each operation's index, original change, outcome and reason per candidate. The evaluator
  records `refused` for hard failures, alongside `applied`, `path-absent` and `stale-target`.
  Reject duplicate final IDs, missing active installed payloads, unsupported replacements and every
  `validateComposition` issue. Validate prompt quotes per candidate; detect prompt orphans against
  the union, not one path.
- Stale changes remain visible with their target and index: “Base no longer includes this step; this
  change will be skipped.” Save/create may proceed with warnings only if all candidates validate.
  Never infer a rename. Missing/deactivated payload modules are hard issues when active. Editor
  diagnostics use today's base; task diagnostics remain the history recorded at INSERT.

**All paths are pinned before triage.** Expand null/pre-triage, `quick_bugfix`, `plan_tasklist` and
`full_workflow`, including the environment prelude, through the existing `taskRunListIds` selector.
API supplies coherent ordered `step_catalog` rows (`workflowType`/`stepIndex`); worker supplies
registry order. Check parity; ID-sorted catalog reads are insufficient. A synced catalog is mandatory.
Shared owns the pure adapter/evaluator, with no worker import into API/web.

Validate every complete candidate at locked task creation. Preserve the exact first three workflow
steps, `00-model-health-workflow`, `00a-sync-base`, `00-triage`; no remove/replace or insertion inside
that prefix. Only that shared prefix executes before selection. Pin versioned `derived_run_plan` v1
at INSERT: base slug/strategy, overlay revision/changes, ordered base candidates and actual catalog
fingerprint, composable declarations, all final candidates/outcomes, common prefix and warnings.
The existing workflow `content_hash` hashes null IDs and cannot identify this catalog/order.
Pin the full/null candidate in `run_list_snapshot` and raw prompt definitions used by any candidate in
`custom_steps`. This freezes IDs/order and raw prompt content, not historical executable code or accounts.

At first `00-triage.apply`, a derived-only helper locks the owned step before the task, fences step,
round, epoch, live status and unselected path, validates the chosen pinned candidate against pinned
declarations and confirms all IDs still resolve. It atomically stores path, broad-audit choice, chosen
snapshot and event; event failure rolls back selection. Missing code marks the task dead by name.
This is the sole new UPDATE exception for `run_list_snapshot`, only on an unselected derived workflow;
`custom_steps` and `derived_run_plan` stay INSERT-only. Same-choice replay is idempotent. A different
choice returns `derived_path_pinned`: “Create a new task to change path.” A triage Retry shows that pin;
Skip of unselected triage is refused. Retry, full Retry, Resume, fix/revise resets, duplicate deliveries
and boot recovery never clear or recompute it. Refresh path/snapshot before successor selection so
pickup context cannot advance on the old list. Death between selection and handoff reuses the pin.

Run-list, dead-task, provider-disable and context readers prefer the derived pin regardless of live
definition edits. Malformed/missing required plans fail by name, never fall back to the custom slug's
empty registry list. Do not reinterpret unrelated literal workflow-slug behaviors.

**Admission, dependencies and defaults.** Derive root/database/repository/simplify traits, canary,
module dependencies, integration admission/preview and saved-step CLI preview from the candidate union
before selection, chosen snapshot afterward. Integration preview labels possible later steps “may run
after path selection”; dispatch still resolves required accounts. Module deactivation/purge must
count candidate-only dependencies through a derived predicate in `moduleTaskDependency`.
Keep existing preflight-versus-locked-trait refusal. Read base/overlay FOR SHARE, referenced modules
FOR KEY SHARE and catalog coherently under share locks in task INSERT; never hold a connection over
queue IO. Catalog sync may refuse admission rather than produce a mixed plan.

Presets and loop limits are the derived row's own maps, without live base-default inheritance.
Validate keys against the union and limits only on `loopBudgetEditable` steps, 1–50; request limits
win. Report obsolete default keys after an upgrade and omit them from new task copies; explicit
invalid edits fail. Prune task-only irrelevant defaults when selecting the path, never saved maps.
Preserve `06-run-config` omitted-answer/default semantics and use pinned membership for its derived
QA/browser branch.

**Storage and rollback.** Append `derived` to `run_list_strategy`; append nullable `base_slug
varchar(128)` and `changes jsonb` after `prompt_steps`, and nullable `tasks.derived_run_plan jsonb`
after the current final column (recheck at implementation). Existing rows stay NULL. Derived rows
are admin-authored, `step_ids=NULL`, base/changes non-NULL; other strategies retain both NULL.
Named CHECKs use explicit NULL tests; forbid self-reference and add a self-FK to slug ON DELETE
RESTRICT. Mirror constraints in Drizzle. Locked API base validation enforces builtin eligibility and
inherited `requiresRepository`. Base/strategy are immutable after create.

Use two fresh consecutive migrations after the current highest number: commit guarded ADD VALUE
first, then append columns and guarded named CHECK/FK blocks in the next transaction. Never edit an
applied migration. No backfill. Down disables creation and retains capable workers, locks creation and
definition mutation in maintenance, then refuses if ANY task uses a derived definition or carries a
plan, including terminal/dead tasks. Export unused definitions, delete only unused rows and drop new
constraints/columns IF EXISTS. Keep the enum label. Match the migration journal before roll-forward;
prefer additive code rollback. Reverting runtime while a derived task is resumable is unsafe.

**API and editor (later PRs).** Extend the existing admin routes with a strict derived create branch,
exclusive with flat `stepIds`, and derived-only change PATCH. Keep static bodies, source/strategy/slug
immutability, field ownership, expectedUpdatedAt 409/Reload, non-deleting seeds, transaction-required
audit and delete refusal for any task usage. Preview is POST `/admin/task-types/preview`, registered
before `/:slug`, read-only and unaudited. Admin authoring/preview requires auth+admin (403 for a
regular user). Preview/detail return eligibility/revision, candidates, operation diagnostics,
composition/default/prompt issues and fingerprint. Save/preview invalidity is 400; locked task
creation invalidity is 409 with structured path/operation issues and no task/event/job. A base rename
between preview/create is evaluated freshly at the locked read. Public list/detail exposes non-secret
availability/warnings, and task detail exposes pinned diagnostics.

“Duplicate and customize” opens an unsaved overlay editor with blank slug and copied display metadata.
Reuse TaskTypeEditor/Composer, palette, prompt and loop-budget controls, integration overview,
FormRenderer, MarkdownView and existing dirty/save/reload helpers. Show ordered changes and path
preview, keep invalid rows/unsaved work, distinguish skipped-on-path from stale warnings, validate
locally through shared code and debounce server preview with stale-response cancellation. Save only
the overlay, never preview arrays. Keep creator mode static-only until its positive-list protocol
supports overlays; preserve existing static behavior.

### Design: replacing a step

The schema stores all three operations, but **every active replace is refused with
`replacement-contract-unavailable` until prerequisite 4**. Equal composition tokens do not prove
output compatibility. UI explains this boundary.

Prerequisite 4 adds declared output contracts (shared Zod schemas, starting with 08c/08c2),
`replaces` declarations and one role-resolving reader helper. Gate 2, task history and other literal-ID
readers must resolve the replaced role; a source-scan test pins the remaining literal readers.
Only steps with contracts become replaceable. `07-phase-2-implement` and gates never do.

### Prerequisites and order

1. Composable entries for 04a, 08c2, 08d and 09, so a derived workflow can hold every built-in step.
   Extend the guard test that the shipped workflow order raises no ordering issue.
   **Prerequisite 1 implemented:** 23 entries added (58 total); every shipped workflow path,
   including its environment prelude, has complete catalog coverage and validates with no issues.
2. The step SDK seam: the step types and helpers a module step needs without importing
   `@haive/worker` (which has no package exports). The deep-analysis module (`kind-riding-dream.md`)
   needs the same seam; build it once.
3. Derived types. **PR1 of 4 implemented:** pure shared strict schemas, versioned run-plan type,
   ordered base catalog adapter/parity helper, evaluator and diagnostics; no routes, migrations or
   runtime/UI behavior change. The four PRs are:
   1. Shared foundation above; controls cover operations/order, skips/staleness/consumed anchors,
      every path/prelude, duplicate/missing payloads, protected prefix, replacement refusal and real
      registry/catalog parity. Rollback: revert code.
   2. Storage expansion; xhigh review required for enum transaction boundary, column order,
      guarded constraints/FK and down refusal. Controls apply migrations twice on clean/ahead
      throwaway PG, schema parity, terminal-task down refusal and unchanged existing rows.
   3. API admission/pinning, triage and ALL execution/advisory/dependency readers in one atomic
      behavior change, no UI; xhigh review required for late choice, ownership and lock order.
      Controls cover create/edit/delete races, upgrades at triage, every path, replay/refusal,
      crash/recovery and Retry/Skip/Stop/Cancel/epoch races, candidate-only module dependencies,
      audit rollback, built-in/static/custom prompt and defaults regressions. Disable new creation
      for rollback; retain runtime support for existing pins.
   4. Existing editor extension/diagnostics; controls cover unsaved duplicate, local/server parity,
      path preview, stale responses, warnings, 403, 409 Reload and static composer/creator defaults.
      Rollback: revert UI; persisted plans/API continue working.
4. Output contracts and `replaces` for 08c and 08c2, and the role-resolving reader helper.

Use red controls before code, relevant tests, touched-package typechecks and Prettier. Inject small
bounds, use fake timers and keep each new/changed test file under 5 s. Register new gated tests in CI
within its budget. Built-in and static-admin semantics remain unchanged throughout.

## Part B: DeepPattern as a steps-only public module (only after a go)
### Module shape

- A public GitHub repository, `martinambrus/haive-module-deeppattern`, package
  `@haive-module/deeppattern`, licensed for public use.
- `./manifest` declares the module, one integration provider (DeepPattern account, OAuth) and one
  composable step. It seeds no task type: a person adds the step to a derived type (Part A), either
  replacing 08c or inserted after it.
- `./steps` contributes `review`, which runs as `module.deeppattern.review`. It declares
  `replaces: '08c-code-review'` and meets 08c's output contract. It submits the same diff and scope
  08c reviews,
  waits through `audit_skill_status` with the step's cancel contract (`throwIfCancelled` in the
  poll loop), and stores the result's `markdown` as the step's report. When it replaces 08c, gate 2
  reads its findings as it reads 08c's. When it is inserted beside 08c, its findings are report-only
  and do not block on their own.
- The idempotency key derives from task, step, round and diff hash, so a retry or a worker restart
  never pays twice.
- Content above the tier's limit is not truncated silently: the step either sends the bounded
  changed-files scope (the 08c collector's) or reports "too large for DE" and passes.
- Every value DE returns is untrusted text: render it through `MarkdownView` and keep it out of any
  later agent prompt unless fenced as data (see Prompt containment).

### Prerequisites

Part A items 2-4, plus integration sign-in: Haive's integration OAuth expects a preregistered client
with a secret and a userinfo endpoint; `cimd` exists only in the schema enum (`clientRegistration` in
`@haive/shared` `modularity/integrations.ts`). DE needs a public PKCE client registered through CIMD,
with no userinfo. Either implement the CIMD path generally or use DE's device route as the first
auth mode.

### Public module distribution (the second purpose)

This module exercises the public install paths end to end, which no module has yet:

- **Source checkout:** clone into `external-modules/deeppattern/`, `pnpm module add deeppattern`,
  rebuild; the tracked tree stays clean (T669, #1179).
- **Published-image install:** add the public repository as a git install source on the admin
  Modules page (no token), fetch, upgrade.
- **Registry:** `pnpm module add @haive-module/deeppattern@<version>`. GitHub Packages requires a
  token to install npm packages even when they are public; confirm, and decide whether a public
  module also publishes to npmjs.
- **Public module list:** decide whether a public external module is listed in `public-modules.json`
  (the guard then lets tracked wiring name it) or stays unlisted like a private one. Record the rule
  in [Modules](../architecture/modules.md).
- A module CI template (T669 item 4) builds and tests the module against a pinned Haive release tag.

## Phases

1. Part A prerequisites 1-2 (useful without DeepPattern).
2. Part A items 3-4: derived types and replaceable steps. Live check: derive from `workflow`,
   remove one optional step, run a task, and confirm the path, the gates and the fix loop behave as
   on the built-in.
3. Part B Phase 0, the value test outside Haive. Stop Part B on a no-go.
4. Part B: integration sign-in, then the module repository with its CI on the T669 template.
5. Install the module each of the three ways below on a throwaway install, and fix what breaks in
   core.
6. Live check: a derived workflow with DE replacing 08c reaches gate 2 with DE's findings read as
   08c's, a retry does not create a second DE task, and a cancel stops the poll.

## Rollback

Part B: the module seeds no type and nothing uses it until a person adds its step to a derived
type. Remove that change from the type, then `pnpm module remove deeppattern` (or remove the install
source) and rebuild. Part A: see its prerequisites; the step SDK seam stays if deep-analysis already
uses it.

## Open questions for the owner

- Pricing: who pays for DE runs (the instance owner's DE account), and is a per-task cost cap needed?
- Is DE's invite-only preview with no SLA acceptable for a public module, or does it wait for
  general availability?

