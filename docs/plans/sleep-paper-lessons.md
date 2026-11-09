# What the SLEEP paper offers Haive: calibrate on the model's own estimate, keep every learning reachable

> **Not started** (2026-11-09). One source is reviewed: "Language Models Need Sleep: Learning to
> Self-Modify and Consolidate Memories" (arXiv:2606.03979v2) and its Google Research blog post of
> 2026-10-27. Verdict: no port, because the paper edits model weights and Haive drives hosted CLIs.
> Two small fixes carry over (PR 1 and PR 2). A backtest is deferred until real data exists (P3).
> Nothing here is proven to improve accuracy: see "What the data can and cannot say". Keep this file
> current by editing the section a change belongs to.

## Context

The user asked what Haive could take from the paper, and pointed at the effort-estimate learning as
a candidate. Every Haive claim below was read on `main` `6db2742dd` on 2026-11-09. Every number was
measured on the dev install that day, read-only. Line numbers are hints; resolve by symbol.

## The source

SLEEP alternates learning with two offline stages on small models (Llama-3B/8B, Qwen3-1.7B/8B). The
blog gives no compute cost and no limitations section.

- **Consolidation** adds low-rank experts (LoRA, distillation) and resets high-frequency parameters.
  It treats forgetting as a shortage of capacity: add room rather than overwrite. A base-weight
  update is computed but not applied until consolidation finishes.
- **Dreaming** runs fine-tuning on isolated model copies and keeps one only if a downstream score
  improves (Eq. 5). It is the paper's largest effect: removing it drops the single-passage score
  from 48.1 to 35.7. Removing random expert activation or gradient selection moves that score by
  about one point.
- Sleep triggers on a step count ("divisible by C").

Haive owns no weights, so only the principles can carry over. Tested against Haive:

| Principle | Haive analog | Result |
| --- | --- | --- |
| Do not apply an update before it is consolidated | 06b overwrites the number 00b calibrates on | Real defect: PR 1 |
| Forgetting is a capacity shortage | Step 11 hides learnings past 60 | Real defect: PR 2 |
| Add capacity per regime | Per-model estimate factor | Rejected, below |
| Keep an update only if it scores better | Gate the bias correction on past error | Rejected, below |
| Dreaming (synthetic rehearsal) | Self-invented validation scenarios | Rejected: needs a downstream score Haive lacks; `11e-prompt-guidance` header already records why |
| Random selection of experts | None | Rejected: about one point in the paper's own ablation |
| Consolidate every C steps | Scheduled learnings cleanup | Parked: 0 of 70 learning runs deleted anything, repositories too fresh to judge |

## What the data can and cannot say

The corpus cannot evaluate per-repository loops. 124 of 141 completed workflow tasks are two
benchmark jobs ("Add README" 64, "Add DDEV" 60), no repository has more than 3 completed tasks, and
none ran after August 2026. Read every row below as "no evidence to build", not "cannot work".

Estimator coverage: 126 usable runs (122 LLM, 4 heuristic). 82 of 151 runs had no anchors and none
had 3 local anchors. The bias hint was shown in 2 of 126. The LLM lands within 2x of actual about
29% of the time (n=122), median miss 3.2x. 00b costs 0.1% of the tokens on those tasks, so it is not worth
optimizing for cost.

Change in mean absolute log error, 95% paired cluster bootstrap, negative is better:

| Variant | Against | n | Delta |
| --- | --- | --- | --- |
| Correction learned from other task kinds | raw LLM | 83 | +0.82 [0.69, 0.95] |
| Per-model multiplier learned on the other task kind | pooled factor | 90 | +0.23 [0.02, 0.56] |
| Same kind, same model (leave-one-out, an upper bound) | pooled factor | 97 | -0.15 [-0.51, 0.07] |
| Accept a good correction only if it beat raw on earlier tasks | ungated -0.49 | 71 | +0.06 [-0.13, 0.25] |
| Same gate on a bad correction | ungated +0.82 | 83 | 0.00, accepted 0 of 83 |
| Same-path pooled factor | raw LLM | 71 | -0.49 [-0.76, -0.24] |
| Fixed constant per path | raw LLM | 122 | -0.25 [-0.33, -0.16] |

The last two look like wins and are not recommended: with two benchmark jobs, same path nearly means
same task, so they memorize the job. Identical tasks vary 18x (README) to 65x (DDEV) in effort by
model, which is why a per-model factor was the leading idea, but model scale does not carry between
tasks (README vs DDEV, Spearman -0.27, p=0.45, 10 models). No run had 3 earlier same-path same-model
runs, so that variant cannot be tested prequentially yet.

## PR 1: calibrate on the LLM's own estimate

**Defect.** `refineEstimateFromPlan` (06b-sprint-planning.ts) overwrites
`tasks.ai_estimated_time_hours` with the median effort of file-overlapping tasks. `hydrateAnchors`
(`_estimate.ts`) reads that column as `aiEstimateHours`, which feeds `computeBiasFactor` and the
"(AI predicted Xh)" anchor line in 00b's prompt. The hint speaks to the LLM about the LLM's own
numbers, but a refined pair measures a median against actuals, which pulls the bias toward 1 and
under-corrects. The one refined task here: LLM 6.5h, refined 2.92h, actual 1.92h. The column says
0.66x, the true ratio is 0.30x. Refinement needs `MIN_OVERLAP_ANCHORS` (2), so the repositories with
the deepest history are hit most. It fired once in 152 estimates here, so the gain is unmeasured.

The 06b comment admits the overwrite. The 00b header, `EstimationDatum.aiEstimatedHours` and
`effort-estimation.md` describe the column as raw or say nothing of it.

**Source of truth.** Every 00b apply already writes event `estimate.recorded` with `payload.aiHours`.
Reading it needs no migration and corrects past tasks at once. A new column was rejected: a migration
plus a backfill from these same events, for the same result.

Events are durable enough: `_step-reset.ts` leaves `task_events` alone, and the three delete sites
(branch-revert, stalled-redrive, upgrade apply) remove other event types.

**Rule.** The estimate of a task is `aiHours` of its LATEST `estimate.recorded` event, because a 00b
Retry rewrites the column and writes another event (1 task here has two). If that value is not a
positive finite number, or the task has no event, use the column as today.

**Changes.**

- `packages/shared/src/schemas/tasks.ts`: `ESTIMATE_RECORDED_EVENT`, beside the other shared event
  types. 00b's insert uses it.
- `packages/shared/src/step-engine/estimation-accuracy.ts`: pure
  `recordedEstimateHours(events: { taskId; payload; createdAt }[]): Map<string, number>` applying the
  rule above. One home, since worker and api both need it. It compares `createdAt` itself, so
  callers need not sort.
- `hydrateAnchors` (`_estimate.ts`): query `task_events` for the batch's priors with a non-null
  column, then `aiEstimateHours: recorded.get(p.id) ?? p.aiEstimatedTimeHours ?? null`. This is the
  single mapping, so local, cross-repo and 06b anchors are all covered. 00b writes the column before
  the event, so a null column has no event; the filter skips the query for history with no estimates
  and leaves existing `buildAnchors` mocks untouched. The batch is already bounded by
  `HISTORY_BATCH_SIZE`, and `task_events_task_id_idx` serves the lookup.
- `GET /tasks/estimation-accuracy` (api `routes/tasks/index.ts`): same lookup,
  `aiEstimatedHours: recorded.get(t.id) ?? t.aiEstimatedTimeHours ?? 0`. Its `medianBiasFactor` is
  documented as calibration and must agree with the hint.
- Comments: state the real meaning of the column wherever it is called raw or the AI's own
  (00b header, `estimation-accuracy.ts` header and field, the verdict card in web `tasks/[id]/page.tsx`).
- `effort-estimation.md`: in the 06b paragraph, say calibration and the accuracy report read the
  recorded event, and why.

**Not changed.**

- 06b keeps writing the column. The verdict card and the pace chip's budget fallback want the
  sharpest current number, so for a refined task the card and the accuracy report differ, by design.
- `source: 'heuristic'` events (4 of 126) count as today. The number is unchanged by this PR, so
  separating them is its own decision.
- A step detected before the deploy keeps its persisted anchors for that one run.

**Tests, written first.** In `estimation-accuracy.test.ts`: latest of two events wins regardless of
input order; a string, zero, NaN or missing `aiHours` yields no entry, including when an older event
was valid. In `_estimate.test.ts`, with `query.taskEvents` on the mock: a prior with column 2.92 and
event 6.5 yields anchor 6.5, and two such anchors drive `computeBiasFactor` from 6.5; no event keeps
the column; a null column issues no event query; a cross-repo anchor gets its event too. In the 06b
tests, if the harness reaches it: the column is still overwritten and the `estimate.refined` payload
is unchanged.

**Rollback.** Revert the commit. Reads only; no schema, config or data change, so nothing to undo.

## PR 2: every learning stays reachable past 60

Low urgency: take it when step 11 is next touched, or when a repository nears 60 learnings (largest
here is 29; at about 3.5 per run the cap arrives near 17 tasks).

**Defect.** `detect` in 11-phase-8-learning.ts takes `.slice(0, 60)` of `readExistingLearnings`,
whose order is an unsorted `readdir` (`readdirNoFollow`). Past 60, the agent sees an arbitrary subset,
cannot update or delete the rest, and writes duplicates. No data is lost: `planLearningReconciliation`
gets the full list, so `resolveInsertId` still avoids every taken id.

**Same class, one line down.** `existingSkills` takes `.slice(0, 60)` of a sorted list, so the
alphabetical tail can never be chosen as a `skillId`. It gets the same treatment.

**Changes.**

- Sort learnings by id with a plain code-unit comparison in `detect`, so a retry sees the same list.
- List every entry up to `LEARNING_INDEX_MAX` (500, a judgement that bounds a prompt fed by files in
  the repository). The first 60 keep their excerpt, the rest carry `excerpt: ''`. Skills likewise
  blank `description` past 60.
- Build-time rendering, because `detect_output` is persisted
  ([Prompt containment](../architecture/prompt-containment.md), "FILTER AND FENCE AT PROMPT-BUILD
  TIME"): filter ids with `isListableName`, `collapseToLine` titles and excerpts, render
  `- id — title` when there is no excerpt, and say how many entries were left out. Today's lines are
  neither filtered nor collapsed and an excerpt may span lines; listing every entry would widen that.
- Outside the data, one instruction: an entry with no excerpt must be opened at
  `.haive-data/learnings/<id>.md` (`haiveDataBoundary` keeps it mounted) before an `update` or `delete`
  names it, since an update replaces the whole body. A person still reviews the diff at the form.

**Not changed.** `learningExcerpt`'s 200 characters, the reconciliation and apply paths.

**Tests, written first.** In `11-phase-8-learning.test.ts`: 61 and 501 entries list the expected ids
and the omission count; order is stable across shuffled input; only the first 60 have excerpts; an id
with a line break is left out and counted; a multi-line excerpt renders on one line; the prompt holds
the open-before-update instruction only when a title-only entry exists; a persisted `detect_output`
with excerpts on every row renders as before.

**Rollback.** Revert the commit. Prompt text only.

## P3: re-run the backtest on real data

Do not build anything from this section until the trigger fires. Nothing fires it today:

```sql
SELECT count(*) FILTER (WHERE n >= 20) AS repos_ready, max(n) AS largest
FROM (SELECT t.repository_id, count(DISTINCT t.id) AS n
      FROM tasks t JOIN task_events e ON e.task_id = t.id AND e.event_type = 'estimate.recorded'
      WHERE t.type::text = 'workflow' AND t.status::text = 'completed'
        AND t.repository_id IS NOT NULL AND t.title NOT IN ('Add README', 'Add DDEV')
      GROUP BY 1) x;
-- 2026-11-09: repos_ready 0, largest 1. The threshold of 20 is a judgement.
```

The 2026-11-09 script was session scratch and is not kept. Method to rebuild it:

- Metric: `ALE = |ln(predicted / actual)|` and the within-2x share. Actual is effort,
  `(work + user-active) / 3.6e6` from `computeTaskTiming` capped at `completedAt`. Predicted is the
  latest `estimate.recorded.aiHours`.
- Prequential: a correction for a task learns only from tasks whose `completedAt` precedes that
  task's `estimate.recorded`, as `effort-estimation.md` requires. Report by path, with sample counts.
- Interval: paired cluster bootstrap on the delta of mean ALE, 4000 resamples, seeded, clustered by
  repository, and by model for model variants.
- This scores deterministic corrections only. It cannot measure how the LLM responds to a changed
  hint; that needs live runs.

It answers: does the bias hint help (the 06b change included), does a same-path same-model factor
beat pooled once runs have 3 earlier matches, and does a scheduled learnings cleanup have anything to
clean. `model_identity` is set on only 11 of 128 tasks, so a per-model study must join
`cli_invocations`.

## Steps

1. Before saving worker source: check no CLI run is in flight on the dev stack (a tsx reload of the
   worker kills it): `cli_invocations` with `started_at` set, `ended_at` and `superseded_at` null.
2. PR 1, then PR 2 when its condition holds. Each: tests first, then code, then its docs.
3. After PR 1, update memories `project_task_time_estimation` and `sleep_paper_assessment`.

## Verification

- `pnpm --filter @haive/shared test estimation-accuracy`, `pnpm --filter @haive/worker test _estimate 00b-estimate`
  (PR 2: `11-phase-8-learning` and `prompt-agent-paths`), then the full suites of both packages.
- `pnpm --filter @haive/api test` for the route, `pnpm typecheck`, `pnpm format:check`.
- PR 1 on the dev database: the task with an `estimate.refined` event must show its first estimate,
  not the column, in `GET /tasks/estimation-accuracy`.
