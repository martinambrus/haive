# What Anthropic's agent-memory research offers Haive: close the learning loop, measure it, then consolidate

> Implementation review: 2026-11-12 against `3426c8c34`; corrections are folded into the relevant sections.
> **P1.1 implemented** (2026-11-14): versioned reconcile measurements and replay deduplication; see [Step 11 reconcile measurements](../architecture/learning-reconcile.md). **P1.2 implemented** (2026-11-14): bounded learning origin/update records excluded from excerpts and indexed content; see the same topic. RAG invocation attribution is implemented; see [RAG query attribution](../architecture/rag-playground.md#rag-query-attribution). P0 shipped with T580 (`a3d71d4f7` and `dfa43bf68`).
> **P2 first pilot run** (2026-11-19): one repository pair, six tasks, one model; no benefit measured, no P3 trigger fires, three human reviews open; see [P2](#p2-measurements-for-the-next-benchmark-round).
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
   Implementation: the existing signed task-token claims bind RAG credentials to one
   invocation through a run-private file. The API verifies task/step ownership and
   liveness before recording nullable `cli_invocation_id`; legacy or unprovable
   identity remains NULL. Existing time-window consumers are unchanged.

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

**First pilot (2026-11-18 to 2026-11-19), one repository pair.** One fixture was copied into a
control and a treatment repository. It has the shape of the reference pack in
`step-benchmark-suite.md` (PHP 8.3, Composer, SQLite, 28 files, seven planted traps), but a model
wrote it, not a person. Each repository ran onboarding, a first work task (a JSON export) and a
second (a CSV export). Each pair of tasks ran on claude-opus-5-5 in Claude Code: onboarding at
effort medium, both work pairs at high. Six tasks, 99 invocations (8 were failed or discarded
attempts in the treatment's onboarding), notional cost 28.62 USD, billable cost 0. The treatment's
first work task approved four learnings and the control none, by protocol, so the second work tasks
ran with four against none. One pair is not a sample: every figure is a count.

- **M1, retrieval in the second work task.** Treatment: discovery made the one search that hit a
  learning (rank 1 of 8 hits), then read all four files; implementation searched once, hit none and
  read none; validation and step 11 read all four files; the two reviewers saw one or two through
  grep (the peer reviewer cited one and reported it stale); step 11 did not search. Control: 3
  searches, 0 learning hits, no learning read.
- **M2 and M3, reconcile and admission.** The four step 11 runs proposed 3 (control, first work
  task), 4 (treatment, first), 2 (control, second) and 5 (treatment, second) entries: 14 parsed, 0
  dropped by the file:line rule. The treatment's first run approved all four proposals unedited
  (bootstrap order, subprocess tests, zero handling, journal rollback) and wrote them. Its second
  run saw 4 of 4 learnings and proposed 2 inserts, 2 updates and 1 delete, none downgraded. The
  protocol excluded all five, not on merit, because the approved learnings stay unchanged; it
  excluded the control's 3 and 2 as well, because the control keeps none. The delete targets the
  zero-handling learning, which the recorder called obsolete once the code was fixed. The review
  form has no per-op keep for a delete: a delete has no draft to clear (`stageLearningDrafts` skips
  deletes) and `writeFiles` switches every op together.
- **M4, outcome.** Paired traps (zero handling primary, misleading name secondary) gave the same
  counts at the first implementation, at gate 2 and after the merge: treatment avoided and control
  hit 0, treatment hit and control avoided 0, both avoided 1 (misleading name), both hit 1 (zero
  handling). All 12 grades (four work tasks, three points each) were 1 of 7, the one pass being
  misleading name. The traps keyed on output names fail on the name in both arms (both emit
  `reference`, the grader expects `customer_id` or `customer_ref`), so zero handling is a hit in
  both arms although both kept the zero row. The one non-paired cell that went the treatment's way
  is the partner prefix: the treatment applied it and the control did not, though it still fails on
  the name; it is unpaired because the treatment's first task had fixed that bootstrap order before
  any learning existed. The treatment's second task entered one fix round (control: none), for an
  environmental cause: the implementer left no `vendor/`, so `composer test` exited 127; the fix ran
  `composer install` and changed no source. No gate rejected, none escalated.
- **M5, store.** After the second work task the treatment holds 4 learnings (4832 bytes), 3613 bytes
  of knowledge base and 15047 bytes of source; the control holds 0 learnings, 2987 bytes of
  knowledge base and 16061 bytes of source. No near-duplicate or contradicting pair. No growth in
  the second work task, because the protocol excluded every proposal.
- **M6, learned guidance.** Skipped in all four step 11 runs; no guidance rows. Not measured.
- **M7, cost.** Step 11 cost 0.49 and 0.42 USD for the control (first, second work task) and 0.60
  and 0.76 for the treatment, one invocation each, notional. Retrieval cost is not separable from
  CLI totals (P1): 8 searches in the four work tasks. The treatment's second task cost 6.24 USD
  against 5.25; the fix round is 0.91 of that 0.99 gap.

**Trigger verdicts (P3).** None fires on this evidence.

| Trigger | Pilot evidence | Verdict |
| --- | --- | --- |
| G1 | 4 learnings against about 20; 0 duplicate or contradicting pairs; the recorder planned 2 updates and 1 delete among them | Not fired |
| G2 | M1 half partly met: 2 of the treatment's 20 second-task invocations searched and the implementation search hit no learning. M4 half not shown: the 2 graded repeats of described traps (zero handling, partner prefix) are key-name grades, and both arms kept the zero row | Not fired, nearest |
| G3 | 0 of 14 proposals dropped; none removed on merit; each admitted learning was read by a later step and one was cited; 1 called obsolete by the recorder | Not fired |
| G4 | One model and one CLI: no model comparison | Not fired, untestable |

**Open human reviews.** (1) Fixture authorship: a model wrote the fixture, traps and hidden grader
and no person has signed a review of them; the suite plan expects the reference pack by hand. (2)
The README trap: its machine part fails in both arms, so only a person can judge the prose. (3) The
first work pair's equivalence: until a person signs that the two first tasks were comparable, the
second-task comparison is exploratory, not controlled. None can turn this result into a measured
benefit: no paired count has a pair the treatment won, no learning covers the README trap, and a
failed authorship or equivalence review only removes pairs or the fixture.

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
