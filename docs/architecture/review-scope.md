# Review scope

Ownership is a separate boundary from change causality. Newly installing a module makes
its integration relevant to acceptance checks; it does not authorize auditing or rewriting
its internals. `_dependency-policy.ts` classifies Drupal core as infrastructure and conventional
contrib, vendor and node_modules locations as third-party. Composer scaffold roots and Drupal 7
core layouts are recognized. An operator can declare exact maintained package directories in
`.haive-data/dependency-ownership.json` (`{"ownedPaths":["web/modules/contrib/company_module"]}`)
on the task's base branch. The policy is read from the fork point; an agent's working-copy or
task-branch declaration cannot claim ownership. Core cannot be exempted. Other framework
layouts remain governed by the prompt rules; this classifier is not a sandbox write filter.

07b and 08c assign upstream classification on the host, independently of the reviewer's
`in_scope` claim. Upstream findings remain visible, marked for a user decision at gate 2;
they never become automatic repair assignments or refuter work. Validation stops its local
fix loop when upstream findings are present. Medium and low advisories never piggyback on a
high or critical finding's automatic repair diagnosis. Review dimensions assess task behavior
and existing project contracts; they do not mandate new translation or other subsystems.

Every reviewing step (07a, 07b, 08a, 08b, 08c, 08c2, 08d) is scoped by ONE collector,
`collectImplementationFiles` (`_impl-changes.ts`). It unions 07's agent-reported
`filesTouched`, the DAG issues' `filesModified`, and the dirty worktree, caps the list at 100
and REPORTS the cap (`changedFilesBlock`'s COVERAGE notice orders the agent to state what it
was not given) — a silent cap once had a reviewer approve 100 of 150 files as though it had
seen all of them. The list is not a convenience: `worktreeGitfileMask` bind-mounts an empty
file over the worktree's `.git` for every cli-exec invocation, so inside the sandbox there is
no `git status` and no `git diff`, and everything an agent knows about the change has to
arrive in its prompt.

Each path carries the LINES this change wrote (`lines 12-18, 45`, `new file`, `deleted`,
`no line changes (mode or rename only)`). Measured against the MERGE-BASE with the task's base
branch, not HEAD, because the two execution paths commit differently and only the fork point
covers both: single-agent work is still uncommitted at review time (the first commit is
`10-gate-3-commit`), while `dag-executor` commits every issue and merges it in, so a DAG task's
tree is CLEAN by 07b and `git diff HEAD` reports nothing. `git diff <ref>` compares the WORKING
TREE to that ref, so one call covers committed and uncommitted work together. Line numbers come
from the hunk headers' `+` side, which is the file as the agent will read it.

ABSENT is not "unchanged". A path git never saw (an agent-reported file, a diff that could not
be read) carries no note, and both the prompt legend and the scope fence say so explicitly:
the whole file is in scope. Narrowing on a measurement nobody made is the one direction this
must never fail in.

`SCOPE_BOUNDARY` (`_scope-fence.ts`, shared with the on-disk agent templates so the inline
persona and the file that OVERRIDES it cannot drift) is therefore keyed on lines, not files:
in scope = the lines the change wrote, the function or block each sits in — an edit's effect is
not confined to the edited line — plus blast radius (callers of a changed signature, consumers
of a changed schema, paths the change makes newly reachable). It used to be "the files this
change touched", which made a pre-existing defect anywhere in a 5,000-line file a blocking
finding against a three-line edit; MEASURED across 102 runs of one task, ~450 blocking findings
sat on legacy code the task never touched, each costing a capped fix round whose fixer then
REWROTE that legacy code (one worktree: 71 dirty files against a plan of 23). Out-of-scope
findings are never dropped, only re-dispositioned — `## INSIGHTS` for the peer/lens reviewers,
`in_scope: "no"` for security, the markdown report for 07b. Verify's phpcs verdict is held to the
same lines (see [Fix loop](fix-loop.md)), through `collectChangedLineMap`: the prompt collector's
caps (20 ranges per file, 100 files) must never decide a verdict, so that map is uncapped, and
every diff file header is read only before that file's first `@@`, since a removed `-- x` line
shows as `--- x`. A binary or mode-only change prints no header and no hunk, so the changed paths
come from `git diff --name-status -z` against the same base, and a path no hunk measures counts
whole: the list cannot tell a mode change from a binary one, so a chmod of a legacy file holds
every violation in it to the verdict. Without that list, or without a base, the map is null and
the verdict unscoped.

An EMPTY change set fails the step (`assertReviewableChange`), at the prompt-build boundary
rather than in detect() so a replayed `detect_output` is guarded too, and always before
dispatch. It used to render a fallback telling the agent to work the change out from the
workspace — which it cannot, so it guessed, and the verdict it returned covered nothing. A skip
would be worse than a failure: at gate 2 a review with no findings is indistinguishable from an
approval. The two ways to get an empty set are reported as different diagnoses, since
`dirtyWorktreeFiles` no longer swallows its own error — a failed scan names git's message, a
scan that ran and found nothing says the implementation wrote no files.

**Review is where a workflow run's time goes, and in DAG mode HALF of it is spent before the
merge.** MEASURED across five runs of one task, per-issue DAG reviewers against total
`06c-dag-execute` CLI time: 184 of 369 min (Opus 5 max), 59 of 109 (Opus 5 medium), 39 of 72
(Opus 5 medium, no plan), 131 of 349 (gpt-6-astra) — consistently ~50%, and the merged result is
then reviewed AGAIN by 07b, 08c, 08c2 and 08d. On the max-effort run that is ~487 of 1,096 CLI
minutes, 44% of the whole run. That per-issue layer is the `sprintReviewEnabled` checkbox on
06-run-config ("AI-review each issue before merge"), default ON.

**Do NOT reach for that checkbox as a cost lever — it is two features under one flag.**
`resolveReviewPhase` (the ~50%) reviews issues that SUCCEEDED, as the merge gate
`runLevelMerge` keys on. `resolveEscalationPhase` (issue-advisor -> replanner) handles issues
that FAILED, costs nothing when none did, and sits inside the same `if (plan.reviewEnabled)`.
So turning review off ALSO turns off failure recovery, and the `coderFailed.length > 0 &&
!plan.reviewEnabled` branch then fails the whole level on one failed coder. Both halves landed
the same day — `e37a39c7` (per-issue review gate) and `79e321ad` (escalation hierarchy) — which
is how they came to share a flag. Neither `dag-review-smoke` nor `dag-escalation-smoke` runs
with it false, so that combination is UNTESTED as well as unsafe.

Splitting them is the fix: escalation always available, per-issue review the toggle. Only then
is the default an empirical question — and what has NOT been measured either way is whether
07b/08c/08c2/08d catch what the per-issue reviewer catches. Retrofitting review onto a failure
is NOT the alternative: it gates SUCCEEDED issues before merge, and by the time a defect
surfaces at 07b, `cleanupLevelWorktrees` has destroyed the per-issue worktrees. The retroactive
path already exists and is the fix loop, in the integration worktree.

Two neighbouring numbers to read before concluding anything from a DAG run: `issueCount` and
`levelCount` (`06b-sprint-planning.output`). Levels are BARRIERS, so parallelism tracks the
level shape and not the issue count — MEASURED, 4 issues in 1 level ran 32 min wall against 72
CLI (2.25x), while 5 issues in 3 levels ran 111 against 109 (0.98x, i.e. the DAG bought no
concurrency at all and still paid per-issue worktrees and merges), and 13 issues in 5 levels ran
215 against 369 (1.72x). A single-issue level is a pure barrier; the leading one is the
deliberate convention-setter, the trailing ones are integrators. No rule here is safe to derive
from those five points — they vary by model and by effort — but a run whose wall time ~ its CLI
time is a DAG that serialised, and that is worth looking at before blaming the model.

**Similar code is reported, not changed.** Every implementing pass is told to leave the same
code or defect it finds outside the task alone and to list it instead: 07 as `similarSites`, the
DAG level coder and the DAG fix coder as `similar_sites`. `ingestReviewRun` reads the fix coder's
JSON for this field and its `concerns`, which reach the ledger. Gate 2 shows the union of every 07
round and every DAG issue as a status row after its checks, and the person acts on an entry by rejecting
with feedback that names it, which reaches 07 as a human directive. A site whose file a round after
its last report edited is MARKED, not dropped (`editedInRound`): that round may have edited the file
for something else, and dropping the site would then hide one still left unchanged. The mark reads
07's `filesTouched`, the agent's own and possibly incomplete account, so it is a hint and never
proof, and the row says the agent LEFT each site unchanged when it reported it rather than
asserting the site is unchanged now. A manual retry of 07 replaces that round's pass, its reports
included, exactly as it replaces the pass's summary and `filesTouched`: a retry means "redo this
step", the edits the pass left stay visible to every reviewer through the dirty-worktree scan, and
the rerun reads the same code. `quick_bugfix` runs no gate 2, so gate 3 shows the row whenever no
gate-2 decision exists.

The lists are display copy and are kept that way. They are sanitised on the way in and again on
read (`_similar-sites.ts`): a path must be single-line, fence-safe and inside the repository, and
a reason is collapsed to 200 chars. They never enter the task ledger, for the reason
`REPO_IS_DATA_ACTING_LINES` gives: an editing agent's prose relayed into later prompts is how
hostile repository text travels. `task_dag_issues.similar_sites` (migration 0165) is MERGED per
pass rather than written, because an advisor retry re-runs the coder into the same row. The DAG
schema reads a malformed list as `[]` (`.catch`), since a strict field there would turn a finished
coder into `failed_unrecoverable` over a list only a person reads.

**Out-of-scope findings reach gate 2 too.** 08e offers the `## INSIGHTS` lines agents wrote for
this task to act on, but auto-continue pre-answers 08e with an empty pick (`06-run-config`),
`plan_tasklist` runs gate 2 without 08e, and `quick_bugfix` runs neither. So gate 2 lists every
insight nobody picked at 08e in its own row after the similar-sites row (`_gate-insights.ts`), and
gate 3 shows it when no gate-2 decision exists. 08e's picks are subtracted by title and location
across every round, since its `i-N` ids are positions. The row is display copy under the same rules
as similar sites: each field collapsed to one line of at most 200 chars and escaped, the list cut
at 30 with the rest counted, and nothing of it entering a prompt.
