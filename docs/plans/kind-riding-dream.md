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

**1 · `scan-scope`** — detect + form. The ten dimensions are **individually selectable** (security,
maintainability, testability, usability, stability, performance, observability, operational
readiness, data integrity, DX), plus scope (whole repo or subtree) and a **budget** in agent
invocations. Detect seeds sensible defaults from the repo's onboarding tech inventory
(`onboarding/_tech-inventory.ts`) rather than asking cold.

**2 · `scan-analyze`** — `agentMining` fan-out, **one agent per selected dimension over the whole
tree** (not per component). Ten dimensions is at most ten invocations, drained 5 at a time by
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
to "502 tasks, 0 fixes"**: nothing proceeds to remediation that a person did not choose.

**6 · `scan-plan-remediation`** — deterministic, **no LLM**. Selected findings become DAG rows:
`task_dag_plans` (mode `'dag'`), `task_dag_levels`, `task_dag_issues` (`title` ← issue,
`description` ← issue + fix, `filesModified` ← path, `acceptanceCriteria` ← the fix's check).
**One issue per file**, so several findings in one file are fixed by one agent — which removes
intra-file merge conflicts by construction rather than predicting collisions the way the archive's
planner did. All at level 0 unless a dependency is declared.

**7 · `scan-remediate`** — declares the `dagExecute` hook and supplies a fix-oriented coder prompt.
**No core change needed:** `resolveDagPhase` (`step-engine/dag-executor.ts:1505`) loads its plan by
`taskDagPlans.taskId`, not from `06b`, so the module inherits per-level isolated worktrees, parallel
coders, the barrier, level-by-level merge, checkpointing and crash recovery wholesale. This is the
single largest piece of reuse in the plan.

**8 ·** Core steps composed from the catalog after remediation — verify, review, commit — exactly as
a workflow task ends.

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
  nothing rather than defaulting to all ten.
- The verifier tally: 2-of-3 dismisses (inverted from `08c`), and an unreadable voter does not.
- `scan-plan-remediation` puts two findings in one file into ONE issue, and two files into two.
- Findings already recorded are deduped on a re-scan; a repeat run reports only what is new.

**End to end on the dev stack:**
1. Scan this repository with 2 dimensions and a small budget; confirm findings land in
   `review_findings` with `deep-scan:` reviewer ids and the coverage record names the eight
   dimensions that did not run.
2. Triage two findings in one file; confirm remediation creates one DAG issue, one worktree, and
   merges.
3. Re-scan; confirm the already-fixed finding does not reappear and the report says what is new.
4. Install path: publish to the registry, install with a scoped token, verify `docker history` shows
   no token, and the module reaches `active` only on the loader's boot report.

**Adversarial:** remove the module while a `deep_scan` definition exists — the definition must become
non-selectable with a named reason, and an in-flight task must finish on its materialised run list.
