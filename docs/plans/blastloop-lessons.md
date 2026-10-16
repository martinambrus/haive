# What BlastLoop offers Haive: parallel DAG issues and shared files

> **In progress** (2026-10-16): P0 in review as #814. One source is reviewed:
> github.com/rlshaw-ml/BlastLoop (MIT, v1.0.0, about 23 KB of prompt markdown, no code). Scope chosen
> by the user on 2026-10-16: P0 only, record which files a DAG level merge conflicted on. P1 (shared-contract rule in the planner and the
> advisor's SPLIT) and P2 (a same-level overlap guard) are NOT built: measured below, they would
> likely cost more than the conflicts they prevent. P0's data decides them. Keep this file current
> by editing the section a change belongs to.

## Context

The user asked what Haive could take from BlastLoop. Every Haive claim below was read on `main`
`fed190ea8` on 2026-10-16. Every number was measured on the dev install that day; its review and
DAG steps last ran in Jul-Aug 2026 (128 tasks with findings, mostly DDEV setup of legacy PHP apps).

## The source

BlastLoop is a prompt methodology: three build "altitudes" (Blast = system and shared contracts, Mid
= subsystem, Inner = local), then ordered gates (T1 structural, T2 bug/ops, T3 adversarial), a
restart rule (a structural finding is never patched locally), and a seven-field handoff packet in
which a stage may recommend but only the owning altitude decides.

Haive already has every part of it except one: triage paths and 06b single/dag (altitudes); 07a,
the maintainability and DX dimensions and 08c's simplicity lens (T1); 07b, 08, 08b, 08c (T2); 08d's
adversaries with a PoC verifier panel (T3, stronger); 08a `fix_scope`, 07b's churn bail and the
round-cap and oscillation gates (escalation); `restartLoop` and `reviseLoop` (restart rule); fenced
diagnoses, guidance outside the fence and validate-each-finding (handoff). A structural-findings
tier was measured and rejected: about 0.9% of 10,297 findings are worded as structural, 12 of them
blocking.

The one part Haive lacks is "one owner per shared contract": BlastLoop builds a shared contract
first and lets parallel work build against it. Haive's 06b cuts vertical slices that run in
parallel with no rule for files two slices both change (`PLANNER_RULES`, 06b-sprint-planning.ts).

## Measured (dev install, 13 DAG plans, 68 issues)

- 30 of 63 merged issues needed an AI merge-fix (`task_dag_issues.merge_status = 'resolved'`,
  written only after the fixer and the host merge succeed). All 30 were resolved; none halted.
- Issue worktrees are cut per level from the integration branch (`resolveDagPhase`, "(A) Worktrees
  not created for this level yet"), so only same-level siblings can conflict.
- Conflicted issues share a self-reported file with a sibling 15/30, clean ones 6/33.
  `files_modified` is the coder's own report (`parseCoderResult`), so this is a floor. The planner's
  `estimated_files` predicted an overlap for 1 of the 30.
- Visible colliders: `.gitignore` (5 of 13 plans), DDEV.md and README, `.ddev/php/*.ini`, one PHP
  file (`thememanager.php`, 2 plans). Which files actually conflicted is NOT recorded anywhere:
  `unmergedPaths` is read for the fixer and dropped.
- The advisor's SPLIT puts sub-issues at the parent's level, in parallel: 5 of 7 split children
  needed a merge-fix.
- Cost of a conflict: 31 merge-fix runs took about 101 min serial wall time (3.7 min each) and
  about $7 notional, roughly 8 min per DAG task.
- Cost of preventing one by ordering: a DAG issue's median wall time is 32.3 min (p25 13.9, p75
  66.6). Moving an issue a level, or adding a contract-first level, costs several times the merge-fix
  it avoids.
- All 13 DAG tasks ran under auto-continue (95 of 99 06b runs), which submits the DAG gate with its
  defaults, so a warning shown there informs no decision.
- 98 fix-loop requests across 11 DAG tasks: the mismatch-worded ones are spec, README and
  version-range contradictions, none a cross-issue contract mismatch. BlastLoop's case for
  contract-first (parallel slices inventing incompatible contracts) is unmeasured here.
- `estimated_files` also feeds `overlapRefinedEstimate` (`_estimate.ts`), which admits any prior
  task sharing one predicted file; listing `.gitignore` or README there would anchor the effort
  estimate on unrelated tasks.

## P0: record which files a DAG level merge conflicted on (chosen scope)

In `runLevelMerge` (dag-executor.ts), merge pass, the branch where `openMerge` returned
`{ kind: 'conflict' }`: read `unmergedPaths(integration.path)` before `abortMerge`, which clears
them, and record one task event, following the `dag_issue.skipped` and `merge.abort_failed` inserts
in the same file. **As built** (Codex review on #814): the event is written after a successful
abort, in one transaction with `merge_status = 'conflict'`. Inserting it before the abort, as first
written here, let a pass that halted on a refused abort, or died before the status was written,
leave the issue unmerged, and its retry inserted a second event. Now such a pass records neither
and the retry records the conflict once.

- `eventType: 'dag_issue.merge_conflict'` (namespace of `dag_issue.skipped`; nothing matches event
  types by prefix, checked in worker, api, web and shared).
- `taskId: m.params.taskId`, `taskStepId: m.current.id`.
- `payload: { issueKey, level, paths, pathCount }` with `paths` = the first 20 (the cap
  `merge.abort_failed` uses for `blocking`) and `pathCount` = the full length, both `null` when git
  could not list them.

Not changed: `openMerge` keeps its `MergeOpen` contract (merge-resolver and the plan merge share it).
`unmergedPaths` already reads with `-z` and decodes UTF-8, so its strings are safe in jsonb. Add
`unmergedPaths` to the existing `./git-merge.js` import. Nothing reads the event; it is the record a
person or a query uses, like `dag_issue.skipped`. The insert is not wrapped in try/catch: it shares
the transaction with the `merge_status` update, so a failure fails both, as the neighbouring inserts
fail their step.

Not extended to merge-resolver (12-worktree-cleanup, 00a-sync-base, 13-onboarding-push): its
conflicts come from concurrent tasks, not sibling slices, and nothing needs that measurement yet.

Test, in dag-executor.test.ts inside the describe "runLevelMerge (via resolveDagPhase): a fix run
superseded before it started" (it defines `mergeCtx` and `dispatchingParams`), beside "a merge git
refused in the merge pass halts with its reason and sends no fixer" (same harness,
`makeDagMergeWaitDb`, real git): `setupConflictedIntegration(true)`,
`git merge --abort`, a worktree for `main--ISSUE-1`, `issue: { mergeStatus: null, worktreePath }`,
`autoResolveConflicts: false`. Assert one `h.events` entry with `eventType
'dag_issue.merge_conflict'` and payload `{ issueKey: 'ISSUE-1', paths: ['base.txt'], pathCount: 1 }`
(`issue.txt` merges cleanly and must not be listed), an issue update to `mergeStatus: 'conflict'`,
no MERGE_HEAD left, and the step halted with "Merge halted". **As built**, a second test ("a refused
abort records no conflict event, so the retry that re-enters records it once") refuses the abort
once through the `./git-merge.js` mock: that pass records `merge.abort_failed` and no conflict event,
and a retry against the merge it left open records exactly one. It fails on the insert-first code.

Docs: one paragraph in docs/architecture/merge-conflicts.md (it governs the DAG level merge): the
event and its fields, and the measured reason parallel-issue conflicts are left to the merge-fix
rather than prevented by ordering (the 3.7 vs 32.3 min numbers, auto-continue, the estimate side
effect), so nobody serializes issues later without new data. AGENTS.md is NOT touched: it is 32,760
of its 32,768-byte cap.

## P1 and P2: not built, and what reopens them

- P1, a shared-contract rule in `PLANNER_RULES` (contract first at a lower level, single mode when
  most slices share files, no extra level for a shared list) and the same rule on the advisor's
  SPLIT (`advisorPrompt`): reopen when P0 shows conflicts on code that two slices both depend on
  (types, interfaces, schema, routes, shared functions), or a fix round traced to two issues
  disagreeing on one. Not on list files.
- P2, a deterministic same-level `estimated_files` overlap check: re-levelling costs about 9x the
  conflict it avoids, and a gate warning is unseen under auto-continue. Reopen only with P1.
- If P0 shows the conflicts are mostly list files (`.gitignore`, docs indexes), the cheaper remedy
  is merge-side, like `resolveHaiveProjectionConflicts` for Haive's own files, which the DAG level
  merge does not run yet; `!` negation order makes a naive line union unsafe. Separate design.

Measurement after DAG tasks run:

```sql
SELECT payload->>'issueKey' AS issue, payload->'paths' AS paths, payload->>'pathCount' AS n
FROM task_events WHERE event_type = 'dag_issue.merge_conflict' ORDER BY created_at;
```

## Steps

0. Archive this plan: `cp` to docs/plans/blastloop-lessons.md (prettier-ignored, never reformat),
   add its row to the docs/plans/README.md status table, commit as its own `docs:` commit staging
   those two paths only (the tree holds another session's untracked files).
1. Before saving worker source: check no CLI run is in flight on the dev stack (a tsx reload of the
   worker kills it): `cli_invocations` with `started_at` set, `ended_at` and `superseded_at` null.
   If any, wait or ask.
2. P0 code + test + docs paragraph -> verify (below) -> one `feat(worker):` commit, explicit paths.
3. Update memory `project_dag_sibling_merge_conflicts.md` with the cost numbers and the reversal.
4. Ask before push (ship-it: format check, push, watch CI).

## Verification

- `pnpm --filter @haive/worker test dag-executor` passes, new test included (the script is
  `vitest run`, so the filter goes after `test`); then the full worker suite.
- `pnpm --filter @haive/worker typecheck` (in the worker container if host node_modules disagree).
- `pnpm format:check`.
- Rollback: revert the commit. No schema or config change; events already written are inert.
