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

A derived type stores its base and a short list of changes, never a copy of the base's run list:

```
base: 'workflow'
changes: [
  { replace: '08c-code-review', with: 'module.deeppattern.review' },
  { insertAfter: '08c-code-review', step: 'module.other.check' },
  { remove: '04a-spec-audit' }
]
```

**Recommendation and why.** A static copy freezes the base at the moment of copying: every later
release that adds, fixes or reorders a workflow step skips the copy silently, and the copy loses
triage's execution paths. An overlay applies its changes to the base's run list at task creation,
so it keeps the paths and every core update. The editor still presents it as "Duplicate and
customize".

- **Run list.** Build the base's list as today (path-aware for `workflow`), then apply the changes in
  order. A change whose target step is not on the chosen path is skipped for that task, and the task
  records which changes applied. The result is validated with `validateComposition`; an invalid
  result fails task creation with the issues, as an admin type does today.
- **Snapshot.** The applied run list is pinned to the task like any snapshot run list, so a running
  task never changes under a later edit of the overlay or a core upgrade.
- **Staleness.** A change that names a step the base no longer has is reported in the editor and
  skipped at creation, never guessed. A core upgrade that renames a step shows the overlay as needing
  attention.
- **Storage.** A new `run_list_strategy` value (`derived`) with `base_slug` and `changes` columns on
  `task_type_definitions`, both declared last (schema-parity rule). Admin-only (owner decision 2026-11-14), like custom
  types. Presets and loop limits work as for admin types.

### Design: replacing a step

A replacement must keep every reader of the replaced step working:

- A composable entry may declare `replaces: '<core step id>'` and must then produce output that
  satisfies the replaced step's declared output contract (a shared zod schema per replaceable step,
  starting with 08c and 08c2).
- Readers that find a step by id (gate 2 for 08c2, `task-history.ts` and others) resolve "the step
  in the 08c2 role" through one helper that honours `replaces`. A source-scan test pins the list of
  readers that may still use a literal id.
- Only steps with a declared output contract are replaceable. Others can be removed (when the
  composition stays valid) or have steps inserted beside them, not replaced.
- `07-phase-2-implement` and the gates are never replaceable.

### Prerequisites and order

1. Composable entries for 04a, 08c2, 08d and 09, so a derived workflow can hold every built-in step.
   Extend the guard test that the shipped workflow order raises no ordering issue.
   **Prerequisite 1 implemented:** 23 entries added (58 total); every shipped workflow path,
   including its environment prelude, now has complete catalog coverage and validates with no issues.
2. The step SDK seam: the step types and helpers a module step needs without importing
   `@haive/worker` (which has no package exports). The deep-analysis module (`kind-riding-dream.md`)
   needs the same seam; build it once.
3. Derived types: storage, run-list builder, editor ("Duplicate and customize" on a built-in, the
   changes list, live validation), task creation.
4. Output contracts and `replaces` for 08c and 08c2, and the role-resolving reader helper.

Each is its own PR. Rollback: revert in reverse order. A derived type left in the database after a
revert of 3 is unusable but harmless; the migration's down path drops the two columns only when no
task uses a derived type.

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

