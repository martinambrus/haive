# Step benchmark suite: models and efforts measured through Haive, one step at a time

> **Not started** 2026-10-20. Written on a machine with almost nothing onboarded, so every token
> number this plan needs is a step to run, not a figure stated here. P0 (token estimates) runs first
> on the machine that holds the earlier benchmark tasks, and its numbers gate the scope of P1-P5.
> Decided with the owner 2026-10-20: no end-to-end benchmark, k=2 by default, an easy modern
> fixture repository instead of the 2008 one, no DDEV task (a micro DDEV fixture at most, see P3).

## Context

The benchmarks in `benchmarks/` (README, onboarding and full-workflow comparisons from 2026-07 to
2026-09) ran whole tasks end to end on one 2008 PHP repository: a README task, a full onboarding
with KB generation, and a DDEV task. Four problems make them unfit to compare models:

- **Too slow and too expensive to repeat.** Even the README task, run as a bugfix workflow, goes
  through many steps and takes hours. Monthly subscriptions run out of 5-hour and weekly allowances
  long before a matrix completes.
- **No noise baseline.** Each configuration ran once. Re-runs gave different output, sometimes very
  different, so a difference between two models cannot be told apart from the difference between two
  runs of one model.
- **Uneven samples.** Steps that repeat inside a run (fix-loop rounds, per-topic mining) got several
  samples; most steps got one.
- **Compounding variance.** A step's input is the previous steps' output. Two runs that diverge at
  step 2 feed different inputs to every later step, so a later step's comparison measures the chain,
  not the model.
- **The 2008 repository cost most of its time on outdated dependencies.** That is environment pain,
  not model skill, and it spends tokens without separating models.

What the owner wants measured: **models and effort levels running inside Haive** — the real step
code, CLI adapter, sandbox, agent rules and retrieval — not models on arbitrary prompts. A result is
"model M at effort E does step S this well, through Haive".

## Approach

Benchmark single LLM steps on **frozen inputs**. A fixture holds everything one step reads when its
`llm` phase, or one of its mining agents, is dispatched. A runner restores the fixture, runs only
that dispatch (and `apply`, where the output is files), grades the result, and records it. Upstream variance cannot reach the
step, one run takes minutes, and the matrix can be sized to a weekly allowance.

What exists to build on:

- `task_steps.detect_output` and `task_steps.output` (`packages/database/src/schema/tasks.ts`),
  `cli_invocations.prompt`, `dispatch_prompt`, `token_usage`, `cost`, `model_identity`,
  `duration_ms`.
- `cli_invocations.effort` (jsonb `{ level, source }`) records the effort that actually reached
  the CLI and where it came from (`step`, `provider`, `scale_max`, `dropped`, `none`); NULL on
  legacy rows. `task_step_cli_choices.effort_level` holds only the current choice per (task, step,
  role), and its next write erases the history. Adapters turn the level into the CLI's own lever
  (`effortEnv`, e.g. `CLAUDE_CODE_EFFORT_LEVEL` in `cli-adapters/claude-code.ts`; codex passes
  `effort` to the app-server turn in `queues/cli-exec/exec-core.ts`).
- `CLI_DISPATCH_STEPS` (`packages/shared/src/step-engine/types.ts`) lists every step that
  dispatches a CLI, asserted against the worker registry at boot.
- `refactoring-economics-lessons` D2 proposes one replay harness for its P1 and `parsimony-lessons`
  P3. This plan's runner is a third user of the same harness: those replay a past invocation with
  a different tree or model, and this one replays a captured fixture with a different model or
  effort. Build one harness, not three.

## P0 — Token and time estimates, on the machine with the benchmark tasks

Run before anything is built. Every query reads only successful runs, by the step runner's own
predicate (`step-runner.ts`): `ended_at IS NOT NULL`, `exit_code = 0`, `trim(error_message)` null or
empty, plus `superseded_at IS NULL`. Exit code alone is not enough: a codex app-server run or a
stream without a success result can exit 0 with an error recorded, and such partial runs would
understate tokens and time. Killed runs record wrong token usage
(`refactoring-economics-lessons`, Found not fixed: the `getTokenUsage` fallback in
`queues/cli-exec/stream.ts`), so they would skew every figure.

1. **Per-step cost table.** For every step id in `CLI_DISPATCH_STEPS` that has rows: number of
   invocations, median and p80 of input, output, cache-read and cache-write tokens, `duration_ms`,
   and `cost.costUsd` (notional where `billable` is false). Group by step id, CLI provider,
   model, and effort. Model is `coalesce(model_identity.served, model_identity.requested)`, else
   `unknown`: codex `exec` records only `requested` and its app-server records `served` only on a
   reroute (`docs/architecture/cli-adapters.md`), so grouping on `served` alone would merge every
   codex model into one bucket. Effort is `unrecorded` where the `effort` column is NULL (legacy
   rows), else `effort->>'level'` together with `effort->>'source'`: a recorded null level with
   source `none` (the CLI has no knob) or `dropped` (the CLI ran its own default) is a known
   setting, not missing history. Attribute each row to its step
   by `coalesce(task_step_id, summary_for_step_id)`, the fold the statistics rollups use, so recap
   invocations count. Never join `task_step_cli_choices` for effort: it holds only the current
   choice and would relabel earlier runs.
2. **Count rows with unrecorded effort or unknown model.** Such rows stay in their own buckets,
   never guessed. If most of a step's history is unknown, that step's
   effort comparison waits for P4's own runs.
3. **Repeat counts.** Per step: invocations per task (one, a few, or fan-out). Fan-out steps (agent
   mining, DAG execute, per-topic knowledge acquisition) are benchmarked per unit (one agent, one
   topic, one issue), never whole.
4. **Allowance per token.** The subscription allowance is not published in tokens. Measure it: read
   the 5-hour and weekly usage before and after one known run and divide (the memory
   "weekly usage not visible" notes the read needs `display.externalUsageWritePath`). One ratio per
   provider subscription in use (Claude, Codex, others).
5. **Scale factor for the new fixture.** Historical numbers come from the 2008 repository and
   overstate a small fixture. After P2 exists, run each candidate step once on it at a middle effort
   and take `tokens(fixture) / median tokens(history)` per step. Until then, treat history as an
   upper bound and use it to rank steps by cost.
6. **Matrix size.** Per step: `models × efforts × fixtures × k × median tokens(step, model, effort)
   × scale factor`, k = 2 plus an expected 20% third runs (P4). Sum over steps, convert with step 4's
   ratio to weeks of allowance, and write the table into this plan's **Decided** section.

**Check.** The table covers every step that has rows; its total for one step agrees with that
step's sum on the statistics page for the same window; the allowance ratio is measured, not
assumed.

**Output.** Steps chosen for the first matrix, ranked by cost and by how much a weak result there
hurts later steps. Approval owed on the total before P4 runs.

Candidate steps, to be cut down by P0: onboarding `01-env-detect`, `06_5-agent-discovery`,
`08-knowledge-acquisition` (one topic), `09_5-skill-generation`, `10_8-plan-build` or plan-build
`01-plan-build`; workflow `00-triage`, `04-phase-0b-pre-planning`, `07-phase-2-implement`,
`08c-code-review`, `10-gate-3-commit` (message). Not benchmarked: model-health canaries,
`01e-external-kb-sync`, `01f-external-plan-sync`, `13-pr-wait`, `01a-app-boot`.

## P1 — Fixture capture and a single-step runner

- **Capture switch.** A per-task or per-step flag. At `llm` dispatch, the worker writes a fixture:
  the workspace tree (a tar through `@haive/shared/fs-safe` descriptors, or a git commit of the
  fixture repo plus a tar of the untracked `.haive/` state), `detect_output`, form values, the
  upstream outputs the step reads, the rendered prompt, the prompt hash, and a hash of the step's
  prompt-building source. Off by default; never on for user repositories without asking.
- **Runner.** `pnpm bench run --step <id> --fixture <name> --cli <provider> --effort <level> --k 2`.
  It restores the fixture into a throwaway workspace and sandbox, sets the CLI choice and effort,
  re-renders the prompt from current step code (so a result always measures Haive as it is now),
  runs the step's dispatch phase (+ `apply` when the output is files), grades it (P3), and writes
  one result row.
- **Two dispatch shapes.** Steps with `llm` run that phase once. Steps that dispatch through
  `agentMining` (`08c-code-review`, plan-build `01-plan-build`, part of `09_5-skill-generation`)
  run ONE mining agent per sample: the fixture names the agent (reviewer dimension, plan node,
  skill) and stores that agent's dispatch input, and the result row carries the agent id. The
  capture point for those is the mining dispatch, not `llm`. `dagExecute` steps are out of scope.
- **Result row.** step id, fixture, mining agent id (when any), fixture hash, prompt hash,
  step-source hash, CLI provider, requested and served model, effort level and source, CLI version, git sha, run index, tokens, cost, duration, grade breakdown,
  and the raw output. Stored apart from live tables (own table or JSONL under the repo's
  gitignored `tmp/`), so nothing in the live workflow reads it.
- **Staleness.** When a step's source hash differs from a fixture's, the runner refuses to mix new
  results with old ones and reports the fixture as stale. Re-capture is one cheap run of the
  upstream steps on the fixture repo, not a benchmark.
- **Replay at zero tokens.** Every cell and every repeat gets the same prompt, so a prompt hash
  cannot identify a response. A replay re-uses the raw output stored on one chosen result row
  (that row's id is the key) and runs `apply` and the grader on it. Grader and `apply` changes then
  re-run without any model call. Model and effort comparisons always run live.

**Check.** A fixture captured from a real run replays to an output of the same shape. The same
result row replayed twice gives a byte-identical grade. A stale fixture is refused.

**Rollback.** The switch defaults off and the runner is a separate entry point. Revert the commits
and delete the result store.

## P2 — An easy fixture repository with planted traps

Difficulty comes from reasoning, not from the environment. A small **PHP 8.3 + Composer** app
(Haive's DDEV and Drupal focus says PHP), 20-40 files, 2-3 dependencies, SQLite, installing in
seconds. Kept in its own repository so its history is clean and pinned by commit.

Planted traps, each with a written answer key, graded easy to hard so scores spread out and no
model sits at 100%:

- configuration read from an unusual place
- a file or class whose name misleads about what it does
- dead code that looks live, and a live path that looks dead
- one convention every file follows except one
- a fact visible only by reading two files together
- one real bug with a deterministic repro
- a README task whose correct content depends on three of the above

A second stack (a small Node/TypeScript app) only if P4 shows results that do not transfer.

**Check.** The answer key is complete: a hand-written ideal output scores 100%, an empty output
scores 0%, and a hand-written output that misses the two hardest traps scores in between.

## P3 — Graders, cheapest first

1. **Deterministic.** Output parses to the step's schema; files exist; `php -l` passes; tests pass;
   required sections are present; every path the output cites exists in the fixture.
2. **Answer key.** Planted-trap recall and precision; KB entries checked against the fact list;
   hallucinated facts counted.
3. **LLM judge, only for what is left** (prose quality, plan structure). Pairwise A vs B, run in both
   orders, judged by a model from another family than both contestants. No absolute 1-10 scores.

DDEV: no DDEV task. If environment setup is worth measuring, a **micro DDEV fixture** — the P2 app
with `01-env-detect`'s DDEV output graded by `ddev config` validating, `ddev start`, HTTP 200 and the
DB importing — costs one step's tokens and about a minute of `ddev start`. Include it only if P0
shows the step is cheap; otherwise drop it.

**Check.** Unit tests for each grader on fixed outputs; the pairwise judge agrees with itself when
A and B are swapped on at least 9 of 10 fixed pairs.

## P4 — Noise floor, then the matrix

1. **A/A per chosen step.** One model, one middle effort, k = 4. The spread is that step's noise
   floor. A difference smaller than the floor is not reported as a difference.
2. **Matrix at k = 2.** Variance comes from the pooled A/A estimate, not from each cell.
3. **Adaptive third run.** A cell gets run 3 only when its two runs differ by more than the floor,
   or when it sits within one floor of a ranking boundary.
4. **Effort extremes first.** Run the lowest and highest effort per model. Fill the middle levels
   only on steps where the extremes differ beyond the floor. A step where they do not is
   effort-insensitive and leaves the effort sweep.
5. **More fixtures before more repeats.** Several small fixtures at k = 2 beat few at k = 5 for the
   same tokens. Add fixtures (other trap sets on the P2 repo) before raising k.
6. **Reporting.** Per (step, model, effort): grade mean with a bootstrap interval, pass^k for
   reliability-type steps, median tokens, cost and wall time. A grade-per-token view per step,
   because a cheaper effort that scores within the floor is the useful answer.

**Check.** A/A floors are recorded per step before any comparison is published; every published
difference names the floor it exceeds.

## P5 — Report

One HTML report in `benchmarks/` per matrix, alongside the older ones, with the old end-to-end
benchmarks marked as not comparable (no noise baseline). A row in `benchmarks/README.md` for each.

## Not taken

- **End-to-end benchmark, even as a rare smoke test.** Decided 2026-10-20: it brings back the
  week-long runs and the allowance drain. Fixture staleness (P1) replaces the reason for it.
- **k = 5 per cell.** Too many runs once efforts are an axis; pooled A/A noise with k = 2 and an
  adaptive third run covers it.
- **The 2008 repository as the main fixture.** Its cost is dependency pain, not model skill.
- **The DDEV end-to-end task.** At most the micro fixture in P3.
- **External eval frameworks** (promptfoo, Inspect AI, Braintrust). They would either bypass Haive's
  step code, CLI adapters and sandbox, which is the thing being measured, or need the same adapter
  work anyway. Their ideas are used instead: pairwise judging, pass^k, A/A.
- **Raw-API model comparison.** Not a benchmark of Haive.

## Not verified

- How many historical rows on the benchmark machine have a NULL `cli_invocations.effort`
  (P0 step 2).
- Whether every candidate step's `llm` phase can run alone from a fixture, or some read state
  outside the workspace and the step rows (RAG tables, global KB, runtime containers). P1 lists
  each such read per step before capturing it; a step that reads live services needs those in the
  fixture or leaves the first matrix.
- The allowance-per-token ratio (P0 step 4).

## Decided

- 2026-10-20: models and efforts measured through Haive, single steps on frozen inputs; no
  end-to-end benchmark; k = 2 default; an easy modern PHP fixture with planted traps; no DDEV task.

## Relation to other plans

- `refactoring-economics-lessons` D2 and `parsimony-lessons` P3: one replay harness serves all three.
- `parsimony-lessons` P0: its change-size counter can be one more grade column for
  `07-phase-2-implement` results.
