# Self-Improvement Memory lessons for Haive

> **Not started** 2026-11-20: findings and phases only, nothing approved. One source is reviewed:
> "Self-Improvement Memory Enables Continual Recursive Self-Improvement" (arXiv 2611.18856, v1
> 2026-11-13, Google Cloud AI, Google DeepMind, Penn State). Every Haive claim was read on `main`
> `3eb626748` on 2026-11-20. Resolve references by symbol; line numbers are hints and drift. Keep
> this file current by editing the section a change belongs to: a decision moves from Open
> decisions to Decided, a shipped phase gets its status in its own section and in `README.md`.
> Recommended order: P0, then P1; P2 waits for a trigger in `agent-memory-lessons.md`.

## Context

The user asked what the paper offers Haive's memory (RAG, knowledge base, learnings). The paper
is not about retrieval. It is about the record an optimizer keeps while it rewrites an agent's
harness, and its one transferable idea is the shape of that record: a diagnosis, then every
attempt against it with what the attempt predicted and what was then observed. Haive has two
places where an agent's diagnosis and a later observation already meet, and neither keeps the
pair: learned step guidance (`step_guidance`, step 11e) and the fix loop. Step 11 learnings fit
the shape poorly and get only a small provenance addition.

Sibling plans: `agent-memory-lessons.md` (step 11 learnings, measurements, consolidation),
`sleep-paper-lessons.md`, `verification-lessons.md` (outcome after merge, rule provenance).

## The source

**Setting.** A harness is the code around a fixed model: prompts, tools, control flow, memory.
Each round runs the harness on an evolve split, a proposer (Gemini 3.8 Flash) writes k = 5
candidate changes, a selector screens and picks one or none. Ten rounds per run. Continual RSI
then continues optimizing after the benchmark changes, or after the policy model changes.

**The record (SIM).** One entry per root-cause hypothesis, `m_i = (c_i, [(a_ij, o_ij, p_ij)]_j)`:

- `c_i` the root cause, for example "premature completion".
- `a_ij` the change and its rationale.
- `o_ij` the task fixes predicted BEFORE evaluation, then the fixes observed (`fixed`, `missed`)
  and `passed/total` on the evolve split.
- `p_ij` provenance: domain, benchmark, policy model, round.

Every proposal cites an existing root cause or opens a new one; the proposer decides the match
and the decision is saved before evaluation. Only the selected change is recorded, and it is
recorded with its measured outcome even when it regressed. Entries with identical root-cause
text merge without losing history. There is no retrieval, truncation or forgetting: the whole
record goes into the proposer's and selector's prompts. Reading guidance tells the proposer to
check each entry's domain, benchmark and model, and to reassess a reused rationale after a
benchmark or model change.

**Evidence.** Held-out results, never seen by the proposer, selector, memory or stopping rule:

- Full SIM finished highest in all 10 cross-dataset and cross-model settings. Over root causes
  alone (no attempts, outcomes or provenance) it led by 0.20 to 6.06 points; root causes alone
  against no memory ranged from 1.82 below to 2.40 above. Keeping the outcomes is what helps.
- Ten paired coding runs: +2.36 points, 95% CI [1.05, 3.68], SIM ahead in 9 of 10.
- A harness evolved under Opus 5.5 started 0.60 to 5.48 points below Gemini's own seed. Full
  SIM recovered and finished first; harness transfer alone trailed it by 3.60 to 11.33.
- Without memory, one run edited the same completion gate four times, twice to repair deadlocks.

**Limits.** Every domain except coding is one run per condition. Ten rounds of five candidates
per run, about 20 rounds end to end; the longest chain is four model generations, single runs,
and carrying the memory lost to a fresh start on the last one (94.8 against 95.6). No token cost
or prompt-size figure is reported, and no code is released. The workspace domain is scored by
the same model family that proposes and selects, which the authors flag as judge bias.

**Why it does not degrade the way self-rated loops do.** Coding, classification and engineering
are scored by verifiers and labels the agent cannot touch, and the held-out split is sealed. The
paper sidesteps self-grading rather than solving it, and says nothing about long horizons or
settings without an outside check.

## What does not transfer

- **A self-modifying harness.** Haive's steps are deterministic TypeScript reviewed by people.
  No phase here lets an agent edit Haive's prompts or code on its own judgment; a person stays
  the selector (11e's form, the fix-loop gates).
- **Retrieval changes.** The paper has none. Nothing here touches `rag_search`, the knowledge
  reserve or the global KB.
- **The whole store in every prompt.** It suits their small store. A repository's learnings in an
  always-loaded layer is already gap G2 in `agent-memory-lessons.md`, gated on its trigger.

## The rule every phase keeps

An outcome is only ever something the HOST observed: a reviewer's row in `review_findings`, the
source of a `fix_loop.requested` event, a defect reported by a validator, a check that ran or did
not. An agent's statement that it fixed something is never an outcome. Absence is never a fix:
`review-findings.md` already forbids writing `fixed`, because a reviewer that was skipped,
budget-killed or reworded produces the same absence. Each phase therefore records "re-raised",
"not re-raised", or "not checked", never "fixed". This is the paper's external grader, and it
is the line between this plan and the self-rating loops that degraded.

## Haive mapping

| SIM component | Haive today | Gap |
| --- | --- | --- |
| Root cause | `step_guidance.cause` + `fingerprint`; fix rounds asked for a root cause by `ROOT_CAUSE_LINES` | The fix-loop root cause is asked for, never stored |
| Change | `step_guidance.guidance`; the fix round's diff | None |
| Predicted fixes | None | P1 |
| Observed outcome | `step_guidance.occurrences` counts recurrence, including after the item was applied; `review_findings.recurrence_count` per (reviewer, path) | P0: recurrence after application is not separated; P1: nothing ties a round's outcome to its attempt |
| Provenance | `step_guidance.provider_family`, `source_task_id`; learning P1.2 stamp has task and time | P2: learning stamp has no CLI or model |
| Whole record read by the selector | 11e form shows `seen Nx`; the tooling page lists items | P0: no "applied in N tasks, re-raised in M" |

## P0: learned step guidance records whether it held

**Finding.** `step_guidance` is Haive's harness memory: lessons about how Haive's own prompts
asked for the work, appended by `augmentPromptWithLearnedGuidance` (`guidance-context.ts`, called
from `step-runner.ts`) and approved at 11e. Three defects keep it at the paper's weaker "root
causes only" level:

1. **An applied item that fails ranks higher.** When a validator reports again a defect whose
   fingerprint matches an `active` item, 11e's apply bumps `occurrences` (`11e-prompt-guidance.ts`,
   the `disposition === 'active'` branch), and the injection query orders by `occurrences` after
   repository scope (`guidance-context.ts`, `desc(schema.stepGuidance.occurrences)`). Guidance that
   was in the prompt and did not stop the defect is promoted. For an item that was NOT in the
   prompt (past `MAX_ITEMS` 5 or `MAX_CHARS` 1500), the same bump is right: the defect recurred
   while the lesson was withheld. Today the two cases are indistinguishable.
2. **Injection leaves no record.** The injector writes only a log line, so "this item was in the
   prompt of this dispatch" exists nowhere, and case 1 cannot be split.
3. **Most recurrences are never counted.** 11e's `shouldRun` returns false when no candidate is
   `new`, so a run whose only candidates are already active never reaches the bump. Its comment
   accepts that because `occurrences` is "never a metric"; it is, however, the ranking key.

**Design.**

- Record each injection as a task event, `guidance.injected`, payload version 1: step id, the
  item ids shown, the ids omitted by the cap, and the dispatch identity (task, step row, round,
  rerun generation, invocation when known). Ids and counts only, no guidance text. Keyed like
  `learning.reconciled` (`_learning-outcome.ts`) so a replay cannot double-count.
- At 11e, classify an active recurrence as `re_raised_after_injection` when this task has a
  `guidance.injected` event naming that item for the target step before the reporting step ran,
  otherwise as `observed_not_injected`. Only the second bumps `occurrences`.
- Add two counters on `step_guidance`, declared last in the Drizzle table: `injected_tasks`
  (distinct tasks whose prompt carried the item) and `re_raised_after_injection`. Store the CLI
  family of each re-raise in the event so cross-CLI failures can be read apart, as the paper's
  model-change result suggests.
- Count active recurrences without parking: let 11e run when there are active candidates and no
  `new` one, record, and auto-complete without a form (see Open decisions).
- Show "applied in N tasks, re-raised in M of them" beside each item on the repository tooling
  page and in 11e's active-item list. No automatic demotion or archiving: the person decides, as
  the schema comment requires ("Nothing here claims a measured improvement").

**Rollback.** The event and the counters are additive. Reverting the code restores the old bump
and ordering; the counters and events are left unread. A later cleanup migration may drop the two
columns once nothing reads them.

**Verification.**

- Unit: an item injected and then re-raised does not gain `occurrences` and gains
  `re_raised_after_injection`; an item omitted by the cap and re-raised gains `occurrences`; a
  replayed injection event is a no-op.
- Unit: a run with only active candidates records them and completes without a form.
- Live: one task on a repository with an active item; read the `guidance.injected` event and the
  counters after 11e.

## P1: the fix loop keeps its attempts

**Finding.** Each fix round is a fresh CLI process. What reaches the fixer is the diagnoses
(`loadPriorFixContext`, `_fix-loop.ts`), the workspace ledger (`augmentPromptWithLedger`), a
same-check repeat notice (`loadSameCheckRepeat`) and 08c's "Already tried" block
(`buildRecurringNote`). The fixer is asked for the root cause before editing (`ROOT_CAUSE_LINES`),
but its answer is not stored, it states no expected effect, and the next round is not told which
of the previous round's targets were re-raised. That is the paper's "root causes only" condition.
MEASURED in `fix-loop.md`: 3 of 7 real fix rounds were same-check repeats, and 4 of 5 second DAG
fix coders faced a file the previous reviewer had already flagged.

**Design.**

- The implementation step's fix round (07) and the DAG fix coder end their reply with a small
  structured block: root cause (citing an earlier attempt's id, or new), the change in one or two
  sentences, and the targets it expects to clear as (check or reviewer, path) pairs. Parsed
  leniently; a missing or malformed block records the attempt as `unstated`, never fails the
  step.
- Store it as a `fix_loop.attempt` task event per round, since a manual retry nulls
  `task_steps.output`. Root-cause ids are per task (R1, R2, ...).
- After the round's checks, the host scores each predicted target from structural data only:
  `re_raised` when the same reviewer flags the same normalised path (`review_findings`, the
  `loadFindingRecurrence` key) or the same check sends the round back (`fix_loop.requested`
  source); `not_re_raised` when that reviewer or check ran to completion and did not; `not_checked`
  otherwise. Targets raised that were not predicted are listed as such.
- The next round gets an "Attempts so far" block beside the diagnoses, not inside them: one line
  per earlier attempt (round, root cause id, change, each target's result). Agent-written text is
  fenced as data (`prompt-containment.md`). Budget like the prior-rounds block: whole oldest
  entries dropped under one omission line.
- Gate 2 and the escalation gate show the same table to the person.

**Rollback.** Prompt and event additions only. Reverting removes the request and the block; old
events stay unread.

**Verification.**

- Unit: the scorer on fixtures for each result, including a reviewer that was skipped
  (`not_checked`, never `not_re_raised`) and a reworded finding on the same path (`re_raised`).
- Unit: a reply without the block records `unstated` and the round proceeds.
- Measure before and after on comparable tasks: same-check repeats per task, rounds to gate 2,
  and how often a later round cites an earlier root cause. Report it as a pilot with its sample
  size, as `agent-memory-lessons.md` P2 did.

## P2: CLI and model in learning provenance (gated)

The P1.2 provenance stamp on step 11 learnings (`learning-reconcile.md`, "Learning provenance")
records task id, time and hashes. Add the CLI family and model of the writing invocation, so a
person, and any later consolidation (G1), can weigh a learning written under another model the
way the paper's reading guidance does. Build only when a P3 trigger in `agent-memory-lessons.md`
fires; the 2026-11-19 pilot fired none.

## Open decisions

1. **P0 counters or events only.** Recommended: both. Events are the evidence; counters keep the
   injection query and the tooling page cheap.
2. **P0 non-parking 11e run.** Recommended: run, record, auto-complete with an informational
   summary. The alternative, recording inside `shouldRun`, gives a predicate a side effect.
3. **P1 target granularity.** Recommended: (check or reviewer, normalised path), matching
   `review_findings` recurrence, since issue-text fingerprints match across rounds 0.05% of the
   time (`review-findings.md`).
4. **P1 scope.** Recommended: 07 and the DAG fix coder first; 08b, 07b and 08a fixers after the
   pilot.

## Decided

Nothing yet.
