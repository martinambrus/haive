# Step benchmark suite: models and efforts measured through Haive, one step at a time

> Implementation review: 2026-11-12 against `3426c8c34`; corrections are folded into the relevant sections.
>
> **Not started** 2026-10-20. Written on a machine with almost nothing onboarded, so every token
> number this plan needs is a step to run, not a figure stated here. P0 (token estimates) runs first
> on the machine that holds the earlier benchmark tasks, and its numbers gate the scope of P1-P5.
> Decided with the owner 2026-10-20: no end-to-end benchmark, k=2 by default, an easy modern
> fixture repository instead of the 2008 one, no DDEV task (a micro DDEV fixture at most, see P3).
> Decided with the owner 2026-11-12: the fixture becomes a topic **pack** a user can author for any
> area (P2), results and packs are shared through GitHub and accepted into the repository (P7), and
> a benchmarks module stores local and accepted results and computes per-topic reports (P6).

## Context

The benchmarks in `benchmarks/` (README, onboarding and full-workflow comparisons from 2026-07 to
2026-09) ran whole tasks end to end on one 2008 PHP repository: a README task, a full onboarding
with KB generation, and a DDEV task. Six problems make them unfit to compare models:

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
- **One input measures one area.** Any fixture measures a model on its own stack and domain only. A
  result on a PHP app says nothing about Rust or data pipelines, so a single built-in fixture would
  answer only the question its author happened to pick.

What the owner wants measured: **models and effort levels running inside Haive** — the real step
code, CLI adapter, sandbox, agent rules and retrieval — not models on arbitrary prompts. A result is
"model M at effort E does step S this well, through Haive".

## Approach

Benchmark single LLM steps on **frozen inputs**. A fixture holds everything one step reads when its
`llm` phase, or one of its mining agents, is dispatched. A runner restores the fixture, runs only
that dispatch (and `apply`, where the output is files), grades the result, and records it. Upstream variance cannot reach the
step, one run takes minutes, and the matrix can be sized to a weekly allowance.

Fixtures come in **packs**, one per topic (P2): a fixture repository, task statements, an answer key
and the captured step fixtures, frozen and hashed. A user who wants to know how models do on Rust,
or on Drupal migrations, authors or downloads a pack for it and runs the matrix on that pack. A
topic is never applied live to a run: a run's input must be identical across cells, repeats and
users, or the grades, the A/A floor and every shared comparison lose their meaning.

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
understate tokens and time. Historical killed-run usage predates the per-message fallback fix
(`assistantUsageByMessage` in `queues/cli-exec/stream.ts`); exclude those partial attempts from
the successful-run cost pilot, but report their count and spend separately when estimating the
full matrix budget. A matrix result itself must retain failures and unknown outcomes.

1. **Per-step cost table.** For every step id in `CLI_DISPATCH_STEPS` that has rows: number of
   invocations, median and p80 of input, output, cache-read and cache-write tokens, wall time as
   `ended_at - started_at` (the expression `modules/statistics/src/routes.ts` uses, since
   `duration_ms` is null on some successful rows), and `cost.costUsd` only on priced snapshots (`source != none`), separated into real and
   notional. Missing/unpriced snapshots are unknown, never zero-price samples. Group by step id, CLI provider,
   model, and effort. Model is `coalesce(model_identity.served, model_identity.requested)`, else
   `unknown`: codex `exec` records only `requested` and its app-server records `served` only on a
   reroute (`docs/architecture/cli-adapters.md`), so grouping on `served` alone would merge every
   codex model into one bucket. Effort is `unrecorded` where the `effort` column is NULL (legacy
   rows), else `effort->>'level'` together with `effort->>'source'`: a recorded null level with
   source `none` (the CLI has no knob) or `dropped` (the CLI ran its own default) is a known
   setting, not missing history. Samples come only from rows with a
   `task_step_id`: those are the dispatches the runner repeats. Recap invocations
   (`summary_for_step_id`, `docs/architecture/step-summaries.md`) are not samples; they go into a
   separate per-step spend total, attributed by `coalesce(task_step_id, summary_for_step_id)` as
   the statistics rollups do, used only for the check below. Never join `task_step_cli_choices` for effort: it holds only the current
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
   and take `tokens(fixture) / median tokens(history)` per step. Until then, use history as a sizing heuristic to rank steps by cost, with uncertainty;
   it is not a guaranteed upper bound for another fixture or model.
6. **Matrix size.** Per step: `models × efforts × fixtures × k × median tokens(step, model, effort)
   × scale factor`, k = 2 plus an expected 20% third runs (P4). Sum over steps, convert with step 4's
   ratio to weeks of allowance, and write the table into this plan's **Decided** section.

**Check.** The table covers every step that has rows; for one step, sample spend plus recap
spend agrees with that step's sum on the statistics page for the same window; the allowance ratio is measured, not
assumed.

**Output.** Steps chosen for the first matrix, ranked by cost and by how much a weak result there
hurts later steps. Approval owed on the total before P4 runs.

Candidate steps, to be cut down by P0: onboarding `01-env-detect`, `06_5-agent-discovery`,
`08-knowledge-acquisition` (one topic), `09_5-skill-generation`, `10_8-plan-build` or plan-build
`01-plan-build`; workflow `00-triage`, `04-phase-0b-pre-planning`, `07-phase-2-implement`,
`08c-code-review`, `10-gate-3-commit` (message). Not benchmarked: model-health canaries,
`01e-external-kb-sync`, `01f-external-plan-sync`, `13-pr-wait`, `01a-app-boot`.

P0 includes A/A pilots, judge calls, adaptive runs, fixture capture and failed attempts in the
allowance/time budget; the model-call formula alone omits them. A subscription usage delta is a
noisy, provider-specific observation (different token buckets and concurrent usage consume limits
differently), not a stable tokens-to-weeks conversion. Record the measurement window and concurrent
usage, and report a range. No token-history machine or scratch transcript is required for a reader
to implement P1: persist the chosen pilot table here before running the matrix.

**Build order.** P0 → minimal P6 schema/module and pack codec → P1 capture/runner → P2 reference
pack and P3 deterministic graders → P4 pilot/matrix → P5/P6 views → P7 sharing. P1 writes P6's
store, so P6's storage is a prerequisite, despite its section number. P4's cost approval remains
separate from this documentation review.

## P1 — Fixture capture and a single-step runner

- **Capture switch.** A per-task or per-step flag. At `llm` dispatch, the worker writes a fixture:
  the workspace tree (a tar through `@haive/shared/fs-safe` descriptors, or a git commit of the
  fixture repo plus a tar of the untracked `.haive/` state), `detect_output`, form values, the
  upstream outputs the step reads, the rendered prompt, the prompt hash, and a hash of the step's
  prompt-building source. Off by default; never on for user repositories without asking.
- **Runner.** `pnpm bench run --step <id> --fixture <name> --cli <provider> --model <id>
  --effort <level> --k 2`. The model lives on `cli_providers.model`, and the per-step choice holds
  only a provider id and effort, so the runner clones the named provider into a benchmark-only
  provider row with `model` set and points the step's choice at that clone. The user's own provider
  rows are never edited, so a matrix can never run whichever model one happens to be configured
  with. It restores the fixture into a throwaway workspace and sandbox, sets the CLI choice and effort,
  re-renders the prompt from current step code (so a result always measures Haive as it is now),
  runs the step's dispatch phase (+ `apply` only when allowlisted for isolated replay),
  grades it (P3), and writes one result row.
- **Two dispatch shapes.** Steps with `llm` run that phase once. Steps that dispatch through
  `agentMining` (`08c-code-review`, plan-build `01-plan-build`, part of `09_5-skill-generation`)
  run ONE mining agent per sample: the fixture names the agent (reviewer dimension, plan node,
  skill) and stores that agent's dispatch input, and the result row carries the agent id. The
  capture point for those is the mining dispatch, not `llm`. `dagExecute` steps are out of scope.
- **Result row.** step id, fixture, mining agent id (when any), fixture hash, prompt hash,
  step-source hash, `haive_build` stamp (`worker/src/build-stamp.ts`: `release:<version>` on a release image, else `commit:` or `tree:` of the
  working copy, so a dirty checkout gets its own id), CLI provider, requested and served model,
  effort level and source, CLI version, git sha, run index, tokens, cost, duration, grade breakdown,
  the raw output, and the workspace diff the dispatch left (tracked and untracked files against
  the restored fixture), since a step with `file_write` such as `07-phase-2-implement` edits the
  tree directly and its `apply` reads only the textual summary. Each row also carries the pack id
  and pack hash. Stored in the benchmarks module's own tables (P6), apart from live tables, so
  nothing in the live workflow reads it.
- **Fixtures belong to a pack.** A fixture is captured from a run on a pack's repository and stored
  under that pack; a fixture captured from a user's own repository is a private pack that is never
  exported (P7).
- **Cohort.** A matrix pins each CLI's version for its whole duration. The cell key includes pack hash, fixture/unit id, step, requested model, effective effort
  level **and source**, CLI version, grader version, and `haive_build`, and a cell whose rows mix versions or other cohort inputs is refused, since
  a CLI upgrade between weekly allowances changes prompt handling, tools and output parsing.
- **Staleness.** When a step's source hash differs from a fixture's, the runner refuses to mix new
  results with old ones and reports the fixture as stale. Results are compared only within one `haive_build`: a
  change to a shared prompt helper, adapter, `apply` or grader leaves the step-source hash and the
  git sha unchanged on a dirty tree, but not the build stamp. Re-capture is one cheap run of the
  upstream steps on the fixture repo, not a benchmark. The rule holds across installs too (P6, P7):
  two results are compared only when their pack hash, build stamp, grader version and CLI versions
  all match. Installs on one release may share `release:<version>`, but pool only with identical
  relevant runtime inputs. Also hash the sandbox image digest, module/adapter versions, rules,
  house-rule approvals, prompt-building inputs and retrieval snapshot. The build stamp alone
  cannot identify these mutable facts, and its current implementation excludes built library
  dist. An unknown build or an unverifiable environment is local-only, outside comparisons. A `tree:` stamp names an uncommitted checkout no other install can reproduce,
  so such results stay local and are never exported.
- **Replay at zero tokens.** Every cell and every repeat gets the same prompt, so a prompt hash
  cannot identify a response. A replay restores the fixture and the recorded **pre-apply** workspace mutation from
  one chosen result row (that row's id is the key), then runs `apply` exactly once and the grader
  on that row's raw output. Capture pre-apply and post-apply tree hashes separately; applying
  the final diff and then calling `apply` would perform file mutations twice. Preserve modes,
  deletes, renames, binary files and untracked files; a text-only patch is insufficient. Grader and `apply` changes then
  re-run without any model call. Model and effort comparisons always run live.

**Isolation and reproducibility gates.** A capture is a versioned immutable manifest of every
read needed by this dispatch: fixture tree/state, step rows, form answers, persona definitions,
rules/house rules, RAG corpus/query configuration, global KB and time/random seeds where relevant.
Do not silently read the live database or live RAG store on replay. Run the normal dispatch and
adapter path so current code is measured, recording both the rendered source prompt and final
provider-specific `dispatch_prompt`; different CLIs may adapt it differently. Input identity is
frozen within a cohort, not across different builds. Refuse unsupported standalone steps by a
capability list; do not invoke general task advance and accidentally run the rest of the workflow.
In particular a gate-3 message sample must intercept commit/push side effects.

Benchmark provider clones, invocation rows and queues need a dedicated database/Redis namespace
and auth resolution supplied by the harness, rather than live task inserts that the dev worker can
consume. Never copy plaintext secrets to a fixture or result. Reuse credentials by an authorized
reference at run time, preserve routing/auth mode, and clean up only harness-owned rows/containers.
Repository bytes enter capture/export via `fs-safe` and held tool descriptors. Compare the source
fingerprint before/after capture and refuse a moving tree. Kill-and-await every process/container
on timeout, with bounded disk, output, memory and wall time. A failed or timed-out sample remains
a result with a structural outcome; it is never silently rerun until it passes. A served-model
reroute or dropped effort is disclosed and excluded from the intended cell, not relabelled.

The runner and fixture loader cannot depend on untracked scripts, scratch `.claude` files or a
memory key on one machine. Commit the minimal harness/fixtures needed to reproduce each check.
Preserve private/public provenance on capture; public export requires a separately reviewed
allowlist of pack artifacts, never the task workspace wholesale.

**Check.** A fixture captured from a real run replays to an output of the same shape. The same
result row replayed twice gives a byte-identical grade. A stale fixture is refused.

**Rollback.** The switch defaults off and the runner is a separate entry point. Revert the commits
and delete the result store.

## P2 — Topic packs, and the reference pack

A **pack** is the unit of input: a fixture repository pinned by commit, 1-3 task statements for the
workflow steps, an answer key, the step fixtures captured from one upstream run on it, and a
manifest (pack id, topic tags, stack, the steps it covers, the model that generated it, the content
hash). Topic tags are a stack tag detected from the repository's manifests (`Cargo.toml`,
`composer.json`, `package.json`) plus free area tags, so "rust" and "Rust CLI" group under one
stack. A pack names the steps it covers: a step whose output barely depends on the domain
(`10-gate-3-commit`, `00-triage`) can be left out rather than padding the topic's report.

**Authoring.** The user enters a topic. A generator drafts the repository, the traps and the answer
key; the user reviews and edits them; the pack must then pass the check below before any run uses
it. A model that wrote the traps finds them more easily, so the manifest records the generator and
a matrix flags that model's family on that pack and leaves it out of the topic report by default.

**Reference pack.** The first pack, hand-written. Difficulty comes from reasoning, not from the
environment. A small **PHP 8.3 + Composer** app (Haive's DDEV and Drupal focus says PHP), 20-40
files, 2-3 dependencies, SQLite, installing in seconds. Kept in its own repository so its history
is clean and pinned by commit. Every authored pack follows the same rules: small, installing in
seconds, traps graded easy to hard.

Planted traps, each with a written answer key, graded easy to hard so scores spread out and no
model sits at 100%:

- configuration read from an unusual place
- a file or class whose name misleads about what it does
- dead code that looks live, and a live path that looks dead
- one convention every file follows except one
- a fact visible only by reading two files together
- one real bug with a deterministic repro
- a README task whose correct content depends on three of the above

**Check, for every pack.** The answer key is complete: an ideal output scores 100%, an empty output
scores 0%, and an output that misses the two hardest traps scores in between. A pack that fails is
not runnable. For an authored pack the reviewed ideal output is part of the pack.

## P3 — Graders, cheapest first

1. **Deterministic.** Output parses to the step's schema; files exist; `php -l` passes; tests pass;
   required sections are present; every path the output cites exists in the fixture.
2. **Answer key.** Planted-trap recall and precision; KB entries checked against the fact list;
   hallucinated facts counted. The key is read from the pack, so one grader serves every topic.
3. **LLM judge, only for what is left** (prose quality, plan structure). Pairwise A vs B, run in both
   orders, judged by a model from another family than both contestants. No absolute 1-10 scores.
   A pairwise verdict depends on the opponent, so it is not a per-run grade: verdicts go into their
   own record (run A, run B, order, winner or tie) and are reported as win rates per pair of
   cells. The per-run grade on a result row comes only from layers 1 and 2, and only that grade
   feeds P4's means, A/A spread and intervals. For judge calibration compare independent outputs from the same cell in both orders,
   track ties separately, and require no systematic position preference. Identical output
   against itself should tie; it is not evidence for a 50% non-tie win rate.

DDEV: no DDEV task. If environment setup is worth measuring, a **micro DDEV fixture** — the P2 app
with `01-env-detect`'s DDEV output graded by `ddev config` validating, `ddev start`, HTTP 200 and the
DB importing — costs one step's tokens and about a minute of `ddev start`. Include it only if P0
shows the step is cheap; otherwise drop it.

**Check.** Unit tests for each grader on fixed outputs; the pairwise judge agrees with itself when
A and B are swapped on at least 9 of 10 fixed pairs.

## P4 — Noise floor, then the matrix

1. **A/A per chosen step.** One model, one middle effort, k = 4. Predeclare the spread statistic (sample standard deviation plus observed range) per
   (step, pack, fixture/unit, model, effort); four observations are only a pilot noise estimate.
   A difference smaller than the chosen floor is not reported as a difference, and exceeding
   it alone does not prove significance.
2. **Matrix at k = 2.** Use the matched A/A pilot as a disclosed provisional variance estimate,
   never as proof that every model/effort has the same variance. A zero pilot variance gives
   “insufficient variance evidence”, not a zero-width interval. Do not declare a step
   effort-insensitive from a single pair; say “no difference detected at this budget”.
3. **Adaptive third run.** A cell gets run 3 only when its two runs differ by more than the floor,
   or when it sits within one floor of a ranking boundary.
4. **Effort extremes first.** Run the lowest and highest effort per model. Fill the middle levels
   only on steps where the extremes differ beyond the floor. A step where they do not is
   effort-insensitive and leaves the effort sweep.
5. **More fixtures before more repeats.** Several small fixtures at k = 2 beat few at k = 5 for the
   same tokens. Add fixtures (other trap sets, other packs on the same topic) before raising k.
   The A/A floor is measured per (step, pack): one pack's noise says nothing about another's.
6. **Reporting.** Per cell: deterministic grade mean, n, successes/failures/unknowns, pilot
   noise and a clearly labelled pilot-based interval. For a paired difference use the
   uncertainty of **both** means; a t critical value uses the variance estimate's degrees of
   freedom (k=4 gives 3 for one pilot), not the matrix cell's n. Pool only matched, defensible
   variance groups and document the formula and confidence level in the implementation.
   Adaptive third runs and screening many models make ordinary intervals exploratory;
   confirm selected comparisons on fresh runs before publishing a statistical winner.
   Once several independent fixtures exist, bootstrap paired differences by fixture, with a
   fixed seed and every repeat of a fixture kept in one resample unit. Report observed
   all-k-success counts for reliability; do not present a two-run estimate of p raised to k
   as an established reliability probability. Include median tokens, cost and wall time
   with priced coverage, and correctness beside any grade-per-token ratio.

**Check.** A/A floors are recorded per step before any comparison is published; every published
difference names the floor it exceeds.

## P5 — Report

One HTML report in `benchmarks/` per matrix, alongside the older ones, with the old end-to-end
benchmarks marked as not comparable (no noise baseline). A row in `benchmarks/README.md` for each.
Once P6 exists the module's report is the live view and the HTML file is a snapshot of it.

## P6 — Benchmarks module: store, ingest, compute

A module (`modules/benchmarks/`, [Modules](../architecture/modules.md)) with an admin page, its own
tables for packs, result rows and judge verdicts, and two sources:

- **Local.** Every row the runner writes on this install, marked local.
- **Official.** Accepted packs and result bundles committed under `benchmarks/community/`
  (P7). The module imports them at worker boot, which covers every Haive update, and on demand from
  the page. The import is idempotent: a bundle is keyed by its content hash, so re-reading the
  directory is a no-op, and an imported bundle is never edited, only superseded.

**Topic report, computed on read.** Grades from different packs are not on one scale: averaging a
hard Rust pack with an easy one ranks whichever model happened to run on the easy one. So models
are compared only within a pack both ran on and under one cohort (P1: same build stamp, grader
version and CLI versions), as the difference of their cell means against that pack's A/A floor. A
topic's report combines those per-pack differences across every pack with the topic tag, with equal pack weight by default and showing the number of independent packs, repeats
and builds behind each comparison. An author running more repeats must not silently give their
pack more influence. Predeclare any alternative weights; never average across different step
scales or grader versions. Each difference is
controlled for the Haive build on its own, so differences from several releases can be combined;
the default view takes only the current release. Two
models that never shared a pack are not ranked against each other; the report says so rather than
guessing. Packs are public, so filling such a gap means running the missing model on an existing
pack. Tokens, cost and wall time are reported per pack, never averaged across packs.

The page shows local and official results side by side and filters by topic, step, CLI version and
build (default: current release).

**Check.** Importing the same directory twice changes no row. A fixed set of bundles gives a
byte-identical topic report, with stable ordering and no clock-dependent fields in its canonical
form. Import all rows transactionally only after full validation; a failed import changes nothing.
Static report generation uses that same pure calculation, not a live module database.
Use module-owned storage through `ensure-schema` and host API/session props through `web-kit`. A synthetic case where A beats B on every pack both ran, while B alone
also ran easier packs where it scores higher than A did anywhere, still reports A ahead.

**Rollback.** Additive; nothing outside the module reads its tables. Deactivate the module and run
its teardown while it is still installed, then `pnpm module remove benchmarks` and rebuild. A module
already removed keeps its data (`Missing`) until "Purge data..." on `/admin/modules` drops it.

## P7 — Sharing through GitHub

- **Export.** The page exports a result bundle: pack id and hash, build stamp, step-source hashes, grader
  version, CLI versions, models and efforts, A/A floors, per-cell grades with intervals, tokens,
  cost and wall time. No raw outputs, prompts or diffs. Export per-run numeric observations, structural outcomes and stable run ids, plus
  grader/fixture/cohort identities; means/intervals alone cannot support recomputation,
  deduplication or adaptive-run auditing. Keep cost source/coverage explicit. A bundle and
  its local rows share run identities so importing one's own accepted bundle cannot double-count
  a run; corrections supersede logical run ids rather than inventing new observations.
  Only public packs export; a private pack,
  and any fixture captured from a user's repository, never leaves the install.
- **Submission.** A GitHub issue template takes the bundle, and the pack when it is new. A GitHub
  Action performs bounded data/schema/hash validation with no submitted code execution, no
  secrets and no privileged `pull_request_target` checkout. Refuse `tree:`/unknown builds.
  Treat packs and bundles as untrusted: reject traversal, links escaping the pack, decompression
  bombs, unexpected files and oversized fields before extraction. P2's runnable grader/repo
  checks happen only after maintainer review in a disposable credential-free sandbox with
  bounded resources and no Docker socket; issue labels alone never authorize execution.
- **Acceptance.** A maintainer moves an accepted bundle into `benchmarks/community/` by PR; P6
  ingests it on the next update. Results are self-reported: the page marks them so, and because the
  pack is public a maintainer can re-run any cell to spot-check it.
- **Docs list.** A generated docs page (or the wiki) renders P6's topic reports from the committed
  bundles, so the public list and an install's page come from the same data and the same code.

**Sharing limits.** Keep the answer key and hidden grader out of the contestant's mount, prompt,
RAG corpus and subprocess environment, even when they are public in the pack repository. Public
traps cannot prove absence of training contamination; the generator-family exclusion is a bias
control, not a guarantee. Grades are self-reported until rerun. Exported HTML/Markdown renders
model text through the shared Markdown policy, and no raw model HTML is executed. P3's zero-token
byte-identical check applies to deterministic graders only; an LLM judge is replayed from a stored
verdict or called live as a separately costed observation.

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
- **A topic applied live to each run.** Decided 2026-11-12: inputs would differ per run, so there is
  no answer key to grade against, the A/A floor measures the generator as well as the model, and
  two users' results on the same topic cannot be compared. A topic produces a frozen pack instead.
- **A plain average across packs for a topic report.** Packs differ in difficulty, so it ranks by
  which packs a model happened to run on. Within-pack differences instead (P6).

## Not verified

- How many historical rows on the benchmark machine have a NULL `cli_invocations.effort`
  (P0 step 2).
- Whether every candidate step's `llm` phase can run alone from a fixture, or some read state
  outside the workspace and the step rows (RAG tables, global KB, runtime containers). P1 lists
  each such read per step before capturing it; a step that reads live services needs those in the
  fixture or leaves the first matrix.
- The allowance-per-token ratio (P0 step 4).
- Whether release images ship `benchmarks/community/`, which P6's boot import reads; if not, the
  import reads it from the release assets or the module carries the directory.
- Whether a generator plus user review produces answer keys good enough to pass P2's check without
  a hand-written ideal output, or the user has to write one.

## Decided

- 2026-10-20: models and efforts measured through Haive, single steps on frozen inputs; no
  end-to-end benchmark; k = 2 default; an easy modern PHP fixture with planted traps; no DDEV task.
- 2026-11-12: inputs come in frozen topic packs any user can author, with the PHP fixture as the
  reference pack; results and public packs are shared by GitHub issue and accepted into
  `benchmarks/community/`; a benchmarks module stores local and accepted results, imports on boot
  and on demand, and computes topic reports from within-pack comparisons.

## Relation to other plans

- `refactoring-economics-lessons` D2 and `parsimony-lessons` P3: one replay harness serves all three.
- `parsimony-lessons` P0: its change-size counter can be one more grade column for
  `07-phase-2-implement` results.
