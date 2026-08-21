# Learned step guidance (self-improving prompts)

## Context

Haive already learns from finished runs, but only about the user's *code*: `11-phase-8-learning`
writes learnings, KB syncs, investigations and global-KB candidates. Its ADMISSION BAR requires a
`path/to/file.ext:LINE` citation from the run, so a lesson about *how Haive asked for the work* is
dropped by construction. Nothing in the system captures "this step's instruction was ambiguous and
that is why the fix loop ran".

The manual version of that loop already exists and demonstrably pays: `ddevConfigGuidanceLines()` in
`packages/worker/src/step-engine/steps/_retrieval-guidance.ts:162` is a hand-written learned lesson,
relevance-gated on `/\bddev\b/i`, whose own comment records the evidence ("Observed across six
add-ddev tasks: four wrote ranges, two wrote exact pins and both tasks died at `ddev start`"). This
feature automates the capture and storage of such lessons; a human still approves every one.

Intended outcome: a validator/reviewer that is about to send a round back may name the instruction
defect that caused it; the user triages those at the end of the run; approved items are appended to
that step's prompt on future runs, scoped to the repo or to the stack.

### Deliberately NOT built

- **No prompt overrides.** Guidance is appended only. A DB row must never replace `buildPrompt`
  output: `dispatcher.ts:154` runs `adaptPromptForCliCapabilities()` over the built prompt, doing
  exact-string swaps on canonical retrieval fragments and resolving `[[HAIVE_AGENT_DEFINITION:...]]`
  markers. An overridden prompt loses both, silently, so codex/gemini would receive LSP-referencing
  text and agent-file paths they cannot use. Append also makes rollback exact (see Rollback).
- **No auto-generated "improved prompt", no synthetic validation scenario.** Judging a rewritten
  prompt against a scenario the same model invented is intrinsic self-correction on a training set of
  size one; the literature is clear it degrades accuracy, and it would cost more than the task it
  aims to improve. The approver is the human at the triage form.
- **No auto-activation.** Nothing reaches a prompt without an explicit human selection.

## Design

### 1. Capture (zero extra CLI invocations)

New `packages/worker/src/step-engine/steps/workflow/_prompt-defect.ts`, modelled on
`08e-insights-triage.ts` (which already proves the pattern: a markdown block emitted *after* the
step's fenced JSON, parsed later from `cli_invocations.rawOutput`, so no output contract changes).

- `PROMPT_DEFECT_INSTRUCTION` — ~6 prompt lines. Shape mirrors `INSIGHTS_INSTRUCTION`:
  `- DEFECT: <cause> | <what the instruction should have said> | <evidence file:line>`
  with `cause` one of `prompt_ambiguity | missing_context | task_description_defect`.
  The instruction must state that omitting the section is the correct and expected answer whenever
  the failure had any other cause (real code bug, flaky environment, model slip, plain difficulty).
  Without that, the model always produces something — the known confabulation failure mode.
- `parsePromptDefects(outputs)` — direct analogue of `parseInsights()`, deduped, capped.
- `promptDefectFingerprint(stepId, cause, guidance)` — reuse the normalisation already proven in
  `fixLoopFingerprint()` (`_fix-loop.ts:174`): strip uuids/paths/digits, sha256, 16 hex chars.

Spliced into the four steps that can route a run back to implementation and that emit their verdict
from a CLI call (the non-human keys of `PATH_REQUIRED_TARGETS`):
`07b-phase-4-validate.ts`, `08-phase-5-verify.ts`, `08c-code-review.ts` (next to the existing
`INSIGHTS_INSTRUCTION` in `reviewAssignment()`), `08d-adversarial-qa.ts`.

Gate: feature switch only, resolved in each step's `detect()` and carried on the detect payload as
`promptDefectCapture: boolean` (`buildPrompt` has no `ctx`). Not gated on `round > 0` — the round
that *first* rejects is the observation, and the prompt is fixed before the model knows it will
reject.

### 2. Triage (new deterministic step, no CLI)

New `packages/worker/src/step-engine/steps/workflow/11e-prompt-guidance.ts`, index `11.5`,
`requiresCli: false`, no `llm` block. Structurally a copy of `08e-insights-triage.ts`.

- `shouldRun`: feature enabled AND at least one parsed defect. Clean runs never see the form.
- `detect`: scan this task's `cli_invocations.rawOutput` joined to `task_steps` (same query shape as
  `collectInsights()`), parse, dedupe by fingerprint, drop any fingerprint already `rejected`, look
  up existing rows for the `seen Nx` count, and load `loadRepoStackAnchors()` (`_repo-stack.ts:100`)
  for facets plus the repo's project name.
- `form`: two multi-selects over the same candidate list — `keep` (default none) and `global` (a
  subset of `keep`, described as "applies to every repo on this stack"). Items in both become
  `scope='global'`; items only in `keep` become `scope='repo'`.
- `apply`: upsert kept candidates into `step_guidance` (`ON CONFLICT ... DO UPDATE SET occurrences =
  occurrences + 1, status = 'active'`); insert unkept candidates as `status='rejected'` tombstones so
  the same defect never resurfaces on the next task. Global items are name-scrubbed by reusing the
  exported pure `sanitizeGlobalArticle()` (`_global-kb-promote.ts:71`) with a synthetic title, and
  are length-capped (400 chars) at insert.
- `task_description_defect` candidates are shown but are **not** offered for guidance — that class
  points at the user's own task text, which `03b-business-requirements` / `05-phase-0b5-spec-quality`
  already own. Display only, so the signal is not lost.

Register in `steps/workflow/index.ts` (import + array + `registry.register`) and add to
`PLAN_TASKLIST_EXTRA` in `orchestrator/execution-paths.ts` beside `11-phase-8-learning`. Not added to
`CLI_DISPATCH_STEP_IDS` in `packages/shared/src/step-engine/types.ts` — it dispatches no CLI.

### 3. Storage

New `packages/database/src/schema/step-guidance.ts`, exported from the schema `index.ts`. Main DB,
not the global-KB database (that one is a separate `haive_kb_global` connection for vectors; this
needs to join `repositories`/`tasks`).

Columns: `id`, `step_id`, `scope` (`repo|global`), `repository_id` (FK cascade, null for global),
`facets` jsonb (`GlobalKbFacets`), `provider_family` (provenance/display only in v1 — see
Limitations), `cause`, `guidance`, `status` (`active|rejected|archived`), `fingerprint`,
`occurrences`, `source_task_id` (FK set null), `source_step_id`, `created_at`, `updated_at`.

Unique index on `(step_id, scope, coalesce(repository_id, '00000000-0000-0000-0000-000000000000'),
fingerprint)`. Authored in the numbered `.sql` because it is an expression index; the table is new so
no dedup pass is needed first.

Per-repo opt-out column on `repositories`: `step_guidance_enabled boolean NOT NULL DEFAULT true`,
matching how `pr_workflow_enabled` pairs with a default-off global switch.

Migration `packages/database/src/migrations/0109_step_guidance.sql` — `CREATE TABLE IF NOT EXISTS`,
`CREATE UNIQUE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Fully additive and
idempotent, per the `0108_task_paused_at.sql` convention.

### 4. Injection

New `packages/worker/src/step-engine/guidance-context.ts`, deliberately shaped like
`terseness-context.ts:34` (the existing DB-config-to-prompt augmenter): best-effort, wrapped in
try/catch, any failure returns the prompt unchanged.

`augmentPromptWithLearnedGuidance(db, taskId, stepId, prompt)`:
- off unless `CONFIG_KEYS.STEP_GUIDANCE_ENABLED` and the repo's `step_guidance_enabled`
- selects `status='active'` rows for `step_id`, where `scope='repo'` and `repository_id` matches the
  task's repo, or `scope='global'` and facets overlap the repo's stack anchors. Facet matching is an
  in-JS filter over a bounded fetch, exactly as `loadActiveGlobalArticlesForStack()`
  (`_global-kb-promote.ts:104`) already does — no jsonb query gymnastics
- order by `occurrences desc, updated_at desc`; hard cap 5 items / 1500 chars
- appends one delimited block

Call site: `packages/worker/src/step-engine/step-runner.ts`, between the existing
`augmentPromptWithAttachments` (line 606) and `augmentPromptWithTerseness` (line 609), so the result
still flows through `resolveTaskDispatch` and its capability adaptation. Not wired into the agent-
mining path at `step-runner.ts:1096` in v1.

### 5. Switches and UI

- `CONFIG_KEYS.STEP_GUIDANCE_ENABLED: 'config:guidance:stepGuidanceEnabled'`, `DEFAULT_CONFIG` value
  `'false'` (staged rollout, as `PR_WORKFLOW_ENABLED` does) — `packages/shared/src/config/config.service.ts`
- `GET`/`PUT /config/step-guidance` in `packages/api/src/routes/admin.ts`, copying the
  `/config/terseness` pair at lines 640-656
- Toggle card in `packages/web/src/app/(app)/admin/page.tsx`
- Per-repo toggle threaded through `packages/api/src/routes/tooling-upgrades.ts` (lines 289/343 show
  the `secretMaskEnabled` pattern) and `packages/web/src/app/(app)/repos/[id]/tooling/page.tsx`
- Same tooling page: read-only list of that repo's active guidance with a Deactivate action
  (`status='archived'`). This is the off-switch for an item that is already steering runs.

## Tasks

1. Copy this plan to `docs/plans/lexical-jingling-dawn.md` (the `~/.claude/plans` copy is reaped).
2. Schema + migration `0109` (`step_guidance` table, unique index, `repositories.step_guidance_enabled`).
3. `_prompt-defect.ts`: instruction constant, parser, fingerprint + unit tests.
4. Splice the instruction into 07b / 08 / 08c / 08d behind the detect-resolved capture flag.
5. `guidance-context.ts` + the `step-runner.ts:606` call site + unit tests (disabled and empty cases
   must return a byte-identical prompt).
6. `11e-prompt-guidance.ts` step, registry wiring, `execution-paths.ts` entry + unit tests.
7. `CONFIG_KEYS` + admin GET/PUT + admin toggle card.
8. Per-repo toggle + active-guidance list/deactivate on the tooling page.
9. Canned form payload for `11e-prompt-guidance` in `packages/worker/test/workflow-smoke.ts`.

## Rollback

Additive throughout; each step undoes alone.

1. Flip `STEP_GUIDANCE_ENABLED` to `false`. Injection stops and every prompt becomes byte-identical
   to today's, because guidance is only ever appended. No deploy, no code change.
2. Single repo: `UPDATE repositories SET step_guidance_enabled = false WHERE id = '<id>';`
3. Single item: `UPDATE step_guidance SET status = 'archived' WHERE id = '<id>';`
4. Full removal: revert the code, then `DROP TABLE step_guidance;` and drop
   `repositories.step_guidance_enabled`. Leaving both in place after a code revert is harmless —
   nothing reads them.

Deploy order is the additive migration first, then the code (`dev.sh libs` + restart), per the
migrate-before-libs rule; a `@haive/shared` export change on a live stack crash-loops worker and api
until the libs rebuild lands.

## Verification

- `pnpm typecheck` and `pnpm test` in each package's own container (node_modules are per-container).
- Unit: parser round-trips a `## PROMPT-DEFECT` block and ignores output without one; a rejected
  fingerprint is never re-offered; `augmentPromptWithLearnedGuidance` returns the input string
  unchanged when the switch is off, when no rows match, and when the query throws; the 5-item /
  1500-char cap holds; a global item with non-overlapping facets is not selected.
- Smoke: `packages/worker/test/workflow-smoke.ts` passes with the new canned payload.
- End-to-end on a scratch repo, worker paused/resumed around edits rather than restarted mid-CLI:
  1. enable the admin switch; run a workflow task and force a fix round
  2. confirm the 11e form appears with at least one candidate; keep one as repo-scoped
  3. confirm the `step_guidance` row is `active` with `occurrences = 1`
  4. run a second task on the same repo; `SELECT prompt FROM cli_invocations` for
     `07-phase-2-implement` contains the guidance block
  5. flip the admin switch off; run again; the same prompt is byte-identical to a pre-feature run

## Limitations to state in code comments

- **No statistical validation.** Sample counts per (step, repo) are far too low to show that guidance
  helped. `occurrences` is the honest substitute: repeated independent observation, surfaced to the
  human who decides. Nothing in this feature claims a measured improvement.
- **`provider_family` is recorded but not filtered on** in v1. A lesson learned under one CLI family
  is applied to all of them. Displayed in the UI so a wrong-family item can be archived by hand.
- **Global guidance is stack-scoped, not model-scoped, and does not expire.** Model upgrades can make
  an item stale; there is no reaper. Archive by hand.
- **Global scope carries repo-authored text across repos.** Mitigated by explicit per-item human
  selection, the project-name scrub, the length cap, and facet scoping — not eliminated.

---

# Amendment — 2026-08-21: unbuilt; the worked example moved

Unbuilt — none of the proposed files exist (`schema/step-guidance.ts`,
`step-engine/guidance-context.ts`, `steps/workflow/_prompt-defect.ts`,
`steps/workflow/11e-prompt-guidance.ts`, migration `0109_step_guidance.sql`).

The hand-written lesson the plan generalises from is intact but moved:
`ddevConfigGuidanceLines` is `_retrieval-guidance.ts:176`, not `:162` (line 162 now falls inside its
doc comment). That comment has also grown two further rules since the body was written, which
strengthens rather than weakens the argument — the manual list is accumulating by hand, which is
exactly the cost this plan removes.
