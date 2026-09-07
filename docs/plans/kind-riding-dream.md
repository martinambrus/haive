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
cannot — see "OPEN — a published-image install cannot rebuild" in `serialized-chasing-thacker.md`.
Unresolved there, and it decides who can buy this module, so it is a gate on selling it rather than
on writing it.

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
— the same fourteen every reviewing step already scores a change against — plus **coherence** and
**comment-debt**, which the module owns. Sixteen in total, individually selectable, none mandatory or
implied, and there is no "scan everything" path that skips the form: an empty selection dispatches
nothing rather than falling back to all sixteen.

**Import that constant; do not re-list the names.** This plan was written before it existed
(`3741548b` 13:58, `99c176df` 15:15, both 2026-09-04) and its prose list had already drifted: it
omitted **accessibility, internationalization, backward compatibility and privacy / compliance**,
and wrote `developer-experience` as "DX" — a third spelling of the one name the constant was created
to settle, which is the exact failure it ended (the same fourteen were hardcoded prose in five files
and eleven sites, worded three ways). A module that restates the list reintroduces that drift, and a
fifteenth core dimension would then silently not be scanned. `resolveReviewDimensions` also already
does what the form needs — canonical ordering, unknown-id tolerance, NULL-means-all.

**Both module-owned dimensions stay OUT of the core constant, for two different reasons.**
Coherence, because no change-scoped reviewer can score it (that is the dimension's whole argument,
below): putting it in core would list it on `06-run-config` and in the repo policy where nothing
would ever review it, and 07b's `## Not reviewed` disclosure would then be wrong, since it reports a
dimension as unscored only when it was deliberately excluded. Comment-debt, because adding a
fifteenth core entry re-numbers and re-indents `numberedDimensionBlock`, which `dimensions.test.ts`
asserts byte-for-byte against the original 07b literal precisely because every install that has not
touched the setting still renders it — a prompt regression for everyone, to serve one module.

**Two of the four missed dimensions carry change-scoped criteria and must be restated** for a
whole-tree read, or the agent is handed a prompt pointing at steps `deep_scan` does not have:
`internationalization` is literally "cross-reference Step 6 findings", and `backward-compatibility`
is "renamed functions/hooks/services have all callers updated (cross-reference Step 4)". Whole-tree
those become, respectively, user-facing strings going through the project's translation layer with
no hardcoded locale/currency/date assumptions, and a public surface that is versioned or additive
with a migration path behind every deprecation and schema change. The other twelve read correctly
as-is. Keep the constant's `id` and `label` either way — they are what `review_findings.raw`
carries as `dimension` and what the dashboard filters on.

Detect seeds a proposed set from the repo's own dimension POLICY (`repositories.review_dimensions`,
NULL = all fourteen) intersected with the onboarding tech inventory (`onboarding/_tech-inventory.ts`)
rather than asking cold — a repo that has already scoped accessibility out of its reviews must not
get it pre-ticked here. `coherence` and `comment-debt` are not in that policy and seed on. A seed is a pre-ticked box
the user can clear, never a floor. Also on the form: scope (whole repo or subtree) and a **budget**
in agent invocations.

**2 · `scan-analyze`** — `agentMining` fan-out, **one agent per selected dimension over the whole
tree** (not per component). Sixteen dimensions is at most sixteen invocations, drained 5 at a time by
`MAX_PARALLEL_AGENTS_PER_TASK`; per-component splitting is a later refinement for a dimension that
times out, not v1. Each agent returns structured findings (`path`, `line`, `severity`, `dimension`,
`issue`, `fix`) and carries `REPO_IS_DATA_LINES` from `steps/_untrusted-repo.ts`.

**Reuse the multi-model fan-out here; do not rebuild it.** This step fans out across **dimensions**
(N different prompts, one model each). `purring-marinating-peacock.md` fans out across **models** (one
prompt, N models, then a consolidator merges the drafts). Orthogonal axes, so nothing here duplicates
it — but leaving the cross-model axis out drops where much of the original workflow's value lived: its
four CLIs all answered the SAME question and disagreed usefully. They compose at that plan's **Phase
2b** (agent-mining nested barrier), where each dimension agent becomes a group of M members plus a
consolidator, giving dimension x model. That is already specified there; this module declares the
dependency and builds none of it. In particular it must NOT introduce a consolidator of its own —
`buildConsolidatorPrompt` is generic by design and lives in core.

**Optional, never a prerequisite.** Phase 2b is that plan's hardest piece and may be deferred, so
`deep_scan` must run correctly single-model. The scope step's budget knob governs the cost: 16
dimensions x 3 members + 16 consolidators is 64 invocations, drained 5 at a time — thirteen serial
batches. Multi-model is opt-in per run, and deselecting dimensions is the other lever on that number.

**3 · `scan-verify`** — second mining wave via `MiningWaveError`, reusing the three-lens refuter
panel built in `08c-code-review.ts`. **The default inverts here, deliberately.** In `08c` a finding
is kept unless unanimously disproved, because gate 2 auto-approves and a wrong dismissal ships a
vulnerability. A scan report is read by a human and nothing auto-approves, so a false positive costs
attention instead — the plugin's own reasoning, and the reason its verifiers default to
FALSE_POSITIVE on a 2-of-3 quorum. Same machinery, opposite default, and the comment must say why.

**A consolidator does not make this step redundant**, and the prompt should say so where a reader
might assume otherwise. Consolidation reconciles drafts of one answer; refutation checks a claim
against the code and demands a cited `file:line`. `purring-marinating-peacock`'s own caveat is
explicit — consolidator contradiction-validation is "best-effort model judgement, NOT a correctness
guarantee" — so consolidating three models' findings still yields findings nobody verified.
Consolidate first, refute second, and keep the inverted 2-of-3 default.

**4 · `scan-record`** — deterministic. Dedups survivors by `findingFingerprint` against existing
`review_findings` rows, writes them with `reviewerId = 'deep-scan:<dimension>'` (no core schema
change; the column is `varchar(128)`), and records coverage — which dimensions ran, what the budget
truncated — reusing the disclosure convention from `_impl-changes.ts`.

**It asserts distinct fingerprints within a batch**, because `comment-debt` is the one dimension that
breaks the dedupe every other one survives — see its section below. `recordReviewFindings` writes with
`onConflictDoNothing` against the UNIQUE `review_findings_dedupe_idx`
`(task_id, task_step_id, round, fingerprint)`, so a collision is swallowed with no error and no log. A
collision here is a module bug to surface, not a duplicate to drop.

**5 · `scan-triage`** — form. The human picks which findings to fix. **This step is the entire answer
to "502 tasks, 0 fixes"**: nothing proceeds to remediation that a person did not choose. A coherence
finding asks one extra thing — **which side is authoritative** — because "these two disagree" has no
fix until a person says which one is right. Left unanswered it stays recorded and unplanned rather
than guessed at.

**Volume is the failure mode this step must survive**, and `comment-debt` is where it bites: every
file has comments, so that dimension can reproduce "502 tasks" through triage volume rather than
through a loop, and a form rendering two thousand checkboxes is no answer. The budget at step 1 is
per-invocation and bounds no findings, so the cap is per-dimension and per-file — `comment-debt`
reports at most N findings per file, ranked by span, and the coverage record names what it truncated.

**6 · `scan-plan-remediation`** — deterministic, **no LLM**. Selected findings become DAG rows:
`task_dag_plans` (mode `'dag'`), `task_dag_levels`, `task_dag_issues` (`title` ← issue,
`description` ← issue + fix, `filesModified` ← path, `acceptanceCriteria` ← the fix's check).
**One issue per file**, so several findings in one file are fixed by one agent — which removes
intra-file merge conflicts by construction rather than predicting collisions the way the archive's
planner did. A coherence finding names TWO files and so breaks that rule as stated: group by the
**connected component** of the paths a finding names, not by a single path, or two issues could each
claim one side of the same conflict and reintroduce exactly the collision the rule exists to prevent.
Every other dimension names one path, where connected components degenerate to one-issue-per-file —
so this changes nothing for the other fifteen, `comment-debt` included: each of its findings names one
path, and several comment findings in a file being fixed by one agent is the right unit anyway. All at
level 0 unless a dependency is declared.

One cheap post-check falls out of that: when every finding in an issue is `comment-debt`, the
remediation diff must touch **comment lines only** — a mechanical assertion no other dimension can
make. It is available only when the issue is single-dimension, which one-issue-per-file does not
guarantee, so it is a bonus gate and must not be turned into a requirement by making the grouping rule
dimension-aware.

**7 · `scan-remediate`** — declares the `dagExecute` hook and supplies a fix-oriented coder prompt.
**No core change needed:** `resolveDagPhase` (`step-engine/dag-executor.ts:1505`) loads its plan by
`taskDagPlans.taskId`, not from `06b`, so the module inherits per-level isolated worktrees, parallel
coders, the barrier, level-by-level merge, checkpointing and crash recovery wholesale. This is the
single largest piece of reuse in the plan.

**8 ·** Core steps composed from the catalog after remediation — verify, review, commit — exactly as
a workflow task ends.

### The coherence dimension

Fourteen of the sixteen ask "is this code wrong". This one asks **"do two parts of this project
contradict each other"**. A rule, a KB page, a doc, a code comment and the code itself all state
intent, and when two of them state OPPOSITE intent every agent that reads them afterwards is
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
those stay in its reading set whatever the scope.

Four things this dimension must get right, none of which the core fourteen need (`comment-debt`
needs its own analogue of the second and the fourth — see its section):

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

**It breaks the fingerprint dedupe that every other dimension survives.** `findingFingerprint` hashes
`(reviewerId, path, issue-with-digits-stripped)` and `review_findings_dedupe_idx` is UNIQUE on
`(task_id, task_step_id, round, fingerprint)`, with every writer using `onConflictDoNothing`. Other
dimensions are safe because two defects in one file are described in different sentences. Comment
findings are **templated by nature** — "comment narrates the line below" reads identically for every
instance — and the line number that would separate them is the one thing the normaliser strips. Three
such findings in one file collapse to one, with no error, no log, and nothing downstream able to tell.
The fix is the device coherence uses for its pair, for both of its reasons at once: `issue` carries
the offending comment's own opening text verbatim, which makes the finding unique AND refutable.

### Convergence

There is none of the archive's kind. The run is bounded by **the budget chosen at step 1**, and
repeat scans dedup against recorded findings, so a second run reports what is *new*. No agent is ever
penalised for finding nothing. If a "keep going until dry" mode is ever added it must key on *no new
findings after verification*, never on empty output, and still stop at the budget.

## Core changes this needs (small, and in Haive rather than the module)

Both are already written into the two modularity plans (`5aa4704`):

- Module `composableSteps` union into `composable_step_catalog`, namespaced `module.<id>.<stepId>`.
- Module-seeded task-type definitions, and the dangling-reference rule when a module is removed.

One rule to state in the module system's docs while building this: a module may **write core rows**
through `ctx.db` (`review_findings`, `task_dag_*` — those are the intended extension points) but must
**not add core tables**; its own schema goes in its own database via `ensure-schema`. The existing
cross-cutting rule says the latter but not the former, and this module does both kinds of write.

## Critical files (reference, not modification)

- Dimension taxonomy to IMPORT (the one exception: this is used, not just read):
  `packages/shared/src/review/dimensions.ts`, and the repo/task policy in
  `step-engine/review-dimension-context.ts`
- Fan-out + refuter panel to copy: `steps/workflow/08c-code-review.ts`
- Whole-tree step precedent: `steps/onboarding/07_7-secret-sweep.ts`
- Findings persistence + fingerprint: `steps/workflow/_review-findings.ts`
- DAG rows + executor: `packages/database/src/schema/task-dag.ts`, `step-engine/dag-executor.ts`
- Untrusted-tree clause: `steps/_untrusted-repo.ts`
- Comment policy `comment-debt` judges against: `packages/shared/src/constants/default-agent-rules.ts`
  and `resolveEffectiveRules` in `packages/shared/src/templates/cli-rules.ts`
- Coverage disclosure convention: `steps/workflow/_impl-changes.ts`

## Verification

**Unit (in the module's own suite):**
- Dimension selection produces exactly the expected agent fan-out, and an empty selection dispatches
  nothing rather than defaulting to all sixteen. No dimension survives being deselected.
- The fan-out set equals `REVIEW_DIMENSIONS` plus `coherence` and `comment-debt` — asserted against
  the imported constant, not a literal, so a dimension added to core fails this test until the module
  handles it. No count is hardcoded anywhere but prose.
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
- The per-file cap: the coverage record names the file and the count it truncated.

**End to end on the dev stack:**
1. Scan this repository with 2 dimensions and a small budget; confirm findings land in
   `review_findings` with `deep-scan:` reviewer ids and the coverage record names the fourteen
   dimensions that did not run.
2. Triage two findings in one file; confirm remediation creates one DAG issue, one worktree, and
   merges.
3. Re-scan; confirm the already-fixed finding does not reappear and the report says what is new.
3b. Run coherence alone over this repo's own rules, `AGENTS.md` and KB; confirm every finding cites
   two `file:line` sides, and that the carve-out `2fffb947` added is not raised as a conflict.
3c. Run `comment-debt` alone over this repo; confirm the comments `AGENTS.md` demands survive, that
   two findings in one file are two rows, and that coherence and `comment-debt` do not both raise the
   comment-rule example.
4. Install path: publish to the registry, install with a scoped token, verify `docker history` shows
   no token, and the module reaches `active` only on the loader's boot report.

**Adversarial:** remove the module while a `deep_scan` definition exists — the definition must become
non-selectable with a named reason, and an in-flight task must finish on its materialised run list.
