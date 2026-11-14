# Time and cost report: tests, human, AI

> Implementation review: 2026-11-12 against `3426c8c34`; corrections are folded into the relevant sections.
> **PR 1 shipped as #1169, PR 2 as #1170. PR 3 shipped: the idle tile relabel; its note line waits on `human-time-idle-detection` PR 1.** Written 2026-11-09 from the tree at `18a6cde1d` and read-only queries on the dev
> install. Three independently revertible PRs, in the order below. PR 1 needs no schema change and shows history.

## Context

Management asked to see, for the work done through Haive:

1. how long the tests took;
2. how long a person spent managing the AI workflow (reading the tech spec and so on);
3. how long the AI took to work on and finish its tasks;
4. what that cost, or would have cost without a subscription.

Most of the raw data exists. What is missing is a tests figure, one place that answers all four
for the same set of tasks, and two corrections that keep the human figure honest.

## What exists today

| Question | Stored | Shown | Gap |
| --- | --- | --- | --- |
| Tests | Only as whole-step timestamps. `CheckResult` in `08-phase-5-verify.ts` has no duration, so the suite, lint and typecheck cannot be told apart. | Per-step timer on the task page, and `/m/statistics/steps` for the agent-driven steps. | No tests total anywhere. `/steps` is built from `cli_invocations`, and `08-phase-5-verify` starts no CLI, so that step is absent from it. |
| Human, active | `task_steps.user_active_ms` plus `carried_user_active_ms`, posted by `useUserActiveTimer` while a form waits and the page is visible and focused. | "user" on the task page; a hint under one tile on the Time tab. | No per-task list. No inactivity cutoff, so a focused window left alone keeps counting. |
| Human, waiting | Only inside `idle_ms`, which also holds agent-slot and rate-limit parks. `task_events` has timestamped `step.waiting_form` and `step.form_submitted`. | The Time tab labels all of `idle_ms` "Waiting on you". | The label is wrong. Turnaround is never computed. |
| AI time | Step spans via `computeTaskTiming` (`workMs`), invocation clocks (agent-hours, busy span). | Time tab, Per task table, task page. | The Per task table has no human, tests or cost columns. |
| Cost | `cli_invocations.cost`; `realCostUsdSql` and `notionalCostUsdSql`. | Money tab, task page provider card. | Per window on the invocation clock, while effort is per task completed in the window, so the two cannot be read side by side. Not in any per-task list. |

Measured on the dev install, completed `workflow` tasks (141), unless noted. Most of these are
automated benchmark runs on `rs_*` repositories, so they show the shape and coverage of the data,
not what a real team would see.

- Work 546.28 h, user-active 5.84 h, idle 10,544.66 h.
- Idle is mostly not people: `step.waiting_form` closed by `step.form_submitted` accounts for 491.27 h
  over 2,042 waits, of which 730 closed in under 5 s (auto-submitted forms).
- All task types, step work including carried: `08-phase-5-verify` 0.53 h, `08a-browser-verify`
  4.66 h, `08b-test-management` 0.36 h, `08d-adversarial-qa` 6.59 h.
- `08-phase-5-verify` ran a test command in only 8 of 474 completed runs. The other 466 had no
  detected test command. A repository like that shows almost no test time, and the page must say
  "not run" rather than a small number.
- Spend: 0.00 USD billable and 475.25 USD notional on rows with a cost snapshot. 6,154 of 6,887
  non-superseded runs have no snapshot (they predate it) and 270 are unpriced, so "at API rates" is
  a lower bound for older work.

## Decisions

**Put it on a new tab of the existing statistics page, "Time & cost report".** It needs the page's
window, repository, class and all-users controls, and the module already has the parser, the
all-users check and lazy tab loading. A separate screen would duplicate all of that. Do not add
columns to the Per task table instead: that table ranks tasks by agent time on the invocation clock,
and this report covers completed tasks.

**One population: tasks completed in the window** (`completedTasksOver`), for every figure. Timing
has no location in time, so it can only be attributed to a finished task. Cost on this tab is
therefore the whole cost of those tasks, and will differ from the Money tab, which sums by when each
run happened. The tab says so.

**"Tests" means the test phase steps:** `08b-test-management`, `08-phase-5-verify`,
`08a-browser-setup`, `08a-browser-verify`, `08d-adversarial-qa`, `08d2-adversarial-qa-review`.
`07b-phase-4-validate` and `08c-code-review` are spec and code review, not tests, and go under
Review. Moving a step is a one-line change to the map.

**Classify by persisted step id, in one shared map.** Step ids are a stable contract: `08b-` kept its
id through a reorder precisely because it is the persisted `task_steps.step_id`. A column on
`task_steps` would need a backfill and buys nothing. Any id not in the map counts as Other, which
covers onboarding, module and custom steps.

**Workflow work is `workMs`, with agent-hours beside it.** `workMs` is what the task page already calls
work, counts a fan-out once, and includes deterministic work such as DDEV boot and the test suite.
Agent-hours counts each concurrent agent and is the compute figure, not elapsed time.

**Show human time as two figures.** Active is focused attention. Turnaround is how long the workflow
waited for a person, from `step.waiting_form` to `step.form_submitted`. Neither replaces the other:
active alone looks implausibly small, and turnaround includes nights. A form that ended any other
way (retry, skip, stop) enters neither side and the footnote says so.

**Show billed and "at API rates" as separate figures, never a single total.** "At API rates" is
real plus notional and answers "what would this cost without a subscription". It is marked as a
lower bound whenever a task has unpriced or unsnapshotted runs.

**Store each check run in its own table rather than in step output.** Step output is nulled on a
reset, so a duration kept there loses every retried attempt. A row also carries real timestamps.

## Not in scope

- Timing test commands an agent runs itself during implementation or a fix. Those stay inside
  Implementation, and the page says so. In a small sample, `tool_use` and `tool_result` stream lines
  had no clock of their own, though some assistant events carry a `timestamp`. Deriving tool timing
  would be separate work per CLI.
- Counting human time outside a waiting form on the task page: steering a running agent, testing the
  app in another tab, or PR review on the forge. The tab lists these as not counted. Plan page time
  and idle detection are `human-time-idle-detection`.
- CSV export and per-day charts of human time, which has no timestamps.
- Adding the verify step to `/m/statistics/steps`. The new tab covers it.

## PR 1: shared calculation, report endpoint, tab, task page cell

No schema change. Works on all existing data. Rollback: revert the PR.

**`packages/shared/src/step-engine/timing.ts`** stays import-free because web loads it through
`@haive/shared/timing`.

- `TIME_CATEGORY_BY_STEP` and `timeCategoryOf(stepId)`, returning `setup`, `planning`,
  `implementation`, `tests`, `review`, `delivery` or `other`.
- `computeWorkByCategory(steps, nowMs)` over `TaskTimingStep & { stepId: string }`, using
  `computeStepContribution` plus `carriedWorkMs`.

| Category | Step ids |
| --- | --- |
| setup | `00-model-health-workflow`, `00a-sync-base`, `00-triage`, `00b-estimate`, `01-debug-mode`, `01-worktree-setup`, `01a-app-boot`, `01b-install-plugins`, `01c-ddev-env`, `01c1-restore-database`, `01d-browser-access`, `01e-external-kb-sync`, `01f-external-plan-sync`, `01g-rag-source-selection`, `02-pre-rag-sync`, `06a-db-migrate` |
| planning | `03-phase-0a-discovery`, `03b-business-requirements`, `03b2-humanize-requirements`, `03c-business-requirements-review`, `04-phase-0b-pre-planning`, `04a-spec-audit`, `05-phase-0b5-spec-quality`, `05a-resolve-spec-warnings`, `06-gate-1-spec-approval`, `06-run-config`, `06b-sprint-planning` |
| implementation | `06c-dag-execute`, `07-phase-2-implement`, `07a-code-simplify`, `07c-ddev-reconcile` |
| tests | the six listed under Decisions |
| review | `07b-phase-4-validate`, `08c-code-review`, `08c2-code-audit`, `08e-insights-triage`, `09-gate-2-verify-approval` |
| delivery | `10-gate-3-commit`, `11-phase-8-learning`, `11a-gate-4-push`, `11b-kb-commit`, `11b1-rag-source-selection`, `11c-rag-reindex`, `11e-prompt-guidance`, `11f-plan-reconcile`, `11g-save-database`, `12-worktree-cleanup`, `13-pr-wait` |

A worker test walks the workflow step registry and fails on any registered id missing from the map,
so a new step cannot silently land in Other. Check the list against the registry when writing that
test, since ids set through constants are easy to miss.

**`packages/shared/src/stats/`**: pure `sumFormWaits(events)` and `buildTimeCostReport(input)`,
tested without a database. Wait pairing is per task and `task_step_id`, ordered by `(created_at, id)`, over the full
lifecycle event stream, not just the two event types. A wait closes at its next submit only if no
retry, reset, skip, stop, cancel or replacement park invalidated it. A new park replaces an open
one; orphan submits and still-open waits contribute nothing. Historical rows that cannot be
paired unambiguously are disclosed as unmeasured, never joined across attempts. Use the exact
event types emitted by the current API and worker when building the reducer.

**`modules/statistics/src/routes.ts`**: lazy `GET /m/statistics/time-cost`, with the same parser,
all-users re-check and `costDisplay` as `/summary`.

1. `completedTasksOver` for the population, then titles and repositories for the rows kept.
2. Step timing rows, as `effortOver` selects them, plus `stepId`.
3. `cli_invocations` grouped by task and step id with `invocationAttributionFilter`: agent-ms,
   `realCostUsdSql`, `notionalCostUsdSql`, unpriced count, and a count of `cost IS NULL` runs for
   the lower-bound mark.
4. The lifecycle `task_events` needed by the wait reducer for those tasks, which
   `task_events_task_id_idx` serves. Run
   `EXPLAIN` on this query at the two-year window before merging.

The response has `totals`, `byCategory` (work, agent-ms, real, notional) and `rows`, capped at the
200 tasks with the most work, with `truncated` and `taskCount` as `/tasks` does. Totals are computed
over all tasks, not over the rows kept. The provider facet does not apply because step timing has no
provider; when it is set the tab says it was ignored.

**Population and units.** Fetch task timing at each task's `completedAt`, never the live clock.
Query the entire task history for costs and form waits; do not apply the invocation-window filter
on this tab. Join recap invocations through `coalesce(task_step_id, summary_for_step_id)` before
assigning categories, with unattributable legacy rows disclosed. Reuse the existing money helpers
so legacy reported costs and immutable snapshots retain their current semantics. A missing
snapshot alone does not prove missing cost: count coverage by the helper's priced/unpriced result.
Use bounded batches for task-id queries and paginate display rows without changing totals.
`computeWorkByCategory` must share the task-wide park suppression in `computeTaskTiming`; summing
raw per-step contributions is not an alternative implementation. All category work is elapsed
step work, not pure model time, and can overlap the test phase. Name the tile “Workflow work”
with that explanation; agent-hours is the separate summed invocation time.

**`modules/statistics/src/web/stats-page.tsx`**: tab `report`, labelled "Time & cost report", after
Time & throughput, fetched only when opened.

- Tile row: Tasks completed; Test phase; Workflow work (agent-hours as hint); Human active; Waiting for a
  person; Billed; At API rates (`≥` when a lower bound).
- One `StackedShareBar` of work by category, with the category colours checked by the `dataviz`
  validator against `#0a0a0a`. Colour binds to the category. Text uses `neutral-400` or lighter.
- A table with Task (link), Repository, Test phase, Workflow work, Human active, Waiting, Billed, At API
  rates.
- A figure that was not measured renders as an em dash; a measured zero stays zero. Test phase
  is elapsed step work, including setup and skipped commands, and must not imply a test executed.
  Show command execution coverage separately: before PR 2 use persisted check outcomes where
  available, otherwise “execution not recorded”; after PR 2 distinguish no rows, `not_run`, and
  actual test runs. A nonzero test-phase span with no test command is labelled “not run”.
- A short "What these figures cover" note: test commands run by agents are in Implementation, the
  human figure counts only time on a waiting form, and tab totals differ from Money by population.

**Task page Total time card** (`tasks/[id]/page.tsx`): one `tests` cell after `work`, from
`computeWorkByCategory`, with the "part of work" meaning in its tooltip.

**`docs/architecture/statistics.md`**: a section for the tab, its population and its definitions.

Verify:

- `computeWorkByCategory` values sum to `computeTaskTiming().workMs`, including a task with open
  pre-run parks, retries and carried time.
- Wait pairing covers auto-submit, re-park, no submit, and two rounds of one step.
- Live, for one window: tab work, active and task count equal `/summary` `time.workMs`,
  `time.userActiveMs` and `tasks.completed` exactly.
- Live, for three tasks: billed and notional equal the task page provider card. Any difference must
  be explained by runs with no step attribution, then either fixed or disclosed on the tab.
- Browser check of the tab at 1600 px and 900 px with no horizontal overflow, plus an empty window.

## PR 2: record each check run

Additive. Rollback: revert the code and leave the table, which nothing else reads. If the feature is
dropped, remove it with a later numbered migration. Never edit an applied one.

**Migration** (next free number, `0224` at time of writing), guarded with `IF NOT EXISTS`, and a new
schema file beside `custom-tools.ts`:

`task_check_runs`: `id`, `task_id` (cascade), `task_step_id` (set null), `step_id`, `slot` (`test`,
`lint`, `php_lint`, `typecheck`), `outcome` (`running`, `passed`, `failed`, `not_run`,
`interrupted`), `started_at`, nullable `ended_at`, and an attempt/check identity unique within
its task/step/slot. Use text plus validated values if rollback without enum changes matters.
Indexed on `task_id`. No command text or output, matching `custom_tool_calls`.

**Worker**: `recordCheckRun` in a new `_check-runs.ts`. A failed insert logs a warning and never
fails the step. Start it before each test, lint, php lint and typecheck slot in `apply` of
`08-phase-5-verify.ts`; finalize after `classifyTestEnvFailure` so an environment stop records
`not_run`. Do the same around the selective run in `08b-test-management.ts`. A skipped slot records nothing. Insert a running record before executing a command and
finalize it in `finally`, with nullable `ended_at` and an explicit `running` / `interrupted`
outcome in addition to the outcomes above. An abrupt worker death leaves a running record,
which the UI calls incomplete, never passed or zero-duration. Use an attempt/run identity so a
replayed apply cannot duplicate a completed check; a deliberate retry writes a new attempt.
Store environment `not_run` separately from genuine test failures. Never include `not_run`,
`running` or `interrupted` in the pass-share denominator; report those counts beside it. Check active tasks before the worker reloads, since a
restart can reap live CLIs.

**Report**: `testSuiteMs`, run count and pass share via `sampledRatio`, from rows with slot `test`
only. New tile "Test suite runs" and a table column. Rows before this PR have no data, so the column
is a dash and the tile states the date recording began. The task page cell gains the suite time in
its tooltip. A known measured zero is zero; incomplete records have no duration. Recording-start
coverage comes from a durable feature/version marker, not the earliest surviving row, which may
belong to a repository later deleted.

Verify: a unit test per slot and outcome; an insert failure does not fail the step; a real task with
a detected test command writes one row per slot per round, with a duration within a few seconds of
the step's own span; a retried step keeps the earlier attempt's rows; `schema-parity` passes.

## PR 3: make the human figure trustworthy

Web only. Rollback: revert the PR. Existing rows are unchanged, so figures from before and after it
are not strictly comparable, which the tab's note states.

- Relabel "Waiting on you" on the Time tab to "Idle", because 10,544 h of idle cannot be read as
  people. Correct the "time waiting on the user" comment on `TaskTiming.idleMs`.
- Idle detection for `useUserActiveTimer` is delivered by `human-time-idle-detection` PR 1. Add its
  rule to the "What these figures cover" note once both have shipped.

Verify: the Time tab shows the new label and the comment matches what `idle_ms` holds.

## Critical files

- `packages/shared/src/step-engine/timing.ts`
- `packages/shared/src/stats/`
- `modules/statistics/src/routes.ts`, `modules/statistics/src/web/stats-page.tsx`,
  `modules/statistics/src/web/api.ts`
- `packages/web/src/app/(app)/tasks/[id]/page.tsx`
- `packages/worker/src/step-engine/steps/workflow/08-phase-5-verify.ts`, `08b-test-management.ts`
- `packages/database/migrations/`, `packages/database/src/schema/`
- `docs/architecture/statistics.md`
