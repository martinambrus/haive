# Agent memory + spec handoff optimization

## Context

Haive's cross-step memory is Postgres re-rendered into the next prompt. Every CLI
invocation is a fresh process — `sessionId` is declared at
`packages/worker/src/cli-adapters/types.ts:12` and set nowhere, so there is no
`--resume` and the CLI's own compaction dies with the process. That makes the
prompt-assembly layer our real context window, and today it has three defects:

1. **The spec is re-sent whole, 19 times.** `=== Spec ===` blocks appear in 19
   prompt builders across 13 workflow steps. Exactly one condenses
   (`condenseSpecForReview`, `08c-code-review.ts:601`) and it sits behind
   `CONFIG_KEYS.REVIEW_FANOUT_DISTILL`, which defaults to `false`
   (`config.service.ts:394`) — so in practice it never runs.
2. **DAG coders get no spec at all.** `DagCoderContext`
   (`step-engine/step-definition.ts:172-181`) has no spec field; `coderContext()`
   (`dag-executor.ts:200`) passes title, description, `specSections` (section
   *refs*, per the planner contract at `06b-sprint-planning.ts:146`),
   acceptance criteria and `provides`. The only on-disk spec artifacts are 05a's
   (skipped when the spec has no findings, `05a:121-126`) and 08c's (written
   post-implementation, behind the dead flag). On a clean spec in DAG mode the
   coder never sees spec prose.
3. **Cross-step memory truncates rather than compacts.** `_fix-loop.ts:159`
   `slice(-6000)`, `:368` `slice(0,3000)`, `:462` `slice(0,4000)`, `:73`
   `slice(-1500)`. And the ledger that does exist (`environmentFindings` →
   `loadPriorFixContext`) is written only by step 07 and read only on fix rounds,
   so 07b / 08 / 08a / 08c / 08d each rediscover the same sandbox facts.

Meanwhile `maybeEnqueueStepSummary` (`step-runner.ts:2114`) already runs a cheap,
unlinked, best-effort LLM recap per finalizing step and writes
`task_steps.summary` — which has **zero** prompt-building consumers. Compaction is
already computed and thrown away.

Intended outcome: agents stop paying for the same spec 19 times, DAG coders can
actually read the spec, and what one agent establishes is available to the next.

## Invariants to respect (verified — these are the traps)

- **Sandbox mount.** `ctx.repoPath` and `ctx.workspacePath` are both the **repo
  root** (`task-queue.ts:226-237`), but a cli-exec invocation mounts the
  **worktree alone** at `SANDBOX_WORKDIR`. So an artifact for an agent must be
  written to `worktreePath` from `01-worktree-setup`'s output (as 08c does at
  `08c-code-review.ts:810`), **not** `ctx.repoPath` (as 05a does — correct there,
  because that file is for the Terminal, which keeps the repo-root mount).
- **DAG coders mount their OWN issue worktree** (`worktreeRel`,
  `dag-executor.ts:1701`; comment at `:208-210`). `.haive/` is git-excluded
  (`01-worktree-setup.ts:27,144`), so an untracked file in the task worktree is
  **not** carried into `git worktree add`. Each issue worktree needs its own copy,
  written in `createIssueWorktree` (`dag-executor.ts:142`, called at `:1595`).
- **`buildPrompt` is synchronous** and receives only `{detected, formValues,
  iteration}` (`step-definition.ts:40-52`). Anything needing DB or disk must load
  in `detect()` or at the runner-level augmentation point.
- **`task_events` survives step resets**; `task_steps.output` does not
  (`_step-reset.ts:96` nulls it, and the header comment at `:13-14` documents that
  task_events is deliberately untouched). Durable ledger entries go to
  `task_events`, following the `_fix-loop.ts` precedent.
- **The runner has one prompt-augmentation choke point** —
  `step-runner.ts:606-609` (`augmentPromptWithAttachments`,
  `augmentPromptWithTerseness`). The DAG path bypasses it entirely
  (`dag-executor.ts:1631-1706`).

---

## Slice 1 — Materialize the approved spec to `.haive/spec.md`

**Commit:** `feat(worker): write the approved spec to the worktree`

One durable artifact every later step and agent can point at. Fixes the DAG blind
spot on its own.

- New helper `packages/worker/src/step-engine/steps/workflow/_spec-artifact.ts`:
  - `resolveApprovedSpec(ctx)` — the existing 05a → 05 → 04 precedence, currently
    duplicated verbatim in 07, 06b, 08c, 08e, 09 and others. Lift it here and have
    those call it.
  - `writeSpecArtifact(worktreePath, spec)` — writes `<worktree>/.haive/spec.md`,
    idempotent, returns the relative path. Mirrors `08c-code-review.ts:810-812`.
- Call it in `06-gate-1-spec-approval.ts` `apply()` on the `approve` branch
  (after `recordSpecDecision`, `:289`). Load `worktreePath` from
  `01-worktree-setup`'s output, as 08c does.
- In `dag-executor.ts` `createIssueWorktree` (`:142`), after
  `ensureSandboxWritableTree` (`:174`), copy the task worktree's `.haive/spec.md`
  into the new issue worktree. Untracked, so `git worktree add` will not do it.
- Best-effort with a `logger.warn` on failure — a missing artifact must never fail
  the gate. Slices 2 and 3 degrade to inline text when it is absent.

**Rollback:** delete the two call sites. The file is untracked under `.haive/` and
is torn down with the worktree; nothing reads it until slice 2.

**Verify:** run a workflow task through Gate 1; confirm
`<repo>/.haive/worktrees/<branch>/.haive/spec.md` exists and matches the approved
spec. Force DAG mode at 06b and confirm each
`.haive/worktrees/<branch>--ISSUE-00N/.haive/spec.md` exists.

---

## Slice 2 — Generalize `condenseSpecForReview` into a document view

**Commit:** `feat(worker): send agents a spec index instead of the whole spec`

- Move `condenseSpecForReview` (`08c-code-review.ts:601-621`) into a new
  `packages/worker/src/step-engine/steps/_doc-view.ts`, renamed
  `condenseDocument(text, opts)` with the heading-lead budget as a parameter
  rather than the hardcoded `REVIEW_SPEC_HEAD_LINES = 8`. Keep the API
  document-shaped (markdown in → `{ text, dropped }` out) rather than
  spec-specific: the planned translation task type needs exactly this shape for
  chapter-level navigation of a book, and should reuse the module unchanged.
- Add `resolveSpecView(ctx, { full })` alongside it: returns the full spec when
  `full` is true or the mode is `'full'`, otherwise the condensed index plus a
  pointer to `.haive/spec.md`. Falls back to the full spec when slice 1's artifact
  is missing, so there is no state in which an agent gets an index pointing at
  nothing.
- New `CONFIG_KEYS.SPEC_VIEW_MODE` (`'config:output:specViewMode'`, values
  `'toc'` | `'full'`, **default `'toc'`**) in
  `packages/shared/src/config/config.service.ts`, plus the admin GET/PUT and
  toggle card in `packages/api/src/routes/admin.ts` (follow the
  `REVIEW_FANOUT_DISTILL` handlers at `admin.ts:664-670`) and the matching card in
  the web admin settings page.
- Retire `REVIEW_FANOUT_DISTILL`: 08c switches to `resolveSpecView`. Remove the
  key, its default, its admin handlers and its web card.
- Switch the spec consumers:
  - **Full spec** (they reason over the whole document): `04a-spec-audit`,
    `05-phase-0b5-spec-quality`, `05a-resolve-spec-warnings`,
    `06-run-config`, `06b-sprint-planning`.
  - **Index + pointer**: `07-phase-2-implement` (both branches, `:396` and
    `:411`), `07a-code-simplify`, `07b-phase-4-validate`, `08-phase-5-verify`,
    `08a-browser-verify`, `08c-code-review`, `08c2-code-audit`,
    `08d-adversarial-qa`, `08e-insights-triage`.
- `06c-dag-execute` `buildCoderPrompt` (`:25`): add `spec` to `DagCoderContext`
  (`step-definition.ts:172-181`) and `coderContext()` (`dag-executor.ts:200`),
  carrying the index plus the pointer to the coder's own `.haive/spec.md`. The
  issue's own `specSections` stay as they are — they name which sections this
  coder owns; the index tells it where to read them.

**Rollback:** flip `SPEC_VIEW_MODE` to `'full'` in the admin UI. Every builder
goes back to the current text with no deploy.

**Verify:** unit-test `condenseDocument` (headings preserved, lead budget honored,
`dropped` false when nothing trimmed) — move and extend 08c's existing coverage.
Run one task in each mode and diff the persisted `cli_invocations.prompt` for step
07; confirm the ToC form is materially shorter and still names every section.
Confirm an agent that needs a dropped section can `Read .haive/spec.md`.

---

## Slice 3 — Widen the fix-loop ledger to a task ledger

**Commit:** `feat(worker): carry agent findings across every step, not just fix rounds`

- New `packages/worker/src/step-engine/task-ledger.ts`, modelled on
  `attachments-context.ts`:
  - `recordLedgerEntry(db, taskId, taskStepId, { stepId, round, text })` — writes
    a `ledger.entry` row to `task_events`. No migration: `task_events`
    (`packages/database/src/schema/tasks.ts:527-543`) already has
    `taskId` / `taskStepId` / `eventType` / `payload` and is indexed on both
    `task_id` and `event_type`.
  - `augmentPromptWithLedger(db, taskId, prompt)` — prepends a
    "what earlier steps established" block. Returns the prompt unchanged when the
    ledger is empty (so pre-implementation steps pay nothing) and on any lookup
    error, exactly as `augmentPromptWithAttachments` degrades.
  - Dedupe by the `fixLoopFingerprint` normalizer already in `_fix-loop.ts:174`
    (uuid / path / digit stripping) so a repeated finding appears once.
- Wire the read at the single choke point, `step-runner.ts:606-609`, and at the
  DAG dispatch site `dag-executor.ts:1631` (which bypasses that chain today, so it
  currently gets neither attachments nor terseness either — worth noting, out of
  scope to fix here).
- Wire the write: extend the `environmentFindings` output-contract line (today
  only in `07-phase-2-implement.ts:322`) to the other agent steps that establish
  environment facts — `07b`, `08`, `08a`, `08c`, `08d` — and call
  `recordLedgerEntry` from their `apply()`. DAG coders already emit `concerns`;
  record that too.
- Repoint `loadPriorFixContext` (`_fix-loop.ts:378`) at the ledger instead of
  querying prior-round `task_steps.output`, which `_step-reset.ts:96` nulls.
  Behaviour is unchanged when no reset happened and strictly better after one.

**Rollback:** stop calling `augmentPromptWithLedger` at the two sites. The
`task_events` rows are inert and append-only; nothing else reads them.

**Verify:** unit-test `augmentPromptWithLedger` (empty → unchanged; DB throw →
unchanged; duplicates collapse). Run a task with a deliberate environment quirk
(e.g. a tool absent from the sandbox) and confirm the fact recorded at 07 appears
in the 08c prompt.

---

## Slice 4 — Compaction instead of truncation

**Commit:** `feat(worker): compact the task ledger instead of slicing it`

- In `maybeEnqueueStepSummary` (`step-runner.ts:2114`), mirror the summary it
  already produces into a `ledger.entry` row alongside the existing
  `task_steps.summary` write in its completion handler. No new LLM call — the pass
  already runs, is unlinked (`taskStepId: null`), stays out of token totals, and
  never throws.
- In `augmentPromptWithLedger`, when the assembled block exceeds its char budget,
  drop **oldest whole entries** and prefer each entry's compacted summary over its
  raw text — instead of a mid-sentence `slice()`. Log what was dropped.
- Leave the raw-error tail slices alone. `cleanDiagnosis`
  (`_fix-loop.ts:153-160`) keeps `slice(-6000)` on purpose: CLI errors put the
  summary last, and compacting a stack trace loses the line that identifies the
  fault. Compaction applies to the **ledger**, not to a single raw diagnosis.

**Rollback:** revert the budget path in `augmentPromptWithLedger` to the plain
slice. The mirrored rows stay harmless.

**Verify:** unit-test the budget path (over-budget input drops whole oldest
entries, never splits one; summaries preferred when present). Confirm on a
long-running task that the injected block stays within budget and that the newest
entries always survive.

---

## End-to-end verification

1. `pnpm typecheck` and `pnpm test` **inside the containers** (per-container
   `node_modules`) — `docker compose exec haive-worker pnpm --filter @haive/worker test`,
   same for `@haive/shared` and `@haive/api`.
2. `pnpm format:check` before any commit.
3. Rebuild shared before restarting the worker: `pnpm docker libs`, then restart
   worker — slice 2 adds a `@haive/shared` export, which crash-loops a live worker
   and api if the dist is stale.
4. One full workflow task, single mode: confirm `.haive/spec.md` exists after
   Gate 1, that step 07's persisted prompt carries the index rather than the full
   spec, and that the run completes through Gate 3.
5. One task forced to DAG at 06b: confirm each issue worktree has its own
   `.haive/spec.md` and that coder prompts carry the index.
6. Compare `cli_invocations` prompt lengths for steps 07/07b/08c against a
   pre-change task on the same repo to quantify the saving.

## Out of scope

- PageIndex or any external retrieval service. The RAG index is already
  structure-aware (`_rag-chunkers.ts`: heading sections plus PHP/JS/Python/Go/Rust
  symbol extraction, hybrid dense+lexical RRF), and repo navigation is already
  LLM tree search via grep/LSP/Read.
- CLI session resume (`--resume`). It re-inherits the CLI's own truncation policy,
  which is the thing we do not control, and welds steps together that stay
  independent for retry and DAG fan-out.
- The translation task type. Slice 2's `_doc-view.ts` is shaped to serve it later;
  nothing here builds it.
- Routing attachments/terseness through the DAG dispatch path (pre-existing gap,
  surfaced in slice 3, not fixed here).

---

# Amendment — 2026-08-21: premises re-checked and hold; three anchors stale

Unbuilt — no `task-ledger.ts`, `_doc-view.ts` or `_spec-artifact.ts` exists. All three defects in
the body were re-verified and still hold; the citations behind two of them have moved.

- **Defect 1 confirmed, anchors stale.** `condenseSpecForReview` is at `08c-code-review.ts:757`, not
  `:601`. `CONFIG_KEYS.REVIEW_FANOUT_DISTILL` still defaults to `'false'`, but the default is at
  `config.service.ts:496`, not `:394` — so "in practice it never runs" is still true.
- **Count drifted, conclusion unchanged.** A `=== Spec` block now appears 20 times across 12 workflow
  step files; the body says 19 across 13.
- **Defect 2 confirmed.** `DagCoderContext` is `step-definition.ts:183`.
- **The no-resume premise holds.** `sessionId` is still declared at `cli-adapters/types.ts:12` and
  set nowhere on the adapter path. The `sessionId` in `terminal/terminal-session-manager.ts` is the
  terminal session's and is unrelated — do not mistake it for CLI resume support.
