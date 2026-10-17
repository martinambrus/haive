# What Parsimony offers Haive: measured change size, and the statistics to read it

> **Not started** 2026-10-17. Five findings from Parsimony (parsimony.lasu.dev,
> github.com/La5u/Parsimony), turned into phases. Nothing is approved; one decision is made: the
> counter parses with tree-sitter (2026-10-17). P0 gates everything else: without a counter there is
> no number for any later phase to read.

## Context

Parsimony asks "which AI coding agent changes the least code?". It takes the patches SWE-bench
already publishes, applies each one in memory at the task's `base_commit`, parses both sides of every
changed implementation file with Python's `ast`, and counts **coding units**: statements, expressions,
comparisons, names and literals, plus one `EndBlock` per statement block so that nesting counts.
Punctuation, comments, formatting and name length do not count. The headline is
`net_units = added − deleted`, with `churn = added + deleted` beside it, and it counts only on tasks
the benchmark marked resolved. Its own caveats matter as much as the metric:

- Smaller is not always better. Units measure size, not readability or design.
- Models that write more code also solve more tasks (Spearman 0.33–0.60 on boards with 26+ models).
- The harness changes the number: GPT-5.6 Sol through the author's own harness added 0.88× the code
  of its published run.
- A model whose fixes mostly delete code can rank first with a negative net.

Two things stop us copying the tool itself:

- **It is Python-only.** Haive's repositories are mostly PHP (Drupal) and TypeScript. No package in
  the workspace depends on tree-sitter or any other multi-language parser (checked 2026-10-17 across
  `packages/*/package.json` and `modules/*/package.json`).
- **Its data is a benchmark, and ours is not.** In SWE-bench every model solves the same 500 tasks.
  Every Haive task is unique, so a ranking across models mixes up the model with the task it got.

What Haive already has in this area: `07a-code-simplify` (a simplifier agent, then one fixup agent if
files changed, gated on `tasks.simplify_code`), a simplicity lens in 08c review
(`docs/architecture/review-dimensions.md`), and a statistics module that reports spend, tokens, tool
usage and throughput per step and per served model (`docs/architecture/statistics.md`). **Nothing
records how big a change was.** The nearest thing, `10-gate-3-commit`, shows `git diff --stat HEAD`
as text in the approval summary and counts changed files for the diff viewer, but counts no lines
or units and keeps no size per step or model.

## Findings and phases

| # | Finding | Phase |
|---|---------|-------|
| 1 | We cannot say whether `07a-code-simplify` shrinks code, or how often its fixup has to put behaviour back | P0 |
| 3 | How to count: syntax units with null-on-parse-failure and an implementation-only scope, not lines | P0 (the counter's design) |
| 2 | Change size per step and per CLI/model belongs in statistics, read only on tasks that succeeded | P1 |
| 4 | The statistics rules (medians, explicit failures, paired comparison, size never ranks alone) apply to the numbers Haive already shows | P2 |
| 5 | A fair comparison across models needs the same task replayed by each | P3 |

Finding 3 is the counter's design rather than a phase of its own: P0 cannot be built without it, and
nothing else uses it first.

## P0 — A change-size counter, and 07a measured before and after

**Goal.** Answer one open question with data: does `07a-code-simplify` make the change smaller, and
what does it cost? Today the per-task toggle is on or off with no evidence either way.

**The counter (finding 3).** A pure function in `@haive/shared` (no IO, so it is unit-testable and
both worker and statistics can import it):

- Input: the base and head text of each changed file, plus its path.
- Output per file: `{ added, deleted, net, churn, structuralChurn } | null`, and a set total.
- **Units, not lines.** Count statements, expressions, comparisons, names and literals, and one
  `EndBlock` per block, so formatting churn scores zero and moving code in or out of a block does
  not. A renamed identifier or a changed literal is one changed unit. `structuralChurn` ignores
  identifier and literal values, which separates "renamed things" from "added logic".
- **Alignment** by a minimum edit script over the unit sequence (Myers). Above an edit budget, fall
  back to a line-anchored approximation and set a flag on the result. Never return a silently wrong
  exact number.
- **A file that fails to parse on either side is `null`, never 0.** The set total carries how many
  files were null, so a reader can see the hole.
- **Scope** is implementation code only. Reuse the scope `_impl-changes.ts` already applies
  (`collectImplementationFiles` / `collectChangeSet`), and add exclusions for tests, docs, generated
  files, lockfiles and vendored or build output. List the touched and excluded paths in the result,
  as Parsimony does, so a wrong exclusion can be seen.
- **Parser: tree-sitter** (decided with the user 2026-10-17). `web-tree-sitter` with WASM grammars
  for PHP, TypeScript/JavaScript and Python, so no native build in the images. A
  `git diff --numstat` line count was the cheaper alternative and was rejected: lines count
  formatting, so a line count of the simplifier's output would mostly measure reformatting, and that
  is the question P0 must answer. A language with no loaded grammar yields `null` per file, by the
  parse-failure rule above. Adding the dependency follows the lockfile-only route, then
  `pnpm docker rebuild` with no service.

**Where it is measured.** On the worker host, against the integration worktree (git is unavailable
in the sandbox, so this cannot run inside it):

1. When `07a-code-simplify` detects: the size of the implementation diff against the task's base
   (`before`).
2. After the simplifier pass: `afterSimplify`.
3. After the fixup pass, if it ran: `afterFixup`.

Store these in the step's `output` (`task_steps.output`, jsonb), not in a new column. That needs no
migration, and P0 is a question, not a feature yet.

**Check.**
- Unit tests for the counter: per-language fixtures, including the `has_negative` pair from the
  Parsimony page (the loop and the one-liner must differ by the expected count), a formatting-only
  change that scores 0, a parse failure that yields `null`, and an excluded test file.
- A step test that runs `07a`'s detect/apply against a fixture worktree and asserts all three sizes
  land in `output`.
- After merge, one real workflow task with `simplify_code` on, with the three numbers read from the
  row.

**Decision this phase feeds.** After enough tasks (say 20 with simplify on), report the median
`afterSimplify − before`, the share of tasks where the fixup restored units, and the agent spend of
`07a`. That decides whether `simplify_code` stays a default, becomes opt-in, or gets a narrower
prompt. Not decided here.

**Rollback.** The counter is a new pure module, and the measurement writes extra keys into an
existing jsonb output that nothing else reads. Reverting the commit removes both. Rows already
written keep the extra keys harmlessly.

## P1 — Change size per step and per model in statistics

**Goal.** Show, per CLI and served model, how much code the implementation steps add, read only on
tasks that reached a clean end.

- Measure the implementation diff at the end of `07-phase-2-implement` (single-agent) and per DAG
  issue in `06c-dag-execute`, with the counter from P0, and store it beside the step's
  `model_identity`.
- **The success gate.** Count a task's numbers only when it passed gate 3 (`10-gate-3-commit`) and
  was not reverted. Parsimony counts only resolved tasks; a failed attempt that changed nothing would
  otherwise drag every median toward zero.
- **Storage.** A statistics query over jsonb `output` is fine for a first view. If a query proves
  slow, move to a column through a numbered migration (`ADD COLUMN IF NOT EXISTS`, declared last in
  the Drizzle table), as AGENTS.md requires. Decide at build time on the measured query, not now.
- **The view.** A ranked bar list in `modules/statistics` of median `net` and `churn` per
  CLI × served model, with the sample count on every bar and fix-loop rounds beside it. **Never size
  alone** (see P2). Haive runs the same model through several CLIs, so the harness effect Parsimony
  measured (0.88×) should show up here directly.
- Fix-loop rounds re-enter `07`. Measure the final diff the task committed, and record the per-round
  sizes only as a diagnostic, so rounds do not add up into a false total.

**Check.** Unit tests for the aggregation (`@haive/shared/stats`, where the existing summaries live);
an api route test; a browser check of the new chart at desktop, tablet and phone widths, logged in,
with real rows from the dev install.

**Rollback.** Additive: a measurement in two steps, an aggregation function, a route, a chart.
Reverting removes them. A migration, if one is needed, adds a nullable column only, and the undo is
to stop reading it; dropping it is a later, separate change.

## P2 — Statistics rules for the numbers Haive already shows

Parsimony's discipline, applied to effort estimation, spend and throughput, not only to P1:

- **Medians, not means**, for anything per task. One runaway task (a long fix loop, a big
  attachment) moves a mean and leaves a median alone. Audit `modules/statistics` and `_estimate.ts`
  for means over per-task values and switch those that report "typical" cost or time.
- **A failure needs explicit evidence.** A task missing a row or a log is `unknown`, never `failed`,
  and never 0. Audit the aggregations in `@haive/shared/stats` for a missing value read as 0.
- **Sample size on every number.** Every median shown carries its n. Below a threshold (say 5), grey
  it out rather than hide it.
- **Size never ranks alone.** Wherever P1's sizes appear, an outcome measure stands next to them
  (fix-loop rounds, open review findings at gate 3). Parsimony found size and success move together
  (Spearman 0.33–0.60), so "writes least" alone can mean "solves least".
- **Comparisons across models are labelled as unpaired** until P3 exists: different models got
  different tasks.

**Check.** Each switch comes with a unit test on a fixture holding one outlier, asserting the shown
value is the median and the n is right. Browser check of every changed chart.

**Rollback.** Display and aggregation changes only, no stored data changes. Revert the commit.

## P3 — Same-task replay for a fair comparison across models

The only fair way to say "CLI/model A writes tighter code than B" is to give both the same task.
Parsimony gets that for free from a benchmark, and Haive has to build it.

- Take finished tasks whose gate-3 commit is known good. Replay the implementation step from the
  same base commit, spec and plan with another CLI/model, in a throwaway worktree, and measure with
  the P0 counter. The untracked review-corpus harvester under `packages/worker/tmp/` (golden replay)
  is the nearest existing piece, and may be the base.
- Compare **paired**: per task, model B's size against model A's. Report the median of the paired
  differences with a paired-task bootstrap interval, as Parsimony's `sensitivity` command does.
- Correctness for a replay comes from the repository's own verify commands, run as the workflow's
  checks run them. A replay that fails its checks counts as a failure with evidence; one that could
  not run is `unknown` (P2's rule).
- **Cost is the reason this is last.** Every replay is a full implementation run. Size it before
  building it: N tasks × M models × the median `07` spend from statistics. Approval is owed on that
  number.

**Check.** A replay of one task by two models, both measured, with the paired difference and its
interval shown. A bootstrap unit test with a fixed seed.

**Rollback.** Replays run in throwaway worktrees and write to their own table or files. Nothing in
the live workflow reads them. Revert the commit and delete the replay rows.

## Not taken

- **Model-to-human ratio.** Parsimony divides model churn by the human patch's churn. Haive has no
  human reference patch for a task.
- **Percentiles against a frozen panel** (Parsimony's archived score). Too few Haive tasks per
  model for a stable panel.
- **Parsimony's own leaderboard as model-choice input.** It is SWE-bench Python through
  mini-SWE-agent, not Haive's CLIs or repositories.

## Not verified

- Parsimony was read from its front page and `docs/method.md` only, not its code. The repository's
  license is not stated in `method.md`, so no code is copied until it is checked.
- Whether `web-tree-sitter` grammars load cleanly in the worker image is not measured.
