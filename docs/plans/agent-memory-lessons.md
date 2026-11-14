# What Anthropic's agent-memory research offers Haive: close the learning loop, measure it, then consolidate

> Implementation review: 2026-11-12 against `3426c8c34`; corrections are folded into the relevant sections.
> **P1.1 implemented** (2026-11-14): versioned reconcile measurements and replay deduplication; see [Step 11 reconcile measurements](../architecture/learning-reconcile.md). P1.2/P1.3 remain not started. P0 shipped with T580 (`a3d71d4f7` and `dfa43bf68`).
> Sources reviewed: "The components of agent memory" (Anthropic research, 2026-11-06), the Managed
> Agents Dreams docs and the "Dreaming with a dynamic workflow" cookbook. Verdict: no dream pass yet.
> Fix the step 11 defects that keep the loop from closing (P0), add the records the next benchmark
> round needs (P1), take the measurements (P2), and build only the gaps the measurements justify
> (P3). The dev install's learning data predates the RAG and knowledge rework, so nothing here is
> decided from it. Keep this file current by editing the section a change belongs to.

## Context

The user asked what Anthropic's "dreaming" memory consolidation could add to the knowledge base and
learnings Haive updates after each task, and pointed at one claim: explaining what memory is for
works better than prescribing how to use it. They then asked for a plan to return to after the next
benchmark round: the measurements to take, the gaps to close, and the changes that need no analysis
of existing data. Every Haive claim below was read on `main` `6aa50dfaa` on 2026-11-11. Line
numbers are hints; resolve by symbol.

The data on the dev install is not evidence for anything here. Its learning steps ran between
2026-06-24 and 2026-08-24, mostly one benchmark task per repository, before retrieval was reworked.
The user verified on another machine that agents now call `rag_search`. The next benchmark round is
the evidence; P2 says what it must record.

## The sources

- **Purpose beats procedure.** Agents told what memory is for used it better than agents given
  fixed rules. One rule, "record only failures", cut the memory gain by 0.234 on Opus 5, 0.150 on
  Opus 4.7 and 0.020 on Sonnet 4.6. A contract wiki went from 41 to 57 of 57 once its instructions
  said what mattered.
- **Older models need steering.** Sonnet 4.6 went from 0.364 to 0.641 when told to read memory
  before answering and to test its theories. The effect of a prompt change depends on the model.
- **A note is a prediction that it will matter again.** Keep what exists only because the agent
  worked it out (strategy, tested rules); skip what can be re-derived from the environment.
- **Failure mode: the store outgrows its source.** One wiki grew to 1.77 times the corpus it
  described.
- **Dreaming is an offline pass.** It reads transcripts and the existing notes, corrects notes
  against the transcripts, merges duplicates, builds an index and promotes a small set to an
  always-loaded layer. The Dreams API takes a memory store, 1 to 100 session ids, a model and
  optional instructions, and returns a NEW store: the input is never modified, and the result is
  reviewed, then adopted or discarded. The cookbook's organizer writes `CONFLICT: A says...; B
  says...` rather than guessing. Its nightly runs have no review by default. Cost: $0.36 for 11
  transcripts, about $8 for 50 long ones.

## How Haive maps

| Research component | Haive today | Status |
| --- | --- | --- |
| Write during the session | `11-phase-8-learning`: admission bar, file:line check, insert/update/delete reconcile, a person reviews the diff at the form | Exists; reconcile blocked by P0 |
| Read before acting | Outside step 11, learnings reach an agent only through `rag_search` and the knowledge reserve | Exists; use unmeasured since the rework |
| Always-loaded layer | Global KB title digest (`GLOBAL_KB_DIGEST_MAX_TITLES` 40), house rules (`HOUSE_RULES_BUDGET_BYTES` 16 KiB), learned step guidance (`guidance-context.ts`, 5 items, 1500 chars) | No layer for a repository's own learnings (G2) |
| Transcripts as input | Persisted in `cli_invocations.stream_log`; step 11 sees only the history digest (`TIER_TOTAL_CAP` 1.5k/6k/20k chars), never a transcript | Unused by any consolidation |
| Offline consolidation | None | G1 |
| Review, then adopt or discard | The knowledge-diff gate at step 11's form | Reusable by G1 |

## P0 (shipped with T580): make step 11 able to reconcile

These need no data: each is a contradiction or a cap visible in the code.

- **Every learning is listed.** `detect` shows the agent `.slice(0, 60)` of an unsorted `readdir`,
  so past 60 it reconciles against an arbitrary subset. Design: `sleep-paper-lessons.md`, PR 2.
- **The `learning-recorder` persona matches the protocol.** The template (`_agent-templates.ts`)
  says "Add, never overwrite", "Leave every prior entry byte-for-byte" and "Write the entry to its
  own file", while step 11 asks for `update` and `delete` ops returned as JSON, and a pasted persona
  "takes precedence over the embedded protocol" (`PASTED_PERSONA_FRAMING`). The rewrite says what a
  learning is for, lets the agent update or delete an entry the run proved stale or wrong, and
  defers to a calling step's output contract. A body-only template change: the manifest's
  `contentHash` moves and repositories are offered the upgrade, with no `schemaVersion` bump
  ([Onboarding template versioning](../architecture/onboarding-upgrades.md), "When changing a
  template").
- **Not a defect: learnings under `.claude/learnings/`.** They predate the move to `.haive-data/`
  (2026-08-21), which recorded "no dual-read, no back-compat; demo repos are re-onboarded"
  (`glistening-percolating-snowflake.md`). Re-onboarding moves both legacy directories
  (`migrateLegacyKnowledge`, run by `08-knowledge-acquisition`), and the first release tag,
  `v0.1.0-rc.1`, came on 2026-09-08, so no released install has the old layout. It is a
  precondition of P2 instead.

## P1: records the measurements need, added before the benchmark round

Each adds a record and changes no behaviour, so none needs analysis first. Durable facts go in
`task_events`, since a step reset nulls `task_steps.output`.

1. **Step 11 reconcile outcome.** One event per apply with: learnings listed to the agent and how
   many carried an excerpt; entries the agent proposed; entries the admission bar dropped, by rule
   (today only the file:line rule is machine-checked, in `normaliseEntries`); kept entries by op;
   targets downgraded by `planLearningReconciliation` (an unknown `update` becomes an insert, an
   unknown `delete` is dropped); entries the person removed or edited at the form; investigation
   and global candidates proposed and kept. Without it, admission drops and downgrades leave no
   trace: the output keeps only what survived.
2. **Provenance on every learning.** `renderLearningBody` writes `# title` and the body, with no
   task, commit or date. A person correcting a learning, and any consolidation (G1), must trace it
   to the run that wrote it, to read that run's transcript. Record the task id and date of the
   insert and of each update, where the excerpt (`learningExcerpt`, the first 200 characters) and
   RAG chunking do not pick them up as content. Decide the format with the implementation: a
   trailing line is invisible to the excerpt, frontmatter needs stripping in both readers.
3. **Which invocation ran a search.** `rag_query_log` has `task_id` and `created_at` but no
   invocation, so per-step and per-model use must be joined by time window, which is ambiguous
   during a fan-out. Check first whether the rag MCP server can know the invocation that called it;
   if it cannot cheaply, keep the time-window join and say so in P2's report.

**Record contract for P1.** Use one versioned reconcile event per apply attempt, keyed by task,
step row, round and invocation; a crash/retry must not double-count it. Record proposed, parsed,
rejected, approved and actually written counts separately, including partial write failures.
Machine admission reasons and human edits are separate: most admission rules are prompt advice,
so absence from a reply cannot be counted as a machine rejection. Avoid storing full learning
bodies or transcripts in telemetry. Capture a bounded before/after identity/hash for provenance;
updates retain the original origin as well as the new task/date, and legacy entries say unknown.
Keep metadata out of both `learningExcerpt` and the indexed learning text, with tests of both.

RAG attribution must use an invocation-bound credential issued by Haive (with task/step ownership
checked server-side), never an invocation id supplied as an arbitrary tool argument. A time join
can supply only ambiguous candidates during fan-out and is labelled unknown for per-model rates.
Join the current `review_findings` recurrence key by reviewer/path as a repeat **candidate**, not
proof of the same defect; use the fixture's stable trap ids for the outcome. Retrieval cost is
not independently recoverable from CLI token totals: separate measured retrieval latency/calls,
step-11 cost, and whole-task cost. Any allocation of prompt tokens to retrieval is an estimate.

## P2: measurements for the next benchmark round

**Preconditions.**

- Every repository in the round has no `.claude/learnings/` or `.claude/knowledge_base/` at HEAD
  (`git ls-tree -r --name-only HEAD`); onboard fresh or re-onboard one that does.
- Tasks run as sequences on one repository, several related tasks each, so a later task can use an
  earlier task's learning. The old corpus was one task per repository, which cannot close a loop at
  all. Planted traps (the fixture in `step-benchmark-suite.md`) make the outcome countable: a trap a
  learning describes should not be hit again. The sequence length and repository count are
  judgements to set with the round.
- P0 and P1 are merged and deployed before the first task of the round.

**What to measure, each with the decision it feeds.**

| # | Measurement | Source | Feeds |
| --- | --- | --- | --- |
| M1 | Retrieval use per CLI, model and step: share of invocations with a `rag_search` call, calls per invocation, `learning_hits` and `runbook_hits` per query, `usage_assessment` used or unused | `rag_query_log` joined to `cli_invocations` (P1.3) | G2, G4 |
| M2 | Reconcile: learnings listed per run, ops by kind, downgrades | P1.1 events | Whether P0 worked; G1 |
| M3 | Admission: proposed against kept, by rule; what the person removed at the form | P1.1 events | G3 |
| M4 | Outcome: a planted trap hit again after a learning described it; across tasks of one repository, the same reviewer flagging the same file again (the `review_findings` key `(reviewerId, path)`); fix-loop rounds and gate rejections per task along the sequence | Fixture graders, `review_findings`, task events | Everything. M1 to M3 say whether the mechanism runs; only M4 says whether it helps |
| M5 | Store growth and quality per repository: learnings count and bytes, near-duplicate pairs, entries contradicting a later one, KB bytes against source bytes (the 1.77x failure mode) | The repository at each task's commit | G1 trigger |
| M6 | Learned step guidance proposed and approved | `step_guidance` rows | Whether that injected layer is alive (0 rows on the dev install) |
| M7 | Cost of step 11 and of retrieval per task | `cli_invocations` usage | G1 budget |

Report each with its sample counts and per model. A model-dependent effect is the expected shape,
not noise (the research's own numbers differ by model).

## P3: gaps, each built only when its trigger fires

- **G1: consolidation pass ("dreaming").** An offline pass over one repository: its learnings and
  KB, plus the transcripts (`cli_invocations.stream_log`) and history digests of its recent tasks.
  It proposes merges, corrections against the transcripts, deletions, and `CONFLICT` notes where two
  entries disagree and the evidence does not settle it. Its output is a proposed diff through the
  knowledge-diff gate, never a write to the live store: adopted or discarded by a person, as the
  Dreams API returns a new store. Transcripts are agent output, so they are fenced data
  ([Prompt containment](../architecture/prompt-containment.md)). Likely shape: a task type with
  prompt steps ([Task types](../architecture/task-types.md)) rather than new machinery. Needs P1.2.
  Trigger: M5 finds duplicates or stale entries in a repository past about 20 learnings (a
  judgement), and M7 says the pass is affordable.
- **G2: a repository's learnings in the always-loaded layer.** Their titles, bounded like the
  global KB digest, in the planning and implementation prompts, so an agent knows a learning exists
  before it decides whether to search. Trigger: M1 shows agents rarely retrieve learnings while M4
  shows repeats a learning described.
- **G3: purpose framing for step 11's admission bar.** Rule 2, "You knew it before this run, from
  general training", is a fixed rule of the kind the research found costly; state the purpose
  instead (record what a future run in this repository could not re-derive from the code), keeping
  the machine-checked file:line rule and its drop. The effect differs by model, so test it as two
  arms on the same sequence. Trigger: M3 shows the bar dropping or the person removing entries M4
  would have needed, or admitting entries no later task used.
- **G4: steering by model.** The retrieval protocol is the same for every model. If M1 shows some
  models skip memory that others use, give those models the explicit "read before acting" variant
  the research measured. Overlaps `harness-cadence-by-model.md`, which measures checks by model;
  decide there whether one variant mechanism serves both.

## Not proposed

- **A nightly pass without review.** The cookbook's default; every Haive knowledge write goes
  through a person, and G1 keeps that.
- **Reading or upgrading the legacy layout.** See P0.
- **Raw transcripts in step 11.** The digest caps exist for cost; G1 is where transcripts belong.

## Verification

- P0: `pnpm --filter @haive/worker test 11-phase-8-learning agent-templates template-manifest`,
  `pnpm typecheck`, `pnpm format:check`.
- P1: each record has a unit test for its shape, and one live task on the dev stack shows the
  event with nonzero counts where the run had them.
- P2: the report gives sample counts beside every rate; a rate on fewer than ten runs is reported
  as a count.
