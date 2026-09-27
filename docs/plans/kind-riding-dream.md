# Deep Project Analysis — a resellable Haive module

## Context

Haive's quality machinery is change-scoped: `08c`, `08c2` and `08d` review the diff a task produced,
and only `07_7-secret-sweep` reads the whole tree. Nothing answers "what is wrong with this project",
which is the question `docs/SECURITY-COVERAGE.md` now openly records as uncovered.

The user has a prior workflow for exactly this (`deep_project_analysis.zip`): N CLIs audit a codebase
in parallel across ten dimensions, a synthesis agent consolidates into one report, and the loop
repeats until nobody finds anything. Its taxonomy is excellent. **Its loop failed.** The included
real output reached **v79 with 502 remediation tasks and, by its own header, "ZERO code changes
deployed"**, a 1.35 MB single file it calls an "OPERATIONAL USABILITY CRISIS", and 43 audit sections
escalating into "Black Swan", "Post-Quantum", "Geopolitical" and "Universe Simulation" reviews.

That is a design defect, not model misbehaviour: convergence required agents to return *empty*, while
the synthesis step struck agents that returned empty as "Zero Value". Survival and termination
pointed in opposite directions, and the report was instructed to stay a SINGLE file, so it grew until
it no longer fit a context window.

**This plan ports the taxonomy and discards the loop.** It ships as `@haive-module/deep-analysis`, a
paid module distributed through a private registry.

**Executes only after** both modularity plans land: `serialized-chasing-thacker` (module system,
incl. its distribution and module-contributed-steps rules) and `rippling-wibbling-puffin`
(data-driven task types, incl. its module-step composition and dangling-reference rules). Neither is a runtime dependency of the other for this module — it needs `./steps` from
the first and the composable catalog + task-type seed from the second.

`purring-marinating-peacock` (multi-model fan-out) is a third dependency and the only OPTIONAL one:
`deep_scan` must run correctly single-model and merely improve when that plan's Phase 2b exists. See
`scan-analyze`, which is where the two compose.

## What the module ships

Package `@haive-module/deep-analysis`, `files: ["dist"]`, published to GitHub Packages, installed as
a dependency of api + worker (registry token via BuildKit secret — see "Distribution and
entitlement" in `serialized-chasing-thacker.md`).

That install path presumes the customer can REBUILD api+worker, which a published-image install
cannot. DECIDED 2026-09-07 (`serialized-chasing-thacker.md`, "DECIDED — a published-image install
gets PER-CUSTOMER images built by the vendor"): for such a customer the VENDOR builds api+worker
with this module in and publishes a private per-customer tag. So the `pnpm module add` path above is
the DEV-IT story, and the shipping story for a paying customer is a per-customer image derived from
the base release. Nothing about what this module SHIPS changes; what changes is who runs the build,
and that revoking the entitlement stops the next image being built.

- `./manifest` — `hasSteps`, `composableSteps` (its steps, for the task-type composer),
  `taskTypes` (the `deep_scan` seed), `nav` + `pages` (a findings dashboard), `globalSettings`.
- `./steps` — the pipeline below.
- `./routes` — read API backing its dashboard.

The dashboard is worth calling out as product value, not decoration: **`review_findings` has no UI at
all today** — nothing in `packages/web` or `packages/api` reads it. The module is its first consumer.

## The pipeline

One task type, `deep_scan`, composed of module steps plus core steps from the catalog.

**1 · `scan-scope`** — detect + form, and the only step that runs before any CLI fans out.
**Every dimension is optional.** The set is `REVIEW_DIMENSIONS` (`shared/src/review/dimensions.ts`)
— the same fourteen every reviewing step already scores a change against — plus **coherence**,
**comment-debt** and **dead-code**, which the module owns. Seventeen in total, individually
selectable, none mandatory or implied, and there is no "scan everything" path that skips the form: an
empty selection dispatches nothing rather than falling back to all seventeen.

**Import that constant; do not re-list the names.** This plan was written before it existed
(`3741548b` 13:58, `99c176df` 15:15, both 2026-09-04) and its prose list had already drifted: it
omitted **accessibility, internationalization, backward compatibility and privacy / compliance**,
and wrote `developer-experience` as "DX" — a third spelling of the one name the constant was created
to settle, which is the exact failure it ended (the same fourteen were hardcoded prose in five files
and eleven sites, worded three ways). A module that restates the list reintroduces that drift, and a
fifteenth core dimension would then silently not be scanned. `resolveReviewDimensions` also already
does what the form needs — canonical ordering, unknown-id tolerance, NULL-means-all.

**All three module-owned dimensions stay OUT of the core constant, for three different reasons.**
Coherence, because no change-scoped reviewer can score it (that is the dimension's whole argument,
below): putting it in core would list it on `06-run-config` and in the repo policy where nothing
would ever review it, and 07b's `## Not reviewed` disclosure would then be wrong, since it reports a
dimension as unscored only when it was deliberately excluded. Dead-code, because change-scoped
dead-code detection ALREADY EXISTS outside the fourteen — it is 07b's Step 5, and that step is
additionally allowed to EDIT ("REMOVE dead code immediately") where a dimension only scores — so a
core entry would duplicate a protocol step that is already there and give the same job a second,
weaker home. Comment-debt, because adding a fifteenth core entry re-numbers and re-indents
`numberedDimensionBlock`, which `dimensions.test.ts` asserts byte-for-byte against the original 07b
literal precisely because every install that has not touched the setting still renders it — a prompt
regression for everyone, to serve one module. That last reason binds all three.

**Two of the four missed dimensions carry change-scoped criteria and must be restated** for a
whole-tree read, or the agent is handed a prompt pointing at steps `deep_scan` does not have:
`internationalization` is literally "cross-reference Step 6 findings", and `backward-compatibility`
is "renamed functions/hooks/services have all callers updated (cross-reference Step 4)". Whole-tree
those become, respectively, user-facing strings going through the project's translation layer with
no hardcoded locale/currency/date assumptions, and a public surface that is versioned or additive
with a migration path behind every deprecation and schema change. The other twelve read correctly
as-is. Under a diff target (see Scan targets) the restated criteria apply inside the scope fence,
and `backward-compatibility` gets its original question back — callers and consumers of what the
target renamed or removed, wherever they sit, which the fence already counts as blast radius. Keep
the constant's `id` and `label` either way — they are what `review_findings.raw` carries as
`dimension` and what the dashboard filters on.

Detect seeds a proposed set from the repo's own dimension POLICY (`repositories.review_dimensions`,
NULL = all fourteen) intersected with the onboarding tech inventory (`onboarding/_tech-inventory.ts`)
rather than asking cold — a repo that has already scoped accessibility out of its reviews must not
get it pre-ticked here. `coherence`, `comment-debt` and `dead-code` are not in that policy and seed
on. A seed is a pre-ticked box the user can clear, never a floor. Also on the form: the **target** —
the whole project, one branch's changes, one commit or a range of commits (see Scan targets) — a
path scope (whole repo or subtree) that narrows any target, and a **budget** in agent invocations.

**2 · `scan-analyze`** — `agentMining` fan-out, **one agent per selected dimension over the whole
target** (not per component). Seventeen dimensions is at most seventeen invocations per slice — a
target is one slice unless it is a diff too large for one prompt (see Scan targets) — drained 5 at a
time by `MAX_PARALLEL_AGENTS_PER_TASK`; per-component splitting of a whole-tree read is a later
refinement for a dimension that times out, not v1. Each agent returns structured findings (`path`,
`line`, `severity`, `dimension`, `issue`, `fix`) and carries `REPO_IS_DATA_LINES` from
`steps/_untrusted-repo.ts`.

**One terminal per dimension, and per CLI where several run it — never one per CLI.** A provider's
server-side filter refuses a whole REQUEST, not one dimension inside it: MEASURED on
codex/gpt-5.6-sol, an 08d adversarial-QA seat was refused outright ("This content was flagged for
possible cybersecurity risk", the text `CONTENT_FILTER_RE` in `failure-class.ts` matches). A prompt
carrying security beside the other sixteen, or one terminal per CLI working through all seventeen,
loses every dimension in it to that one refusal; one agent per dimension loses one terminal. So each
agent's prompt asks for exactly one dimension's findings (the seam clauses still NAME a neighbour),
its `agentTitle` is that dimension's `label` (StepTerminal heads each terminal with it), and its
`roleKey` is the dimension's `id`, which makes every dimension a SEAT: per-seat CLI selection
(`STEP_MINING_SEATS`, stored in `user_step_cli_role_preferences`) already runs each seat of a
fan-out on its own provider, so security can run where it is not refused while the rest run
elsewhere. The seat list is derived from the dimension set, never written out by hand — the rule
the dimensions themselves follow — and reaches the seat picker through the module manifest (see
Core changes).

**Separate terminals are necessary, and today not sufficient.** The fan-out barrier fails the WHOLE
step when any agent's row carries a fatal provider headline (`isFatalProviderFailure`, in
`step-runner.ts`'s mining barrier), and `content_filter` became one of those classes on 2026-08-24
(`8f09775d`), four days after the barrier was written (`59b67fe5`), without the barrier being
touched — its comment still names only rate limits, auth and 5xx. So a refused security agent would
fail `scan-analyze` with every other dimension's finished output left unread. That is read from the
code, not observed: no run on the dev install has recorded a content-filter refusal (0 rows,
2026-09-27). The first new core change below makes a refusal a per-agent outcome. With it, apply()
folds every dimension that answered and records a refused one as REFUSED, naming its provider, in
the coverage record — never as a dimension that found nothing — while `miningLossNote` carries it
to the step banner. Recovery then needs nothing new: switch that dimension's seat to another CLI and
use the fan-out Resume, which re-dispatches only the failed terminals, each in the seat its last
dispatch recorded and so on the provider now picked, keeps every dimension that finished, and resets
the steps that consumed the scan, as it does after any degraded fan-out. No refused prompt is
re-sent as it stands: `shouldRetryMiningTerminalFailure` already vetoes that, since the same prompt
is refused the same way.

**REFUSED is only as good as the classifier.** `CONTENT_FILTER_RE` holds the one refusal text
measured so far. Any other CLI's refusal stays unclassified until it is measured and ends as an
ordinary failed agent — never a false pass, but reported as "did not complete" rather than
REFUSED. Measuring each enabled CLI's refusal signal, keyed on a structural field where the CLI has
one (such as the claude family's `terminal_reason` on its result event) rather than on prose, is
part of building this step.

**Reuse the multi-model fan-out here; do not rebuild it.** This step fans out across **dimensions**
(N different prompts, one model each). `purring-marinating-peacock.md` fans out across **models** (one
prompt, N models, then a consolidator merges the drafts). Orthogonal axes, so nothing here duplicates
it — but leaving the cross-model axis out drops where much of the original workflow's value lived: its
four CLIs all answered the SAME question and disagreed usefully. They compose at that plan's **Phase
2b** (agent-mining nested barrier), where each dimension agent becomes a group of M members plus a
consolidator, giving dimension x model. That is already specified there; this module declares the
dependency and builds none of it. In particular it must NOT introduce a consolidator of its own —
`buildConsolidatorPrompt` is generic by design and lives in core. In that composition every member
is its own terminal as well — dimension x CLI, one terminal each — and a member its provider
refuses drops out of its group the way that plan already drops a failed member (its "one member
fails, consolidator runs with survivor" case): the consolidator merges the members that answered,
the coverage record names the member that refused, and the dimension is REFUSED only when every
member was.

**Optional, never a prerequisite.** Phase 2b is that plan's hardest piece and may be deferred, so
`deep_scan` must run correctly single-model. The scope step's budget knob governs the cost: 17
dimensions x 3 members + 17 consolidators is 68 invocations per slice, drained 5 at a time —
fourteen serial batches. Multi-model is opt-in per run, and deselecting dimensions is the other
lever on that number.

**3 · `scan-verify`** — second mining wave via `MiningWaveError`, reusing the three-lens refuter
panel built in `08c-code-review.ts`. **The default inverts here, deliberately.** In `08c` a finding
is kept unless unanimously disproved, because gate 2 auto-approves and a wrong dismissal ships a
vulnerability. A scan report is read by a human and nothing auto-approves, so a false positive costs
attention instead — the plugin's own reasoning, and the reason its verifiers default to
FALSE_POSITIVE on a 2-of-3 quorum. Same machinery, opposite default, and the comment must say why.
A refuter its provider refuses is an unreadable voter and so never counts toward a dismissal, and
the refutation lenses are seats as in `08c` (`refuter:<lens>`), their CLIs chosen per lens like the
analysis seats.

**A consolidator does not make this step redundant**, and the prompt should say so where a reader
might assume otherwise. Consolidation reconciles drafts of one answer; refutation checks a claim
against the code and demands a cited `file:line`. `purring-marinating-peacock`'s own caveat is
explicit — consolidator contradiction-validation is "best-effort model judgement, NOT a correctness
guarantee" — so consolidating three models' findings still yields findings nobody verified.
Consolidate first, refute second, and keep the inverted 2-of-3 default.

**4 · `scan-record`** — deterministic. Dedups survivors by `findingFingerprint` against existing
`review_findings` rows, writes them with `reviewerId = 'deep-scan:<dimension>'` (no core schema
change; the column is `varchar(128)`), and records coverage — the target (its kind, the names
given and the commits they resolved to), which dimensions ran, which were REFUSED and by which
provider, and what the budget truncated, slices of a large target included — reusing the
disclosure convention from `_impl-changes.ts`. It also removes the scan's snapshot (see Scan
targets).

**Deduping decides what is NEW, never what the report covers.** A finding an earlier scan already
recorded is listed as still present, naming the scan that recorded it, not left out: two scans of
overlapping targets — this week's release window and last week's — re-find the same unfixed
defects, and a window report that dropped them would present the window as cleaner than it is. An
earlier scan is another task's: rows this task already wrote, left by an attempt a crash or a Retry
cut short after its transaction committed, are taken as this scan's own rather than as prior
findings, so a re-run never labels its own new findings as still present. Out-of-scope output
under a diff target is recorded with `raw.inScope = false` and listed apart.

**Its rows are the product, so its write is not the telemetry one.** `recordReviewFindings` is
best-effort by design and never throws, because a core reviewer's findings live in its step output
and the table only informs. Here the rows ARE the state: the dashboard reads them, the report's
NEW and still-present verdicts are computed against them, and the next scan dedups on them. So
`scan-record` writes its findings, with the same row shape and fingerprint, in one transaction
whose failure fails the step, and a Retry writes them again. A finding is never in the step's
output without its row.

**It asserts distinct fingerprints within a batch**, because `comment-debt` is the one dimension that
breaks the dedupe every other one survives — see its section below. `recordReviewFindings` writes with
`onConflictDoNothing` against the UNIQUE `review_findings_dedupe_idx`
`(task_id, task_step_id, round, fingerprint)`, so a collision is swallowed with no error and no log. A
collision here is a module bug to surface, not a duplicate to drop. Slices add one case that is not
a collision: each sees the whole target, so two of them can raise the same finding, both sides of
one coherence pair falling in different slices being the obvious one. Findings that share a
fingerprint, a path, lines AND the issue text itself — not its normalized form, which drops
digits and so can join two defects on one line — are that same finding and are recorded once,
before the assertion, keeping the first one's fix; one fingerprint over anything else is still
the collision the assertion exists for.

**5 · `scan-triage`** — form. The human picks which findings to fix. **This step is the entire answer
to "502 tasks, 0 fixes"**: nothing proceeds to remediation that a person did not choose. A coherence
finding asks one extra thing — **which side is authoritative** — because "these two disagree" has no
fix until a person says which one is right. Left unanswered it stays recorded and unplanned rather
than guessed at.

**Volume is the failure mode this step must survive**, and the two accretion dimensions are where it
bites: every file has comments, and a long-lived tree collects unreferenced symbols the same way, so
`comment-debt` and `dead-code` can each reproduce "502 tasks" through triage volume rather than
through a loop, and a form rendering two thousand checkboxes is no answer. The budget at step 1 is
per-invocation and bounds no findings, so the cap is per-dimension and per-file — each reports at most
N findings per file, ranked by span, and the coverage record names what it truncated.

**Remediation lands on a branch, and triage names it where the target did not.** Every target
lands on the branch its `to` was named by, which for a full or branch target is the branch it
scanned; whenever `to` was a tag or a bare SHA, which every ref field accepts, triage asks the
person for the branch, whatever the target kind. The landing branch must contain
the scanned commit (`merge-base --is-ancestor`), or triage offers no remediation for that target
and says why: a fix for code a branch never had is not a remediation. Remediation works on the
landing branch's current tip, which can be ahead of what was scanned, so a finding in a file that
differs between the scanned commit and that tip is marked — its line numbers describe the scanned
revision, not the one a coder will edit. Findings recorded out of scope, and ones an earlier scan
already recorded, are listed apart from the new in-scope ones. A read-only folder import is
mounted read-only end to end, so nothing can remediate it: triage records its findings and offers
no remediation, saying why.

**6 · `scan-plan-remediation`** — deterministic, **no LLM**. Selected findings become DAG rows:
`task_dag_plans` (mode `'dag'`), `task_dag_levels`, `task_dag_issues` (`title` ← issue,
`description` ← issue + fix, `filesModified` ← path, `acceptanceCriteria` ← the fix's check).
**One issue per file**, so several findings in one file are fixed by one agent — which removes
intra-file merge conflicts by construction rather than predicting collisions the way the archive's
planner did. A coherence finding names TWO files and so breaks that rule as stated: group by the
**connected component** of the paths a finding names, not by a single path, or two issues could each
claim one side of the same conflict and reintroduce exactly the collision the rule exists to prevent.
Every other dimension names one path, where connected components degenerate to one-issue-per-file —
so this changes nothing for the other sixteen, `comment-debt` and `dead-code` included: each of their
findings names one path, and several such findings in a file being fixed by one agent is the right
unit anyway. All at level 0 unless a dependency is declared. Every issue names the commit its
findings were read at, so a coder working on a newer tip knows which revision their line numbers
describe.

One cheap post-check falls out of that: when every finding in an issue is `comment-debt`, the
remediation diff must touch **comment lines only** — a mechanical assertion no other dimension can
make. It is available only when the issue is single-dimension, which one-issue-per-file does not
guarantee, so it is a bonus gate and must not be turned into a requirement by making the grouping rule
dimension-aware.

**7 · `scan-remediate`** — declares the `dagExecute` hook and supplies a fix-oriented coder prompt.
**Reusing the executor needs no core change:** `resolveDagPhase`
(`step-engine/dag-executor.ts:1505`) loads its plan by `taskDagPlans.taskId`, not from `06b`, so the
module inherits per-level isolated worktrees, parallel coders, the barrier, level-by-level merge,
checkpointing and crash recovery wholesale. This is the single largest piece of reuse in the plan.
Those worktrees branch from `01-worktree-setup`'s integration worktree, so `00a-sync-base` and
`01-worktree-setup` are composed ahead of this step, and the landing branch has to reach them:
left alone, 00a's detect defaults `base` to the branch the checkout is on and auto-continue
submits it, so a scan of branch B from a checkout on A would remediate, and merge, into A.
`scan-triage` therefore pre-answers 00a's `base` with the landing branch through
`tasks.pre_answers`, the map `06-run-config` pre-answers later steps with (merged into it, never
written over it, since 06 writes the whole map), and `scan-remediate` dispatches no coder until
three things hold, each checked with `merge-base --is-ancestor` in the scratch repository, which
sees every commit involved: the integration worktree's own HEAD contains the scanned commit; the
landing branch, re-resolved at its source just before dispatch, still contains it; and HEAD
contains that re-resolved tip. A matching branch name proves nothing: 00a carries on with the old
local branch when its fast-forward fails, a force-push makes exactly that happen while the old
tip still holds the scanned commit, and in manual mode a pre-answer is only a default a person can
change. Work built on a tip the source has moved away from is work its push cannot land. A check
that cannot be answered, a history too shallow to connect the commits, refuses rather than
guesses.

**One thing it inherits must change.** The DAG's fail-fast guard (`pickFatalProviderError`) cancels
every in-flight sibling coder when one coder's run carries a fatal provider headline, and a security
fix the provider's filter refuses carries one, so one refused issue would stop its whole level.
Taking the guard away alone would send that issue to the advisor instead, which can re-send the
refused content. The first new core change covers both; the refused issue's findings stay recorded
as not remediated, naming the refusal.

**8 ·** Core steps composed from the catalog after remediation — verify, review, commit — exactly as
a workflow task ends. Several of them emit `loop_back`, and the data-driven task types
(`rippling-wibbling-puffin`) refuse a composition whose loop emitters have no declared
`fixLoop.targetStepId` in its run list. `scan-remediate` cannot be that target: once its levels
are checkpointed their issue worktrees are gone and `resolveDagPhase` resolves without dispatching
anything, the reason core does not point its own fix loop at `06c-dag-execute`. Nor can core's
`07-phase-2-implement`: its round-0 skip keys on `06b-sprint-planning`'s DAG mode, which
`deep_scan` never records, so it would also run at round 0 and implement the task's own
description as a brief. So the module ships **`scan-fix`**, composed between `scan-remediate` and
the tail and declared as the seed's `fixLoop.targetStepId`. It skips round 0, which
`scan-remediate` owns — the split core makes between `06c-dag-execute` and 07 in DAG mode — and in
each fix round reads the diagnosis (`loadFixLoopDiagnosis`) and edits `01-worktree-setup`'s
integration worktree under `REPO_IS_DATA_ACTING_LINES`, the guard for a pass that edits.

### Scan targets

The form offers four targets, each resolving to the COMMIT the scan reads and, for three of them,
the BASE it diffs against. On the form they are one radio whose options each reveal only their own
ref fields (`visibleWhen`, which also exempts a hidden field from validation), and every ref field
is a picker that takes a typed SHA too (`select-with-text`). The default is the whole project on
the default branch, the scan this plan described before it had targets.

- **Full project** — the whole tree at one branch's tip: the default branch, or any other, which is
  how "all of branch X" is asked for. No base; every file is in scope.
- **Branch** — what branch B changed since it forked from A (the default branch unless another is
  picked): base `merge-base(A, B)`, read at B's tip. The fork point rather than A's tip, because A
  has usually moved on, and a diff against its tip counts A's later work, reversed, as B's.
- **Commit** — what one commit changed: base its FIRST parent, read at the commit. A merge commit
  is what the merge brought in; a root commit diffs against the empty tree.
- **Range** — what `from..to` changed: base `merge-base(from, to)`, read at `to`. The release
  window is this case — `from` the last release tag, `to` the release branch — and the merge-base
  keeps a `from` on another line of history from showing up as its own changes, reversed.

**Names are checked before git sees them, and resolved once.** Every ref the person gave is
validated in code before any git command runs — refused when it starts with `-` or breaks git's
own ref-name rules, and a SHA must be hex — and every git command, the fetch below included, takes
it only after `--end-of-options`, inside a refspec Haive builds from the checked name. The fetch
runs before resolution, so a check made only there would come too late: `git fetch` reads an
option-shaped refspec as an option, and some of its options name a command to run. `scan-scope`'s
apply then resolves each name to a full commit SHA with `rev-parse --verify`, peeled with
`^{commit}` so a tag of a tree or blob is refused, and records the names beside the SHAs. Every
later step reads the SHAs: a branch that moves mid-run must not change what the verify wave reads
or what the report says was scanned. Prompts name the target by SHA and ref name only, never by
commit message, which is repository-authored prose.

**The scan's git runs in a repository Haive owns, and history is fetched there within a bound.**
Every git command the scan runs works in a scratch bare repository beside the snapshot, whose
config Haive writes, with system and global config off (`GIT_CONFIG_NOSYSTEM`,
`GIT_CONFIG_GLOBAL=/dev/null`); the clone's object store is borrowed through
`objects/info/alternates`, so nothing already on disk is downloaded again, and the repository's
own `.git/config` is never read. That config is not Haive's to trust — a folder import's is the
person's, and a clone's can be written by an agent that had the root mounted — and a denylist of
the keys that make git run something (`remote.*.uploadpack`, `core.sshCommand`,
`credential.helper`, `diff.external`, `core.fsmonitor`, hooks) is never complete. The scratch
repository fetches from the source Haive records rather than from a remote that config names: the
stored remote URL with Haive's credential helper, the host folder of a writable folder import
(the source `repo/refresh.ts` already picks), or the person's own clone for a read-only folder
import, which is read and never written; a repository with no remote is read from its own storage
the same way. A clone is `git clone --depth 1` (`repo/clone.ts`), which is also single-branch, so
another branch, a tag, an older commit or a fork point is usually not on disk. The pickers list
`git ls-remote --heads --tags` against the source, since a clone's local refs would show one
branch, and a listing that fails leaves the fields free-text rather than blocking the form. Before
resolving, apply fetches each ref the target names at `--depth=1`, which marks the scratch
repository shallow with a boundary of its own: the alternates carry the clone's objects but not
its `.git/shallow`, a repository not marked shallow cannot be deepened, and a first fetch with no
depth can pull a whole history. It then deepens in bounded steps until the base is present —
`00a-sync-base`'s rule, never `--unshallow`, since a full history can be huge. A target whose base
is not reached within the bound is refused, naming the depth reached, and so is one whose walk
still meets a missing object, naming the object; neither is ever scanned as the shorter window
that did arrive. Fetching a bare SHA depends on the host allowing it and is UNMEASURED; a SHA
reachable from a ref the target names needs no such allowance. A missing ref is refused by name.

**The code read is the target's own commit, always from a snapshot.** Every target, a full one on
the commit the root has checked out included, reads a SNAPSHOT of its commit: a directory in the
task's scratch workspace (`repo/scratch-workspace.ts`, the one a repository-less task already
works in). Every scan and verify agent is mounted on it alone and read-only, since the verify wave
must read the bytes the analysis read, and the invocation mount has to honour that ahead of its
read-only-folder branch, which returns first today (see Core changes). Reading the root instead
would scan its uncommitted bytes under a commit SHA that does not hold them: triage's
changed-since-scan check compares commits and would call such a finding unchanged, while the coder,
cut from the committed tip, could not see what it describes. The coverage record names the tracked
files the root had changed, since the scan did not read them. A step that reads the snapshot
re-creates it at the recorded commit when it is gone, so a Resume or Retry after `scan-record`
removed it reads the same revision, and completing or cancelling the task reaps it with the scratch
workspace (see Core changes). The price is a second copy of the tree for as long as the scan runs.

**The snapshot holds exactly the bytes the commit stores, and nothing it writes lands outside it.**
It is written from the object store (`ls-tree -r -z` and `cat-file --batch`, which read no
attributes and run no filter), never checked out: a checkout falls back to the live checkout's
`.gitattributes` where the target has none and runs whatever smudge filter the repository's config
names, so its bytes need not be the commit's — the rule `captureFixBaseline` keeps by reading
`.gitattributes` from the empty tree — and a git worktree would also write admin files into the
repository's `.git`, which for a read-only folder import is the person's own. Every git command the
scan runs, resolution and the diff included, sets `GIT_NO_REPLACE_OBJECTS=1`, since a
`refs/replace/` entry, which a folder import can carry, would otherwise have `ls-tree` and
`cat-file` read another commit's tree under the SHA the report names. A tree object can hold names
no checkout would write, so every path is held to git's own checkout rule
(`verify_path`: no empty, `.` or `..` component, and no `.git`) and a tree that breaks it refuses
the target with the path named; each file is then written through `@haive/shared/fs-safe` from the
snapshot's anchor, never by a path-based call, and keeps the executable bit its tree entry records
(`100755`), since a change of mode alone is a change the line notes list. A symlink whose target
stays inside the snapshot is recreated as a link, after every file, so nothing is written through
it; one that points outside — absolute, or climbing past the root — is not recreated, and is named
with its target in the coverage record and in the prompt of every agent whose scope holds it, so an
agent sees an escaping link rather than a file that reads as text. A submodule is named in the
coverage record as not scanned.

A snapshot holds committed files only, the view every worktree run has. Rules and KB that exist
only uncommitted at the root — onboarding's commit is off by default — reach its agents the way
they reach any worktree run: the provider's effective rules in every prompt (`withAgentRules`) and
the KB through `rag_search`. That index describes the checkout it was built from, not the snapshot,
so a hit is a pointer to open in the snapshot and never evidence; grounding on disk is already
mandatory (`_retrieval-guidance.ts`). The coverage record says which rules and KB the scan read.

**A diff target scopes every dimension by LINES, with the fence core already uses.** The changed
lines come from `git diff --unified=0 --no-ext-diff --no-textconv <base> <to>`, run in the scratch
repository with `GIT_ATTR_SOURCE` pinned to the empty tree as `captureFixBaseline` pins it, so no
attribute from any source — a committed `.gitattributes`, `info/attributes`, a
`core.attributesFile` — can mark a changed text file binary and drop its hunks; the notes then
number the bytes the snapshot holds. They are read through `parseChangedLineRanges`, the parser and
the `+`-side numbering a task's own review scope uses, and reach agents through
`changedFilesBlock`. `SCOPE_BOUNDARY` (`_scope-fence.ts`) then applies as written: the lines the
target wrote, the function or block each sits in, and blast radius. It gets exported for this.
The two dispositions exported today (`SCOPE_FENCE_INSIGHTS`, `SCOPE_FENCE_IN_SCOPE_FLAG`) are not
reused, because their closing lines are about sending a change back to be reimplemented, which a
scan never does. The scan writes its own and keeps core's split — the security dimension reports
everything and marks `in_scope`, the others put out-of-scope observations under `## INSIGHTS` —
and `scan-record` keeps that output apart rather than dropping it. A path scope narrows a diff
target to the changed files under its subtree. A target with nothing to scan — a branch with no
commits of its own, an empty range, a subtree holding no changed file — is refused at
`scan-scope`, for the reason `assertReviewableChange` gives: a scan of nothing renders exactly like
a clean one. The three module-owned dimensions each add a rule of their own, in their sections
below.

**A diff target also carries what it removed.** The sandbox has no git and the snapshot holds
only the target's side, so a rename, a deleted function or a removed call would leave nothing to
read — and `backward-compatibility` and `dead-code` exist to ask about exactly those. The snapshot
therefore gets a second tree, written the same way, holding the base-side version of every file
the target changed or deleted and nothing else, and each file's line note also names the lines
the target removed, numbered as in that copy (the hunk headers' `-` side, which
`parseChangedLineRanges` skips today). That tree is bound read-only at a path OUTSIDE the workdir,
through the bind `resolveTaskUploadsMount` uses for a task's uploads, so a reference search or a
language server started in the workdir never counts the base copy as a caller. None of its text
enters a prompt: it is repository content read off disk under the same `REPO_IS_DATA_LINES` guard
as the rest.

**A large diff target is sliced, never truncated.** A task's review caps its list at 100 files and
discloses the rest as unseen (`changedFilesBlock`'s COVERAGE notice); a scan exists to cover its
target, so a diff over that cap is cut into slices of at most 100 files, contiguous in path order so
a directory stays together, and each dimension runs one agent per slice — still one dimension per
terminal, each agent told it holds one slice, so it leaves another slice's files to that slice.
The same holds inside a file: `parseChangedLineRanges` keeps 20 ranges per file and reduces the
rest to `(+N more ranges)`, which the fence would read as out of scope, so the scan parses without
that cap, and a file whose ranges would still overrun the prompt is listed with no note, which the
fence reads as all of it in scope. No slice is truncated, so the notice never renders; what the
budget cuts is recorded instead. A release window of several hundred files is the case this
exists for.

### The coherence dimension

The other sixteen each ask a question about code in one place. This one asks **"do two parts of this
project contradict each other"**. A rule, a KB page, a doc, a code comment and the code itself all
state intent, and when two of them state OPPOSITE intent every agent that reads them afterwards is
miscalibrated — silently, and in a direction nobody chose. The shape to detect: one place says always
write expanded prose comments, another says never write them, keep comments terse except for named
exceptions. Neither is a defect alone; together they are, and **no change-scoped reviewer can ever see
it**, because the two sides were not touched by one task and `SCOPE_BOUNDARY` correctly excludes the
one that was not.

Not hypothetical in Haive itself: `2fffb947` added a comment-volume rule by hand and had to carve out
the comments other rules DEMAND, so that the rules would not contradict each other. Nothing detected
that — a person noticed.

That example sits at the seam with `comment-debt`, and the two must not both claim it: **coherence owns
rule-vs-rule and doc-vs-doc**, `comment-debt` owns comment-vs-code and comment-vs-nothing. Say so in
both prompts, or each will raise the other's shape.

Its reading set is wider than code: `.haive-data/knowledge_base/` and `.haive-data/learnings/`
(`KB_DIR`/`LEARNINGS_DIR` in `shared/src/knowledge-paths.ts`), the installed agent rules and
`AGENTS.md`/`CLAUDE.md`, `.claude/skills/` and commands, `README`/`docs/`, and code comments against
the code they sit on. Four directions, and the prompt names all four: doc vs doc, doc vs code, comment
vs code, and code vs code (two modules implementing one contract incompatibly). **Subtree scope
narrows the code side only** — the rules and KB a subtree must agree with live at the repo root, so
those stay in its reading set whatever the scope. A diff target narrows it the same way and one step
further: a conflict is raised only when at least ONE side lies in the lines the target wrote, the
other side anywhere — which is what a release window asks of this dimension, whether the new work
contradicts what the project already says.

Four things this dimension must get right, none of which the core fourteen need (`comment-debt`
needs its own analogue of the second and the fourth, and `dead-code` its own analogue of the second —
see their sections):

- **A finding is a PAIR, not a location.** It cites both sides as `file:line` and quotes the
  incompatible text from each. Without the second side it is neither refutable nor fixable, and a
  reviewer that reports only "the comment rules are inconsistent" has reported nothing actionable.
- **A stated carve-out is not a contradiction.** A rule that names its exceptions, a doc that says
  "except in X", a deliberate divergence with a written reason — those COMPLEMENT. The prompt must
  require checking both sides for such a carve-out before raising. Without that clause the dimension
  flags every rule that has an exception list, which is most of the good ones.
- **Refutation asks a different question.** `scan-verify`'s lens here is not "does this defect exist
  in the code" but "do both quoted texts still say this, and does either state an exception that
  covers the other". Same panel, same inverted 2-of-3 default, different check — and the prompt must
  say so, or the refuters will look for a code defect and find none.
- **Deduping needs a canonical side.** `findingFingerprint` hashes `(reviewerId, path, issue)`, so
  the same conflict reported with its sides swapped hashes differently and a re-scan calls it new.
  The pair is ordered lexicographically by path, the lower becomes `path`, and the other side rides
  `review_findings.raw` — which exists for exactly this ("fields this table does not model"), so the
  no-core-schema-change claim above still holds.

### The comment-debt dimension

Three surfaces already bound comments, and all three are **preventive and change-scoped**:
`DEFAULT_AGENT_RULES`' "Comment sparingly" bullet (`2fffb947`), which binds what an implementing
agent writes; `07a-code-simplify`'s vendored simplifier bullet ("Keeping any comment worth writing
short"), scoped by `collectImplementationFiles` like every reviewing step; and `07b`'s
`developer-experience` lens, whose criteria already say "comments only where non-obvious". Nothing
reads the WHOLE TREE for comments that are already there — written before those rules landed, by a
human, or by another tool. That is the same gap shape as coherence, and the same argument puts the
answer in this module.

The debt has one dominant shape worth naming, because it is what the rule was written against and
what an LLM produces by default: **git history narrated into the code**. A commit message duplicated
above the line it changed, a paragraph explaining what the previous version did and why it was
replaced, a "changed X to Y because Z" block that the log already carries. It clutters the file, ages
badly (the code moves, the story does not), and is read by every agent afterwards as though it were
current intent.

**Its overlap with `developer-experience` is real and is split by ACTION, not ignored.** `deep_scan`
runs DE over the whole tree too, and DE's clause raises the same line. So DE keeps the question
"should this comment exist at all", and `comment-debt` owns the REWRITE — long prose down to one or
two lines, and the delete-vs-compact call. Both raising one line costs triage noise only:
one-issue-per-file already folds them into a single DAG issue. Say so in both prompts, or each will
assume the other covered it.

**The policy is the REPO's rules, never a constant in this module.** Scanning Haive with a fixed
style would flag exactly the comments Haive's own rules DEMAND: `dimensions.ts` opens with an 18-line
header that exists because a person had to record why fourteen names were consolidated, and
`AGENTS.md` requires a measured finding to be written where it is relied on, a shortcut to carry its
ceiling and upgrade path, and a volatile value to be marked as such. `2fffb947` carved those out of
the rule by hand for this exact reason. So the agent's policy input is the repo's own effective rules
(`resolveEffectiveRules` / `DEFAULT_AGENT_RULES`, `shared/src/templates/cli-rules.ts`),
`AGENTS.md`/`CLAUDE.md`, and the conventions visible in the tree — and it judges against THOSE,
falling back to the shipped default only when a repo states nothing, and naming in the coverage record
which it used. A module that ships its own comment style imposes a house style on a paying customer's
codebase, which is not the product.

**Removal carries a higher bar than compaction.** A comment recording a measurement, a constraint, a
workaround, or a carve-out another rule requires is the only place that fact lives AT THE POINT OF
USE — the git log is not the reader's index and no agent greps it. So a finding proposes one of three
verdicts and must say which:

- **delete** — the comment restates the code: narration of the next line, a signature echoed in
  prose, a section banner, a commented-out block. Burden of proof is on delete, and "the code is
  clear" must be shown against the code, not asserted.
- **compact** — a real why buried in prose, or history that should have been a commit message. One or
  two lines out, the rest gone. The finding carries the replacement text; without it, triage is asking
  a person to approve a deletion they cannot picture.
- **keep** — not raised at all.

Delete is opt-in on the scope form; the default is compact-only.

**Under a diff target** the fence decides, as it does for the fourteen: comments on lines the target
wrote, and any comment inside a function or block the target changed — a comment the change left
describing code it rewrote is exactly the stale kind this dimension exists for. A comment the target
never came near is out of scope.

**It breaks the fingerprint dedupe that every other dimension survives.** `findingFingerprint` hashes
`(reviewerId, path, issue-with-digits-stripped)` and `review_findings_dedupe_idx` is UNIQUE on
`(task_id, task_step_id, round, fingerprint)`, with every writer using `onConflictDoNothing`. Other
dimensions are safe because two defects in one file are described in different sentences. Comment
findings are **templated by nature** — "comment narrates the line below" reads identically for every
instance — and the line number that would separate them is the one thing the normaliser strips. Three
such findings in one file collapse to one, with no error, no log, and nothing downstream able to tell.
The fix is the device coherence uses for its pair, for both of its reasons at once: `issue` carries
the offending comment's own opening text verbatim, which makes the finding unique AND refutable.

### The dead-code dimension

Dead code is the one gap the codebase names out loud and then declines to close. `07b`'s Step 5 is
**"Dead code detection (SCOPED TO MODIFIED FILES ONLY - do not scan the whole codebase)"**, and its
own wording says what it hunts: "unused functions/code left behind by refactoring". The other half is
`DEFAULT_AGENT_RULES`' surgical-changes bullet — "do not delete pre-existing dead code unless asked,
mention it instead" — so an agent that SEES dead code outside its change is told to leave it and say
so, and nothing anywhere collects the mentions. Both rules are right for a change-scoped task, and
together they guarantee accretion: every refactor Haive itself runs can orphan a symbol its own
reviewer is forbidden to touch. Same gap shape as coherence and comment-debt, same argument, same
answer.

**Its own remediation is a refactor, so it seeds the next scan.** Deleting an unreferenced function
can leave that function's only helper unreferenced in turn, and one pass sees the tree as it was.
That cascade is deliberately not chased within a run: a re-scan reports what is new (see Convergence),
which is already the mechanism, and a within-run fixpoint is the archive's loop under another name.

Three things this dimension must get right:

- **Zero static references is EVIDENCE, not a verdict.** The dominant false-positive class is code
  reached by something other than a call site: framework hooks matched by NAME (`hook_form_alter`, a
  Rails callback), routes, services and event subscribers declared in config or annotations, DI
  containers, template-resolved functions, anything reached through a computed or interpolated name,
  a public surface consumed outside this repo, test-only helpers, and method overrides — in this
  repository `cliAdapterRegistry.get()` hands out a `BaseCliAdapter`, so every caller invokes the
  base type and a find-references on `ZaiAdapter.effortEnv` lands on nothing. A legacy Drupal tree
  is mostly the first of those. So a finding must state HOW it established there is no caller —
  find-references where the tooling offers it, a grep for the bare symbol name otherwise, and an
  explicit look at the project's config, annotations and naming conventions — and the refutation
  lens is "does ANY reference exist, including a dynamic, configured or convention-matched one", not
  "is this code wrong". Same panel, same inverted 2-of-3 default, different question, and the prompt
  must say so. **Subtree scope narrows where findings are RAISED, never where references are
  SEARCHED**: a symbol unreferenced inside a subtree is routinely called from outside it, so a scan
  that searches only the subtree reports every one of its exports as dead. A diff target narrows the
  same way, plus the case that makes a change worth scanning for this dimension: a pre-existing
  symbol whose LAST reference the target removed is raised though none of its own lines changed. It
  is the target's blast radius, and exactly the "unused functions/code left behind by refactoring"
  07b's Step 5 hunts.
- **The verdict set is remove or keep — there is no compaction.** Unlike `comment-debt` there is no
  middle verdict to default to, so removal gets no opt-in of its own on the scope form; the human
  gate is `scan-triage`, which is where every deletion is chosen anyway. What the finding carries
  instead is the BLAST RADIUS — the symbol, its span, and what becomes unreferenced once it goes —
  because approving a deletion whose consequences are not on the form is the one thing triage cannot
  do well.
- **It breaks the fingerprint dedupe the same way `comment-debt` does, and takes the same fix.**
  "unused function, zero references" is templated by nature, and `findingFingerprint` strips exactly
  the line numbers that would separate two instances in one file. `issue` carries the SYMBOL NAME
  verbatim, which makes the finding unique AND refutable at once.

**Its seam with `comment-debt` is commented-out code**, which 07b's Step 5 counts as dead code and
this module's `delete` verdict counts as a comment. **`comment-debt` owns it**: it is a comment, its
removal is already that dimension's verdict, and routing it here would put it behind a
static-reference check that means nothing for text no parser ever sees. `dead-code` owns live,
parsed, unreferenced code. Say so in both prompts, as with the other two seams.

### Convergence

There is none of the archive's kind. The run is bounded by **the budget chosen at step 1**, and
repeat scans dedup against recorded findings, so a second run reports what is *new* — and lists what
it re-found as still present rather than dropping it (see `scan-record`). No agent is ever penalised
for finding nothing. If a "keep going until dry" mode is ever added it must key on *no new findings
after verification*, never on empty output, and still stop at the budget.

## Core changes this needs (small, and in Haive rather than the module)

Two are already written into the two modularity plans (`5aa4704`):

- Module `composableSteps` union into `composable_step_catalog`, namespaced `module.<id>.<stepId>`.
- Module-seeded task-type definitions, and the dangling-reference rule when a module is removed.

Four more follow from how the scan runs. The first stands on its own and can ship ahead of the
module:

- **A provider's content-filter refusal is a per-agent outcome, not a dead provider.** The fan-out
  barrier's fail-fast (`step-runner.ts`) and the DAG's `pickFatalProviderError` both key on
  `isFatalProviderFailure`, which counts `content_filter`. Both were written for providers that stop
  answering — rate limits, auth, 5xx — where every further call hits the same wall, so failing the
  step, and in the DAG cancelling in-flight siblings, is right. A refusal concerns ONE prompt: its
  siblings' prompts are not refused by it, and waiting changes nothing. Exclude `content_filter` at
  those two sites. A refused mining agent then degrades like any failed agent, its refusal named in
  `miningLossNote`. A refused DAG coder needs a third change: with the guard out of the way,
  `classifyDagIssueFailure` (`dag-failure-class.ts`) calls a failure that was neither killed nor
  environmental `genuine` and hands it to the advisor, whose `RETRY_APPROACH`/`RETRY_MODIFIED`
  would re-send the refused content to the provider that refused it. Its issue ends
  `failed_unrecoverable` with a refusal marker in `concerns`, the way `DAG_INFRA_EXHAUSTED_MARKER`
  records an exhausted re-dispatch, and escalation and the level's failure rule both read that
  marker: no advisor is dispatched for the issue, and it does not fail the level its siblings
  finish. No new `dag_issue_outcome` value, since Postgres cannot drop one once added. Core's own
  fan-outs change with it: a refused `08c` or `08d` seat — 08d's is where the refusal was
  measured — fails the whole step today, and afterwards yields the synthetic "did not complete"
  finding both steps already report for a dead agent (`didNotCompleteIssue`), so its silence is
  still never read as approval.
- **A mining dispatch can mount a snapshot, and its row keeps it.** `AgentMiningDispatch` names
  the snapshot its agent is mounted on, and for a diff target the base tree bound beside it, and
  both join the requirements a mining row records (`dispatchRequirements` and
  `recordedRequirements` in `step-runner.ts`, today `roleKey`, `capabilities` and `preferVision`)
  as new `task_step_agent_minings` columns: a reserved agent a dead worker never sent, and a wave
  agent `selectAgents` never authored, are replayed from the row alone, and without them a
  recovered `scan-verify` refuter would mount the repository and check the wrong revision.
  `resolveInvocationRepoMount` honours the snapshot ahead of both repository branches — the
  read-only-folder one returns before it reads even the `worktreeRel` override DAG coders use — so
  a read-only folder import is scanned from its snapshot, never from the person's live checkout.
  The mount is marked as a committed snapshot, and secret masking treats every file in it as
  tracked, since each one is: `filterUntracked` (`secret-mask.ts`) reads a directory with no
  `.git` as all untracked and masks more, which would hide from the security dimension exactly
  the committed `.env` files and keys it exists to find. Such a finding names the file, the line
  and the kind of credential and never its value, the contract `07_7-secret-sweep` already
  reports under.
- **A module declares its fan-out seats.** `STEP_MINING_SEATS` (`@haive/shared`) is a constant the
  api reads by step id to hand the web its per-seat CLI picker, so a module step's seats reach
  neither. The module manifest carries them, derived from the module's dimension set, and the api
  reads them beside core's constant.
- **The scratch reaper takes a scan's snapshot too.** `cleanupTaskScratchWorkspace`
  (`repo/scratch-workspace.ts`) already runs when a task completes and when it is cancelled, and
  the boot sweep catches what those miss, but it reaps only a repository-less task type's
  workspace, and a cancel runs no step code that could remove the snapshot itself. Widen it to a
  repository task's scratch workspace, keeping its settled-or-cancelled and no-pending-recap
  guards, so a failed scan keeps its snapshot for the Retry as a failed task keeps its Editor.

One rule to state in the module system's docs while building this: a module may **write core rows**
through `ctx.db` (`review_findings`, `task_dag_*`, and `tasks.pre_answers` for the landing branch —
those are the intended extension points) but must **not add core tables**; its own schema goes in
its own database via `ensure-schema`. The existing cross-cutting rule says the latter but not the
former, and this module does both kinds of write.

## Critical files (reference, not modification)

- Dimension taxonomy to IMPORT (the one exception: this is used, not just read):
  `packages/shared/src/review/dimensions.ts`, and the repo/task policy in
  `step-engine/review-dimension-context.ts`
- Fan-out + refuter panel to copy: `steps/workflow/08c-code-review.ts`
- Whole-tree step precedent: `steps/onboarding/07_7-secret-sweep.ts`
- Change-scoped dead-code detection that `dead-code` extends whole-tree:
  `steps/workflow/07b-phase-4-validate.ts`, Step 5 and the Step 4 refactoring-impact check
- Findings persistence + fingerprint: `steps/workflow/_review-findings.ts` (its writer is
  best-effort by design, which is why `scan-record` writes strictly)
- DAG rows + executor: `packages/database/src/schema/task-dag.ts`, `step-engine/dag-executor.ts`
- Untrusted-tree clause: `steps/_untrusted-repo.ts`
- Comment policy `comment-debt` judges against: `packages/shared/src/constants/default-agent-rules.ts`
  and `resolveEffectiveRules` in `packages/shared/src/templates/cli-rules.ts`
- Coverage disclosure convention, and the changed-line measurement a diff target reuses
  (`parseChangedLineRanges`, `changedFilesBlock`): `steps/workflow/_impl-changes.ts`
- Scope fence (`SCOPE_BOUNDARY`, exported for this): `steps/_scope-fence.ts`
- Per-seat CLI selection, which each dimension becomes: `STEP_MINING_SEATS` in
  `packages/shared/src/step-engine/types.ts`, `AgentMiningDispatch.roleKey` in
  `step-engine/step-definition.ts`
- Refusal classification, the three sites the first new core change edits, and the retry veto:
  `queues/cli-exec/failure-class.ts`, the mining barrier in `step-engine/step-runner.ts`,
  `pickFatalProviderError` in `step-engine/dag-executor.ts`, `classifyDagIssueFailure` and the
  `DAG_INFRA_EXHAUSTED_MARKER` precedent in `step-engine/dag-failure-class.ts`, the
  `dag_issue_outcome` enum in `packages/database/src/schema/task-dag.ts`,
  `step-engine/mining-failure.ts`
- The fix loop `scan-fix` is the target of: `loadFixLoopDiagnosis` and `FIX_LOOP_TARGET_STEP_ID`
  in `steps/workflow/_fix-loop.ts`, 07's round split in `steps/workflow/07-phase-2-implement.ts`,
  and the per-type `fixLoop` block in `rippling-wibbling-puffin.md`
- Fan-out Resume, which re-runs only the failed terminals: `packages/api/src/routes/tasks/steps.ts`
- Shallow clone, the fetch source and the bounded-deepen rule: `repo/clone.ts`, `repo/refresh.ts`,
  `steps/workflow/00a-sync-base.ts`
- The snapshot's home, its writer's primitives and its reaper: `repo/scratch-workspace.ts` and
  `@haive/shared/fs-safe`; the invocation mounts it overrides and extends:
  `resolveInvocationRepoMount` (`queues/cli-exec/resolvers.ts`) and `resolveTaskUploadsMount`
  (`queues/cli-exec/exec-core.ts`); the requirements a mining row records:
  `dispatchRequirements`/`recordedRequirements` in `step-engine/step-runner.ts` and the
  `task_step_agent_minings` table in `packages/database/src/schema/tasks.ts`
- Pre-answering a later step's form: the `tasks.pre_answers` writer in
  `steps/workflow/06-run-config.ts`, the runner's `overlayPreAnswerDefaults`, and 00a's `base`
  field in `steps/workflow/00a-sync-base.ts`
- Conditional form fields: `visibleWhen` in `packages/shared/src/schemas/form.ts`
- A commit's stored bytes with no attribute or filter applied, the rule the merge snapshots keep:
  `captureFixBaseline` in `step-engine/git-merge.ts`

## Verification

**Unit (in the module's own suite):**
- Dimension selection produces exactly the expected agent fan-out, and an empty selection dispatches
  nothing rather than defaulting to all seventeen. No dimension survives being deselected.
- The fan-out set equals `REVIEW_DIMENSIONS` plus `coherence`, `comment-debt` and `dead-code` —
  asserted against the imported constant, not a literal, so a dimension added to core fails this test
  until the module handles it. No count is hardcoded anywhere but prose.
- The verifier tally: 2-of-3 dismisses (inverted from `08c`), and an unreadable voter does not.
- `scan-plan-remediation` puts two findings in one file into ONE issue, and two files into two.
- Findings already recorded are deduped on a re-scan; a repeat run reports only what is new, and a
  coherence pair reported with its two sides swapped fingerprints identically.
- Coherence raises a pair with both sides cited, and does NOT raise when one side states a carve-out
  naming the other.
- A coherence finding across two files becomes ONE DAG issue owning both, and a separate finding in
  either of those files joins that same issue rather than opening a second one.
- Two comment findings in ONE file, with the templated issue text, produce TWO rows — the regression
  test for the fingerprint collision. Mutation-check it by dropping the quoted comment text from
  `issue` and confirming the second row disappears.
- A comment the repo's own rules DEMAND is not raised: a constant marked volatile, a shortcut's
  ceiling, a recorded measurement. Run it against this repository's `dimensions.ts` header and
  `07a-code-simplify.ts`'s provenance comment, both of which must survive.
- A comment restating the line below is raised as `delete`; a history paragraph is raised as `compact`
  with replacement text; with delete not opted in, no finding carries a delete verdict.
- A symbol with zero static references but a non-call-site consumer is NOT raised: fixtures for a
  name-matched framework hook, a service declared in config, and a method override. Run the last
  against this repository's own `cli-adapters/`, where every `override` in `zai.ts` is reached only
  through the `BaseCliAdapter` that `registry.ts` hands out and all of them must survive.
- Two dead-code findings in ONE file produce TWO rows — the same fingerprint regression as
  `comment-debt`, mutation-checked by dropping the symbol name from `issue`.
- With scope set to a subtree, a symbol referenced only from OUTSIDE that subtree is not raised, and a
  dead-code finding carries the blast radius of its removal.
- The per-file cap: the coverage record names the file and the count it truncated.
- Each selected dimension dispatches as its own agent in its own seat (`roleKey` = the dimension's
  `id`, `agentTitle` = its `label`), and no dispatch asks for two dimensions' findings — asserted on
  the output contract each prompt carries, since the seam clauses rightly NAME the neighbouring
  dimension. A diff target over 100 files dispatches one agent per dimension per slice, and no
  slice is truncated.
- A dimension whose agent was refused (its row carrying the content-filter headline) is recorded
  REFUSED with its provider while apply() folds the others; an unclassified failure is recorded as
  did-not-complete, never as REFUSED and never as a clean dimension.
- Target resolution over a fixture repository holding a root commit, a merge and two branches:
  branch → merge-base, commit → first parent (root commit → empty tree), range → merge-base of
  `from` and `to`. A ref starting with `-` is refused before any git command runs, the fetch
  included, and every git argv carries a person's ref only after `--end-of-options`; a tag naming
  a tree is refused before any diff runs; a branch with no commits of its own, an empty range and
  a subtree holding no changed file each refuse at `scan-scope`.
- Moving a branch after `scan-scope` changes nothing `scan-analyze`, `scan-verify` or the report
  reads.
- A full target on the root's own commit reads the snapshot, not the root: a tracked file edited
  at the root is named in the coverage record, and its edit is never scanned.
- A shallow fixture whose range base lies past the deepen bound is refused naming the depth reached,
  never scanned as the part that was fetched.
- The scratch repository's first fetch of a ref is `--depth=1`, so it holds a shallow boundary of
  its own and deepens from there beside a `--depth 1` clone lent through alternates; a walk that
  still meets a missing object refuses the target, naming the object.
- Under a diff target: coherence raises a pair only when a side lies in the changed lines;
  `dead-code` raises a pre-existing symbol whose last caller the target removed; `comment-debt`
  raises nothing outside the changed lines and the blocks around them.
- A scan that re-finds a recorded finding lists it as still present, neither as new nor dropped.
- Triage marks a finding whose file differs between the scanned commit and the landing tip, and
  offers no remediation when the landing branch does not contain the scanned commit.
- A diff target that deletes a function and renames a file puts both files' base-side versions in
  the base tree and names the removed lines as numbered there; `backward-compatibility` then
  raises a remaining caller of the deleted function, and `dead-code` a symbol whose last call the
  target deleted.
- A read-only folder import is scanned from a snapshot filled without writing to its `.git`, and
  triage offers it no remediation.
- A snapshot of a commit whose `.gitattributes` asks for line-ending conversion and a smudge filter
  holds the blob bytes unchanged and runs no filter; a symlink inside the tree arrives as a link,
  one pointing out of it is named with its target and not recreated, and a submodule is named as
  not scanned.
- A clone whose `.git/config` sets `remote.origin.uploadpack`, `core.sshCommand`, a credential
  helper, `diff.external`, a textconv driver, `core.fsmonitor` or a hook runs none of them during a
  scan, since every git command runs in the scratch repository, and its changed lines come from
  git's own diff.
- A `.gitattributes`, `info/attributes` entry or `core.attributesFile` marking a changed text file
  `binary` changes none of the scan's line notes.
- A tail step's `loop_back` re-enters `scan-fix`, the seed's declared target, which reads the
  diagnosis and edits the integration worktree; `scan-fix` skips round 0, and the seed passes the
  composition validator.
- A malformed tree holding `.`, `..` or `.git` entries (written with `hash-object -t tree
  --literally`) refuses the target with the path named and writes nothing outside the snapshot.
- A folder import carrying a `refs/replace/` entry for the target: the snapshot, the diff and the
  recorded SHA all describe the target's own commit, not the replacement.
- A `scan-record` whose write fails fails the step and leaves no finding in its output without a
  row, and the Retry writes each row once.
- A file with more than 20 changed ranges is listed with all of them, or past the prompt budget
  with none, and never scoped to the first 20 alone.
- A change of mode alone (`100644` to `100755`) arrives in the snapshot with the new mode.
- Two slices raising one finding (one fingerprint, one path, the same lines, the same issue text)
  record one row; one fingerprint over different lines, or over issue texts that differ only in
  their digits, still fails the step.
- A `scan-record` re-run after a crash that followed its commit takes the task's own rows as this
  scan's, and labels none of its findings still present.
- A full or branch target whose `to` was typed as a tag or a bare SHA asks for a landing branch at
  triage.
- A scan of branch B while the checkout is on A pre-answers 00a's `base` with B, and
  `scan-remediate` dispatches no coder when the integration HEAD lacks the scanned commit (a base
  changed on the form), lacks the landing tip re-resolved at the source (a fast-forward 00a could
  not make), or that tip no longer holds the scanned commit (a branch force-pushed since triage,
  whose old local tip still holds it).
- A committed `.env` in the snapshot is visible to the security dimension, which reports its
  file, line and kind and never its value.

**Core (in the worker suite, shipped with the core changes):**
- The fan-out barrier fails the step on a rate-limit, auth or server-error row and degrades on a
  content-filter row — a table over every `ProviderFatalClass` member, so a class added later has
  to be placed. An `08d` fan-out with one refused seat ends degraded, carrying that seat's "did not
  complete" finding.
- `pickFatalProviderError` returns nothing for a content-filter run, so no sibling coder is
  cancelled; the refused issue ends `failed_unrecoverable` with the refusal marker and no advisor
  dispatch, and its siblings merge, with per-issue review on and with it off.
- A mining dispatch naming a snapshot mounts it alone and read-only, with no secret mask over its
  committed files and the base tree bound read-only outside the workdir, for a read-only folder
  import as for a clone, and so does the same agent replayed from its row: a reserved agent a dead
  worker never sent, and a wave agent recovered through the retry path.
- Completing or cancelling a repository task reaps its scratch workspace, snapshot included; a
  failed one keeps it.

**End to end on the dev stack:**
1. Scan this repository with 2 dimensions and a small budget; confirm findings land in
   `review_findings` with `deep-scan:` reviewer ids and the coverage record names the fifteen
   dimensions that did not run.
2. Triage two findings in one file; confirm remediation creates one DAG issue, one worktree, and
   merges.
3. Re-scan; confirm the already-fixed finding does not reappear and the report says what is new.
3b. Run coherence alone over this repo's own rules, `AGENTS.md` and KB; confirm every finding cites
   two `file:line` sides, and that the carve-out `2fffb947` added is not raised as a conflict.
3c. Run `comment-debt` alone over this repo; confirm the comments `AGENTS.md` demands survive, that
   two findings in one file are two rows, and that coherence and `comment-debt` do not both raise the
   comment-rule example.
3d. Run `dead-code` alone over this repo; confirm no adapter override or registry-reached symbol is
   raised, that a commented-out block is raised by `comment-debt` and not by this dimension, and that
   remediating one finding and re-scanning surfaces any symbol the deletion newly orphaned.
3e. Scan a commit range of this repository — `from` a commit a few merged PRs back, `to` `main` —
   with two dimensions; confirm every finding cites a file the range changed or its blast radius,
   the coverage record names both refs and both SHAs, and a second run of the same range lists the
   first run's findings as still present rather than reporting a clean window.
3f. Scan one older commit whose files `main` has changed since; confirm the agents read the
   snapshot (a finding's line matches the file at that commit, not at `main`), triage marks the
   finding as changed since the scan, and cancelling a second such scan mid-analysis leaves no
   snapshot on disk and the repository's `git worktree list` unchanged.
3g. Run security on one CLI and two other dimensions on another, with the security run refused. A
   refusal cannot be provoked on demand, so drive it with a stubbed invocation that exits non-zero
   carrying the measured refusal text. Confirm the two land, security is REFUSED in the coverage
   record, and switching its seat and using Resume re-runs that one terminal.
4. Install path: publish to the registry, install with a scoped token, verify `docker history` shows
   no token, and the module reaches `active` only on the loader's boot report.

**Adversarial:** remove the module while a `deep_scan` definition exists — the definition must become
non-selectable with a named reason, and an in-flight task must finish on its materialised run list.
