# External-change catch-up: KB and plan for commits Haive did not make

> **Status — shipped** `f177e2f` (slice 1), `e799f08` (slice 2), `7a01345` (slice 3),
> `ca4b64b` (a defect found reviewing slice 2). Slice 4's per-step summary rides the
> `summary` key on both apply outputs, which `resolveCuratedSummary` already lifts with no
> CLI call; the repo-page drift badge is deferred as planned. Verified against the tree on
> 2026-09-08.

## Context

A repository is not only edited by Haive. A teammate pushes, the user commits from their
own editor, a `git pull` lands a month of work. The code arrives; nothing derived from the
code learns about it.

Measured against the tree, not assumed:

| Layer | Sees external commits? | Evidence |
|---|---|---|
| Working tree | yes | `00a-sync-base.ts` fetches origin and ff/merges the base before `01` cuts the branch |
| RAG index | yes, incidentally | `02-pre-rag-sync.ts` re-collects **every** file and dedupes on `chunk_hash`. It never asks what changed, so it cannot miss anything |
| Knowledge base | **no** | `11-phase-8-learning.ts` builds its KB prompt from `implementOutput.filesTouched` — this task's own agent report |
| Plan nodes | **no** | `11f-plan-reconcile.ts` scopes on `collectImplementationFiles`, a merge-base diff of this task's branch |
| Plan code links | **no** | `markPlanCodeLinksStale` reads `tasks.changedPaths` of the current task |

**There is no commit watermark to fix — there is one to add.** No `last_synced_commit` on
`repositories` anywhere in the tree. The only stored shas are `bundles.last_sync_commit`
(custom-bundle git sync), `plan_node_code_links.derived_at_commit` (per-link provenance),
and `tasks.commit_sha`, which `10-gate-3-commit` writes and **nothing reads**. No code
anywhere runs `git log <range>`; the five `rev-list` call sites all count ahead/behind.

**Stale KB is worse than absent KB, and that is structural.** `03-phase-0a-discovery` and
`04-phase-0b-pre-planning` both read `KB_DIR/*.md` straight into their prompts. And
`applyKnowledgeReserve` RESERVES 2 slots of every RAG page for KB chunks — so once the KB
describes code that no longer exists, that prose is *guaranteed* promotion into every
agent's context while the fresh code chunks compete for the remaining slots. A correct RAG
index makes the KB gap louder, not quieter. This is the same trap `08b-test-management`
names: a wrong answer costs more than a missing one.

One path already pulls code with no resync at all. `PLAN_MIRROR_JOB_NAMES.PULL`
(`plan-mirror-queue.ts`) runs `integrateOrigin` — a real merge into the checkout — and then
reconciles `plan.json` only. That path needs no fix of its own once a watermark exists: it
moves the checkout without moving the watermark, so the next workflow task detects the drift
by construction.

Checked and ruled out as existing coverage: `onboarding-upgrade/` reconciles template
artifacts only and never re-runs `08-knowledge-acquisition`; `00-triage` reads no KB;
`repo-queue` has clone/scan/extract/copy/init and no pull; `reconcilePlanMirror` handles
*another Haive instance's plan edits*, which is plan-data drift, not code drift.

**Decided with the user, 2026-09-08.** Catch-up runs as workflow steps only — no standalone
task type. The plan side gets a full LLM reconcile at task start, not just deterministic
link-staleness. Repositories with no watermark stamp the current branch point and review
nothing.

## Rollback

Written before the change, per the repo rule.

- `CONFIG_KEYS.EXTERNAL_SYNC_ENABLED` off makes both steps self-skip. No new prompt, no new
  form, no watermark write — byte-identical to today's behaviour. This is the rollback, not
  deregistration: removing a registered step breaks the forward walk for tasks already
  mid-flight.
- The two columns are additive and read by nothing else, so dropping them is safe. There is
  no backfill to undo — a NULL watermark is the legacy state and stays legal forever.
- KB edits land as an ordinary commit on the task branch. Reverting one is `git revert`.
- Plan ops are applied through `applyPlanPatch` like every other plan write, so the plan's
  own version history is the undo path.

Two phases, additive first: slice 1 writes a watermark and displays drift while changing no
prompt and running no agent. Slices 2 and 3 are each independently revertible.

## Data model

Two columns on `repositories`, both `varchar(40)` NULL, NULL meaning "never tracked":

- `kb_synced_commit` — the last commit whose code has been REVIEWED into the knowledge base.
- `plan_synced_commit` — the same for the plan.

**As built:** "reviewed", not "folded in", and the difference is a decline. A developer who
is shown the commits and unticks the proposal has ruled on them, so the watermark advances;
re-asking every future task about the same range is the nagging failure mode, and the step's
own Retry is the escape hatch for the other reading ("the agent got it wrong"). What must
never advance the watermark is a range that could not be MEASURED — `ExternalDrift.measured`
carries that, because "nothing changed" and "we could not tell what changed" produce the same
empty commit list and only one of them means the commits were seen.

**Two columns rather than one, because they become true at different moments.**
`plan_synced_commit` is stamped by the plan step's own `apply`: plan ops are database
writes, immediate and durable, and they survive an abandoned task. `kb_synced_commit` is
stamped from the worker's `markTaskCompleted` for `workflow` tasks — the same hook and the
same reasoning as `stampRepositoryOnboarded` and `completePlanNodesForTask` — because KB
edits sit on the task branch until `12-worktree-cleanup` merges it. Cancel and fail write
through their own functions, so an abandoned run can never claim a KB the base branch never
received. The cost of that asymmetry is that an abandoned task's successor re-reviews the
same commits, which is the correct outcome.

## The range

`<watermark>..<branch point>`, where the branch point is the base sha `01-worktree-setup`
cut from, resolved as `git merge-base <branch> <base>` at detect time. Not the worktree
HEAD: this task's own commits are not external, and merge-base is the ref
`collectImplementationFiles` already picks for the same reason — it covers both execution
paths, where HEAD does not.

**Haive's own commits are excluded by sha**, as a guard behind the watermark rather than
instead of it. **As built:** three cleanup outcomes need three covers, and `--no-merges` on
the log supplies one of them for free — an ordinary merge commit carries a sha nothing here
records, and dropping merges removes it while leaving the feature commits beneath it, which
`tasks.commit_sha` then catches. A squash is caught by `squashCommitSha`, which lives in
`task_steps.merge_resolve_state` (jsonb) rather than the top-level `tasks.squash_sha` this
plan assumed. A fast-forward is caught by `tasks.commit_sha`. The watermark alone handles the normal case; the exclusion
covers the gaps it cannot — an abandoned task, a run with the switch off, a squash-merge
that rewrote the shas. Keyed on recorded shas, never on the committer name, which is
user-configurable and therefore ephemeral.

**First run on a NULL watermark stamps the branch point and reviews nothing**, reporting
"tracking starts here". No backfill, no migration data step, same stance as `onboarded_at`:
a repository keeps the verdict it had. Pre-existing drift is not closed by this feature.

Caps are applied and REPORTED, per `changedFilesBlock`'s coverage rule: commits at 200,
changed paths at 200. A silently capped list once had a reviewer approve 100 of 150 files
as though it had seen all of them.

## Design

Two registered steps, both `workflowType: 'workflow'`, both `requiresCli: true`, both
`allowSkip: true`, sharing one helper `_external-drift.ts` that resolves the watermark,
the range, the excluded shas and the capped commit/path lists.

They sit at **1.8** and **1.9** — after `01c-ddev-env` (1.6) so the worktree exists and KB
edits land on the task branch, and before `02-pre-rag-sync` (2) so the refreshed KB is
indexed in the same run and before `03-phase-0a-discovery` (3) so this task's spec is
written against a true KB. Placing them at the tail beside `11`/`11f` was rejected for
exactly that reason: the harm is the read at 03/04, and a fix that lands after it leaves
every drifted task planning against fiction.

### `01e-external-kb-sync` (index 1.8)

`detect` is deterministic: resolve the range, list commits (`%H%x00%s`) and changed paths
(`--name-status`), drop Haive's own shas, apply the caps. Zero external commits, no
repository, no `KB_DIR`, or the kill-switch off → `skipIf` and the step costs nothing.

`llm` with `preForm: true`, the same tool profile `11-phase-8-learning` uses for its KB
sync — it is the same job on a different diff. The prompt carries the commit subjects and
the changed-path list and tells the agent to read the files itself; the diff is not inlined.
`optional: true`, so a failed or undispatchable catch-up never blocks a task — the watermark
simply does not move.

`form` shows the commit list plus the KB diff, built by `buildKnowledgeDiffArtifact` with
`pathspecs: [KB_DIR]` under its own artifact name (`external-kb-diff.json` — its own name so
it cannot collide with the learning and commit gates' artifacts, and so the viewer's
collapsed state stays per-gate). One checkbox, ticked by default, plus the editable viewer.

`apply` — and this is the load-bearing part:

- Declined → revert KB edits scoped to `KB_DIR` and do not stamp.
- Accepted → **commit the KB edits immediately**, reusing a helper extracted from
  `11b-kb-commit`'s staging path (`_kb-commit.ts`, which also took ownership of the KB
  revert so there is one destructive git path rather than two copies).

**As built — a defect worth keeping:** the first version read and committed
`ctx.workspacePath`, which is only the FALLBACK for a task with no worktree; `11b` and `11c`
both resolve the worktree the long way from `01-worktree-setup`. Drift was therefore measured
in the worktree while the commit looked at the parent checkout, so `git add` would find
nothing and the agent's edits would sit uncommitted until `revertKbSync` destroyed them at
index 11 — the exact failure this commit exists to prevent. Fixed by having
`resolveExternalDrift` RETURN the tree it measured, so the range and the writes cannot refer
to different trees.

That commit is not tidiness. `11-phase-8-learning`'s `revertKbSync` runs
`git checkout HEAD -- KB_DIR` plus `git clean -fdq -- KB_DIR` on the worktree when a user
declines the learning step's own KB sync. This step's edits would otherwise sit uncommitted
from index 1.8 to `11b` at 11.5, and one decline at index 11 would destroy them silently.
Committing at 1.8 makes `checkout HEAD` restore *to* the catch-up, not past it. Narrowing
`revertKbSync` to the agent's self-reported file list was rejected: that report is the
agent's claim, and a revert scoped by it fails open on exactly the file the agent forgot to
mention.

### `01f-external-plan-sync` (index 1.9)

A near-clone of `11f-plan-reconcile`, which is already the right shape — deterministic
detect, `preForm` proposal, a per-op tick list, `applyPlanPatch` with `origin: 'user'` and
`onUnresolvableRef: 'drop'`. Four differences:

1. `changedPaths` come from the external range.
2. The prompt says these commits landed *outside* Haive. There is no spec to quote, so the
   commit subjects carry the intent signal in its place.
3. `applyPlanPatch` is given `derivedAtCommit: <branch point>`. `11f` leaves that null; here
   the exact commit is known, and a code link that cannot be dated cannot be aged.
4. `detect` first marks plan code links stale for the external paths, through a path-keyed
   variant of `markPlanCodeLinksStale` (today's function reads `tasks.changedPaths` and so
   cannot express this). That runs whether or not the agent runs or the user approves: link
   rot is a fact about the code, not a proposal about the plan.

**As built:** `MAX_PROPOSED_OPS`, `proposedOps` and `describePlanOp` moved out of
`11f-plan-reconcile` into `_plan-ops.ts`. Both steps put the same tick list in front of a
person, and a second copy of `describePlanOp` is a second chance to label an op as something
other than what ticking it does. `data-migrations.ts` imported both symbols from the step
module and was repointed.

`apply` stamps `plan_synced_commit`. It keeps `11f`'s decision not to set `marksReviewed` —
an agent proposing a change is not an agent having reviewed the node against the code, and
claiming otherwise clears the very drift warning this feature exists to raise.

### Kill switch

`CONFIG_KEYS.EXTERNAL_SYNC_ENABLED: 'config:workflow:externalSyncEnabled'`, `'true'` in
`DEFAULT_CONFIG`, checked in both steps' `shouldRun` (`01f` also honours
`PLAN_CANVAS_ENABLED`, as `11f` does).

**As built — registration is four surfaces, not one.** Beyond `registerWorkflowSteps`, both
steps join `PLAN_TASKLIST_EXTRA` rather than the `SPINE`: the spine does no knowledge-base or
plan work at all, so `quick_bugfix` carries the drift to the next task that can act on it
instead of marking it reviewed. In `@haive/shared`, `CLI_DISPATCH_STEPS` is asserted at BOOT
(`assertCliDispatchListInSync` throws inside `registerAllSteps`), so omitting an entry fails
the worker at startup rather than in review; `SKIPPABLE_STEP_IDS` is not asserted, and
omitting it there would have made `allowSkip: true` a lie, since that list is what renders the
Skip button. Global only, no per-repository column:
a repository nobody else touches produces an empty range and skips for free, so a per-repo
switch would gate something that already costs nothing.

## Slices

1. **Watermark and drift detection.** The two columns, the migration, `_external-drift.ts`,
   range resolution, sha exclusion, caps. No agent, no prompt change, no step registration —
   the detection is unit-testable on its own and the slice is inert until slice 2.
2. **KB catch-up** (`01e`, index 1.8) plus extracting `11b-kb-commit`'s staging into a shared
   helper. The `revertKbSync` collision is fixed inside this slice or not at all.
3. **Plan catch-up** (`01f`, index 1.9), the path-keyed staleness variant, `derivedAtCommit`.
4. **Surfacing.** A curated step summary for each (`resolveCuratedSummary` lifts
   `summary`/`notes` off the apply output with no LLM call, so this is a field name, not a
   feature). A repo-page drift badge is deliberately deferred — it needs a route that
   resolves the range outside a task, which is slice 1's helper plus an api surface, and
   nothing about the catch-up depends on it.

## Rejected

- **A standalone `repo_sync` task type.** Decided against with the user. The residual gap is
  accepted and stated here rather than hidden: a repository nobody runs workflow tasks on
  never catches up. If that repository is being edited externally, its KB was already the
  stalest thing in the system before this feature existed.
- **Reaching back to the onboarding commit for legacy repositories.** Correct in principle
  and wrong in practice — thousands of commits through one agent pass produces a confident,
  truncated, partial KB rewrite. A wrong KB is the failure this whole plan exists to fix.
- **Reusing `tasks.commit_sha` as the watermark.** It is the FEATURE-branch sha;
  `12-worktree-cleanup`'s merge moves the base past it, and a squash rewrites it entirely.
  It is a fine exclusion key and a broken watermark.
- **Widening `11`/`11f`'s existing inputs instead of adding steps.** The smallest possible
  diff, and it fixes the wrong task: the KB would still be stale for the 03/04 reads of the
  task doing the widening. Drift would be bounded at one task instead of unbounded, which is
  an improvement over nothing and short of the goal.
- **Deterministic-only on the plan side** (stale-marking now, judgement deferred to `11f`).
  Rejected by the user in favour of a full reconcile at task start. The cost is explicit: one
  CLI call and one human gate at the head of every task that has drift. The deterministic
  half survives inside `01f`'s detect regardless, because it is free and always correct.
