# Effort estimation

`00b-estimate` estimates active agent work plus user-active review time, excluding idle and
queue waiting. `_estimate.ts` uses the same `computeTaskTiming` as the completion verdict,
capping a completed task's timing at its own `completedAt`. Prior AI estimates remain separate
from the user's confirmed estimate; calibration compares the AI value with measured effort.

**Execution path is part of comparability.** `quick_bugfix`, `plan_tasklist` and
`full_workflow` perform different amounts of planning and review. All have task type
`workflow`, so filtering by that type only excludes onboarding and other non-workflow tasks.

For a known path, `buildAnchors` takes same-path plan/semantic matches first, then newest
same-path completed runs. It queries those runs separately: sorting only a mixed set of the
latest 30 tasks would leave older bugfixes unreachable. Within the path, plan proximity and
semantic ordering remain useful scope signals. Anchors with no measurable effort do not count.
Plan and semantic retrieval prioritize the current path before applying measured-anchor
budgets, so older relevant matches cannot be crowded out by other paths. Plan retrieval
returns the full ordered candidate set for batched task lookup and timing hydration. Task-id
lookups use bounded IN clauses so large plan histories cannot exceed PostgreSQL's bind-parameter
limit; lookup batches preserve the candidate order. Preferred timing hydration uses the same
500-candidate batch size independently of the 30-anchor output cap, so mostly unmeasured large
plans do not require a database round trip per 30 candidates. Semantic retrieval
resolves eligible completed same-path task ids from Postgres and binds that set into the
vector query, streams fixed 500-candidate cursor batches independently of the remaining anchor budget,
and measures results using the same timing calculation as hydration. Ranking uses the exact
`cosine_distance` function rather than an HNSW distance-operator scan: an approximate index scan
can return a short page before history is exhausted ([pgvector troubleshooting](https://github.com/pgvector/pgvector#why-are-there-less-results-for-a-query-after-adding-an-hnsw-index)).
The cursor sorts once for each execution-path tier and closes early when the measured output
budget is filled, avoiding repeated exact scans and sorts for OFFSET pages. It truncates measured
results to the requested budget while preserving cosine order,
then tops up with measured matches on other paths when needed. This also works with external RAG
stores and existing task embeddings, which contain no execution-path metadata.
The same-path query pages past unmeasured rows until three usable runs are found or history
is exhausted; a full page of completed tasks must not force a mixed-path fallback. Each page
has a stable completion-time/id order and deduplicates tasks already supplied by retrieval.
With at least `MIN_PATH_ANCHORS` (3) local measurements, the anchor set uses that path alone;
with fewer, matching runs lead the broader-history fallback. The total budget remains 30.
An unknown path retains the previous plan/semantic/newest selection.
Every anchor budget is applied to measured runs, including preferred file-overlap candidates,
broader local fallback, and cross-repository history. Preferred candidates are hydrated in
batches and database queries scan 500-candidate pages until their usable budget is filled or
history is exhausted; this also applies to same-path recency, broader local, and cold-start scans.
Unmeasured rows never hide later usable history. Broader local history is exhausted before
falling back to other repositories.

**Do not scale a same-path baseline twice.** The heuristic and p20/p80 band use the local
same-path measurements when there are at least three; otherwise they use three or more
same-path measurements including cold-start anchors if available. Their measured effort
already includes that path's work, so no path multiplier applies. When same-path history is
sparse, the broader-history median and band retain the existing path multiplier (0.5 / 1 / 1.5),
and the baseline explanation names that fallback. With no usable history, the per-path constants
remain 0.5 / 2 / 6 hours. The band still requires at least three measurements and non-equal bounds.

**Calibration must describe the current path.** `computeBiasFactor` uses only local
same-path AI-estimate/actual pairs for a known path, requiring two. With fewer pairs it emits
no correction hint; a different path's tendency to underestimate review work must not correct a
bugfix estimate. An unknown path retains local mixed-path calibration. Ratios are clamped to
0.25..4 and only material bias (outside 0.85..1.15) is shown in the prompt. Bias and the fallback
baseline are recomputed from anchors when reading persisted detect output, so a replay does not
reuse the old mixed-path correction or apply a path multiplier twice.

Cross-repository anchors remain scoped to the same user and framework and are only fetched
when fewer than three usable local anchors exist. The cold-start query prefers the current
path; other paths may fill sparse history. These anchors remain labelled as weaker evidence,
and cannot drive local calibration or file-overlap refinement. The AI prompt explicitly prefers
same-path tasks with similar scope and asks it to explain sparse-history fallback.

`06b-sprint-planning` refines the AI estimate from predicted file overlaps. Its candidate query
orders same-path overlapping tasks first, then overlap and recency, so the 30-anchor budget does
not exclude them. With two measured local same-path overlaps, refinement uses their median;
otherwise it retains the broader file-overlap fallback. The confirmed user estimate is unchanged.

The sample thresholds are conservative implementation choices, not measured accuracy gains.
Historical evaluation must use only runs completed before the task's estimate, report error by
path and disclose sample counts. Replaying deterministic baselines does not measure the AI's
response to the changed prompt. Regression coverage lives in `_estimate.test.ts` and
`00b-estimate.test.ts`, with semantic retrieval covered in `_task-embedding.test.ts`.
