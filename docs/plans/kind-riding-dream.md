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
incl. the 2026-08-20 amendment) and `rippling-wibbling-puffin` (data-driven task types, incl. its
amendment). Neither is a runtime dependency of the other for this module — it needs `./steps` from
the first and the composable catalog + task-type seed from the second.

## What the module ships

Package `@haive-module/deep-analysis`, `files: ["dist"]`, published to GitHub Packages, installed as
a dependency of api + worker (registry token via BuildKit secret — see the module-system amendment).

- `./manifest` — `hasSteps`, `composableSteps` (its steps, for the task-type composer),
  `taskTypes` (the `deep_scan` seed), `nav` + `pages` (a findings dashboard), `globalSettings`.
- `./steps` — the pipeline below.
- `./routes` — read API backing its dashboard.

The dashboard is worth calling out as product value, not decoration: **`review_findings` has no UI at
all today** — nothing in `packages/web` or `packages/api` reads it. The module is its first consumer.

## The pipeline

One task type, `deep_scan`, composed of module steps plus core steps from the catalog.

**1 · `scan-scope`** — detect + form, and the only step that runs before any CLI fans out.
**Every dimension is optional.** The eleven — security, maintainability, testability, usability,
stability, performance, observability, operational readiness, data integrity, DX, coherence — are
individually selectable, none is mandatory or implied, and there is no "scan everything" path that
skips the form: an empty selection dispatches nothing rather than falling back to all eleven. Detect
seeds a proposed set from the repo's onboarding tech inventory (`onboarding/_tech-inventory.ts`)
rather than asking cold, but a seed is a pre-ticked box the user can clear, never a floor. Also on
the form: scope (whole repo or subtree) and a **budget** in agent invocations.

**2 · `scan-analyze`** — `agentMining` fan-out, **one agent per selected dimension over the whole
tree** (not per component). Eleven dimensions is at most eleven invocations, drained 5 at a time by
`MAX_PARALLEL_AGENTS_PER_TASK`; per-component splitting is a later refinement for a dimension that
times out, not v1. Each agent returns structured findings (`path`, `line`, `severity`, `dimension`,
`issue`, `fix`) and carries `REPO_IS_DATA_LINES` from `steps/_untrusted-repo.ts`.

**3 · `scan-verify`** — second mining wave via `MiningWaveError`, reusing the three-lens refuter
panel built in `08c-code-review.ts`. **The default inverts here, deliberately.** In `08c` a finding
is kept unless unanimously disproved, because gate 2 auto-approves and a wrong dismissal ships a
vulnerability. A scan report is read by a human and nothing auto-approves, so a false positive costs
attention instead — the plugin's own reasoning, and the reason its verifiers default to
FALSE_POSITIVE on a 2-of-3 quorum. Same machinery, opposite default, and the comment must say why.

**4 · `scan-record`** — deterministic. Dedups survivors by `findingFingerprint` against existing
`review_findings` rows, writes them with `reviewerId = 'deep-scan:<dimension>'` (no core schema
change; the column is `varchar(128)`), and records coverage — which dimensions ran, what the budget
truncated — reusing the disclosure convention from `_impl-changes.ts`.

**5 · `scan-triage`** — form. The human picks which findings to fix. **This step is the entire answer
to "502 tasks, 0 fixes"**: nothing proceeds to remediation that a person did not choose. A coherence
finding asks one extra thing — **which side is authoritative** — because "these two disagree" has no
fix until a person says which one is right. Left unanswered it stays recorded and unplanned rather
than guessed at.

**6 · `scan-plan-remediation`** — deterministic, **no LLM**. Selected findings become DAG rows:
`task_dag_plans` (mode `'dag'`), `task_dag_levels`, `task_dag_issues` (`title` ← issue,
`description` ← issue + fix, `filesModified` ← path, `acceptanceCriteria` ← the fix's check).
**One issue per file**, so several findings in one file are fixed by one agent — which removes
intra-file merge conflicts by construction rather than predicting collisions the way the archive's
planner did. A coherence finding names TWO files and so breaks that rule as stated: group by the
**connected component** of the paths a finding names, not by a single path, or two issues could each
claim one side of the same conflict and reintroduce exactly the collision the rule exists to prevent.
Every other dimension names one path, where connected components degenerate to one-issue-per-file —
so this changes nothing for the other ten. All at level 0 unless a dependency is declared.

**7 · `scan-remediate`** — declares the `dagExecute` hook and supplies a fix-oriented coder prompt.
**No core change needed:** `resolveDagPhase` (`step-engine/dag-executor.ts:1505`) loads its plan by
`taskDagPlans.taskId`, not from `06b`, so the module inherits per-level isolated worktrees, parallel
coders, the barrier, level-by-level merge, checkpointing and crash recovery wholesale. This is the
single largest piece of reuse in the plan.

**8 ·** Core steps composed from the catalog after remediation — verify, review, commit — exactly as
a workflow task ends.

### The coherence dimension

Ten of the eleven ask "is this code wrong". The eleventh asks **"do two parts of this project
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

Its reading set is wider than code: `.haive-data/knowledge_base/` and `.haive-data/learnings/`
(`KB_DIR`/`LEARNINGS_DIR` in `shared/src/knowledge-paths.ts`), the installed agent rules and
`AGENTS.md`/`CLAUDE.md`, `.claude/skills/` and commands, `README`/`docs/`, and code comments against
the code they sit on. Four directions, and the prompt names all four: doc vs doc, doc vs code, comment
vs code, and code vs code (two modules implementing one contract incompatibly). **Subtree scope
narrows the code side only** — the rules and KB a subtree must agree with live at the repo root, so
those stay in its reading set whatever the scope.

Four things this dimension must get right, none of which the other ten need:

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

### Convergence

There is none of the archive's kind. The run is bounded by **the budget chosen at step 1**, and
repeat scans dedup against recorded findings, so a second run reports what is *new*. No agent is ever
penalised for finding nothing. If a "keep going until dry" mode is ever added it must key on *no new
findings after verification*, never on empty output, and still stop at the budget.

## Core changes this needs (small, and in Haive rather than the module)

Both are already written into the plan amendments pushed in `5aa4704`:

- Module `composableSteps` union into `composable_step_catalog`, namespaced `module.<id>.<stepId>`.
- Module-seeded task-type definitions, and the dangling-reference rule when a module is removed.

One rule to state in the module system's docs while building this: a module may **write core rows**
through `ctx.db` (`review_findings`, `task_dag_*` — those are the intended extension points) but must
**not add core tables**; its own schema goes in its own database via `ensure-schema`. The existing
cross-cutting rule says the latter but not the former, and this module does both kinds of write.

## Critical files (reference, not modification)

- Fan-out + refuter panel to copy: `steps/workflow/08c-code-review.ts`
- Whole-tree step precedent: `steps/onboarding/07_7-secret-sweep.ts`
- Findings persistence + fingerprint: `steps/workflow/_review-findings.ts`
- DAG rows + executor: `packages/database/src/schema/task-dag.ts`, `step-engine/dag-executor.ts`
- Untrusted-tree clause: `steps/_untrusted-repo.ts`
- Coverage disclosure convention: `steps/workflow/_impl-changes.ts`

## Verification

**Unit (in the module's own suite):**
- Dimension selection produces exactly the expected agent fan-out, and an empty selection dispatches
  nothing rather than defaulting to all eleven. No dimension survives being deselected.
- The verifier tally: 2-of-3 dismisses (inverted from `08c`), and an unreadable voter does not.
- `scan-plan-remediation` puts two findings in one file into ONE issue, and two files into two.
- Findings already recorded are deduped on a re-scan; a repeat run reports only what is new, and a
  coherence pair reported with its two sides swapped fingerprints identically.
- Coherence raises a pair with both sides cited, and does NOT raise when one side states a carve-out
  naming the other.
- A coherence finding across two files becomes ONE DAG issue owning both, and a separate finding in
  either of those files joins that same issue rather than opening a second one.

**End to end on the dev stack:**
1. Scan this repository with 2 dimensions and a small budget; confirm findings land in
   `review_findings` with `deep-scan:` reviewer ids and the coverage record names the nine
   dimensions that did not run.
2. Triage two findings in one file; confirm remediation creates one DAG issue, one worktree, and
   merges.
3. Re-scan; confirm the already-fixed finding does not reappear and the report says what is new.
3b. Run coherence alone over this repo's own rules, `AGENTS.md` and KB; confirm every finding cites
   two `file:line` sides, and that the carve-out `2fffb947` added is not raised as a conflict.
4. Install path: publish to the registry, install with a scoped token, verify `docker history` shows
   no token, and the module reaches `active` only on the loader's boot report.

**Adversarial:** remove the module while a `deep_scan` definition exists — the definition must become
non-selectable with a named reason, and an in-flight task must finish on its materialised run list.

---

# Amendment — 2026-08-20: reuse the multi-model fan-out, do not rebuild it

The plan above fans out across **dimensions** (N different prompts, one model each). The separate
plan `purring-marinating-peacock.md` fans out across **models** (one prompt, N models, then a
consolidator merges the drafts). Those are orthogonal axes, so nothing here duplicates it — but the
plan as written silently dropped the cross-model axis, which is where much of the original
workflow's value lived: its four CLIs all answered the SAME question and disagreed usefully.

**They compose at that plan's Phase 2b (agent-mining nested barrier).** Each `scan-analyze` dimension
agent becomes a group of M members plus a consolidator, giving dimension x model. That is already
specified there; this module declares the dependency and builds none of it. In particular it must NOT
introduce a consolidator of its own — `buildConsolidatorPrompt` is generic by design and lives in
core.

**Optional, never a prerequisite.** Phase 2b is that plan's hardest piece and may be deferred, so
`deep_scan` must run correctly single-model and merely improve when 2b exists. The scope step's
budget knob governs it: 11 dimensions x 3 members + 11 consolidators is 44 invocations, drained 5 at
a time by `MAX_PARALLEL_AGENTS_PER_TASK` — nine serial batches. Multi-model is opt-in per run, and
deselecting dimensions is the other lever on that number.

**`scan-verify` is not made redundant by the consolidator**, and the plan should say so where a
reader might assume otherwise. Consolidation reconciles drafts of one answer; refutation checks a
claim against the code and demands a cited `file:line`. That plan's own caveat is explicit —
consolidator contradiction-validation is "best-effort model judgement, NOT a correctness guarantee" —
so consolidating three models' findings still yields findings nobody verified. Consolidate first,
refute second, and keep the inverted 2-of-3 default described above.
