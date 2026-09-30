# AIDE² harness lessons for Haive

> **Not started — a findings register and a ranked plan; nothing approved** (2026-09-30). One source
> is reviewed: Weco AI's AIDE² paper and its blog post. The Haive findings were measured read-only on
> the dev install on 2026-09-29, and every code reference was re-read on `origin/main` `610b7cbd` on
> 2026-09-30. Keep this file current by editing the section a change belongs to: a re-measured number
> replaces the old one in Findings, a decision moves from Open decisions to Decided, and a shipped
> phase gets its status here and in `README.md`. P0 is small and lands first, so the field checks of
> every later phase can compare runs by build. P1 and P2 are the recommended first changes.

## Context

The user asked what Haive could take from the paper: its memory (context) mechanisms first, then
anything else. Every claim below was checked against Haive's code and the dev install's stored runs,
and a technique counts only where Haive lacks it or does it worse.

Evidence base. `cli_invocations` on the dev install holds 3,509 runs from 2026-09-01 to 2026-09-14,
and nothing newer, so the measurements describe the code of that window. Workflow runs are few there:
three tasks reached the reviewers and three reached `08b-test-management`, so findings resting on
those are marked thin. Resolve every reference by symbol; line numbers drift.

One difference bounds everything. AIDE optimizes one numeric score over hundreds of candidate
solutions under a dollar budget. Haive produces one change per task, judged by tests, reviewers and a
person. The paper's search machinery (bandits over strategies, tree search, choosing the best
candidate) has nothing to act on in Haive. What transfers is structural: bounded role-specific
context, a check the optimizer cannot see, a change of approach when progress stalls, cheap models on
narrow calls, and the evaluation discipline itself.

## Source reviewed

### S1. Weco AI, AIDE² (arXiv 2609.26457v1, 2026-09-22, and its 2026-07-14 blog post)

Srikanth, Zhao, Xu, Wu and Jiang, "Recursive self-improvement of AI research agents"
(<https://arxiv.org/abs/2609.26457>), and the blog post "AIDE²: First Evidence of Recursive
Self-Improvement" (<https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement>).

Two loops. The inner agent (AIDE, a tree-search code optimizer, run on gemini 3 flash) optimizes code
against a PUBLIC score. The outer agent (Weco's hand-tuned production agent AIDE_human, on claude opus
4.7) rewrites the inner agent's code, and keeps a rewrite only if its PRIVATE grade beats the
incumbent's. The grade is held-out scores across heterogeneous task families (ML engineering,
heuristic algorithms, harness engineering) at a fixed dollar budget per task, tokens and execution
included, so a gain has to be efficiency rather than spend. 100 outer steps in 8 days produced 7
accepted rewrites (grade 0.703 to 0.778; AIDE_human scores 0.749), and about 9 proposals in 10 were
rejected.

Where the two differ, the paper's numbers supersede the blog's: reward hacking fell from 55% to 32%
(the blog said 63% to 34%), and by the end of a run per-call prompts were 7× (MLE-Bench) to about 50×
(ALE-Bench, FML-Bench) smaller than AIDE0's and 2.6× to 14× smaller than AIDE_human's (the blog said
"16× on average").

- **Context (§3.5, appendix E, blog matrix).** AIDE0 put the full history, every earlier candidate's
  code and output, into each draft and improve prompt, so prompts grew until runs died at the context
  window (5 FML-Bench runs, 48 ALE-Bench runs at the larger budget). AIDE85 gives each operator a
  bounded, role-specific prompt: a compact summary of the root and the recent candidates ("newest-12
  one-liners plus one full solution"), so prompt size stays flat, and the tokens saved buy more search
  steps under the fixed budget. A failure memory switches on only when at least 15% of candidates are
  buggy, and then carries up to three deduplicated final error lines. The evaluation reviewer reads
  execution output deduplicated, head plus tail, capped at 32k; the debug operator gets the raw tail.
- **Accepted rewrites (fig. 2).** Step 2, bandit search over strategies. 6, a root-cause diagnosis
  before any fix. 28, escape plateaus by forking the champion. 39, self-repair after a crashed fix
  attempt. 47, patch an error that crashed evaluations. 63, compress log spam before reading it. 85,
  demote a failure-prone draft strategy.
- **Stalls (§3.5, table 3).** Every five search steps AIDE85 forks the global best node and improves
  it under a different strategy arm: refining a plateaued lineage returns less and less, and restarting
  from a fresh draft throws the best solution away. Both alternatives were proposed and lost:
  stagnation-triggered exploration escalation (−0.040) and keep-refining-versus-restart decisions
  (−0.078).
- **Reward hacking (§3.4, appendix A).** Measured on 38 held-out KernelBench pairs, a family the loop
  never saw: a kernel hacks when less than half of its claimed isolated speedup survives inside a real
  training loop, or it crashes there. The rate fell from 55% (AIDE0) to 39% (AIDE47) and 32% (AIDE85),
  against 39% for AIDE_human, although the loop was never told to reduce it; selection on a grade the
  inner agent cannot see is the paper's explanation. AIDE85's own defences are a fixed instruction in
  every code-generation prompt (solutions are scored on a private split, so prefer robust, general
  approaches), a guard that re-prompts a near-empty solution (under 40 characters), and a selection
  penalty that replays showed never changed a selection. The paper cannot attribute the drop to any one
  layer. About a quarter of the rejected rewrites scored HIGHER than the incumbent on the visible
  signal and lost on the private grade (appendix D).
- **Model split (§2.2, appendix C).** The cheap model runs the many inner calls and the strongest model
  the few outer ones, because evaluating a candidate costs far more than proposing it; likewise the
  inner reviewer is one LLM call per output while the outer reviewer explores for several steps.
  Harness gains transfer across models: gemini 3 flash with AIDE85 (1858) beat fable 5 with AIDE0
  (1796) on ALE-Bench at the same $20 per run.
- **What lost (table 3, appendix D).** Island populations, pairwise LLM-judge tournaments (−0.090),
  majority-vote ensembles (−0.031; "ensembling LLM calls consumes budget that could otherwise fund
  additional search steps"), decaying exploration, UCB-V, MCTS value backup and optimizer's-curse
  corrections: much of the literature's toolbox. Run-to-run noise was about 0.02 to 0.045 (blog), so
  several small deltas were coin flips.
- **Limits (§5, blog).** The evolved code is complex and carries dead code, and one defence was correct
  in an earlier version and broken by a later mutation. Noise compounds across the two loops, and the
  test of whether a discovered agent is also a better outer agent was inconclusive at three seeds.

## Findings

- **F1. `03-plan-sequence` sends the whole plan to every agent, with no character bound.** `buildWave`
  renders `renderPlanMarkdown` (titles only, depth 3, links omitted) once per wave, and
  `buildSequencePrompt` puts it into every agent's prompt. Across 937 runs of `00-`/`03-plan-sequence`
  the prompts averaged about 161k characters. In one examined prompt (165,443 characters, an
  800-plus-node plan) about 155k is that plan, while the agent's own part, `## Your node`, is 2,532.
  Every agent paid for the plan afresh: across 888 runs with cache fields, cache writes were 82,396 to
  84,410 tokens (p10 to p90) and cache reads a flat ~24.1k at every percentile, which fits only the
  CLI's own system prompt and tools being reused; the plan block was never read from cache. The 925
  runs with a reported cost total $404 (claude-code prices every run by its Anthropic table, so on a
  subscription this is notional; the usage window it spends is not). The prompt also breaks the
  project's own provider-neutral bound: `PLAN_EXPANSION_CONTEXT_MAX_CHARS` is 96k because the smallest
  supported model fallback is 128k tokens, and 161k characters is already past it. → P1.
- **F2. The sequence agents barely use the rest of the plan.** Of the 5,322 `depends_on` link ops
  parsed from 887 agents' replies, 5,305 (99.7%) join ids listed in that agent's own `## Your node`
  section and 17 reach elsewhere. They were classified against each agent's own prompt, because the
  plans have since been rebuilt and `plan_nodes` no longer holds those ids. Whether seeing the whole
  plan improves the ORDER an agent chooses cannot be read from stored data. → P1.
- **F3. The same fix already worked for `01-plan-build` and `02-plan-coverage`.**
  `buildPlanExpansionContext` (`_plan-expansion-context.ts`, landed in `f7d65242` on 2026-09-02) gives
  the target's ancestors, siblings and children with exact refs, plus an evenly sampled title outline,
  within 96k. On the same install, before it and after: the 01-plan-build median prompt went from
  285,768 to 21,386 characters and its maximum from 698,254 to 62,518; the 02-plan-coverage maximum
  from 1,186,918 to 105,179. What is left there is the outline's share: in a median 02 prompt of 95,567
  characters, 83,960 is the `Whole-plan title index`, against 2,378 of neighbourhood and 1,707 of own
  node. → P1 (second arm), P8.
- **F4. Plan chat sends the whole plan with bodies, and a run failed on it.** `01-plan-chat`'s detect
  renders `renderPlanMarkdown` with `focusNodeId` (bodies and links included) into every turn. Two
  turns on big plans were 709,634 and 789,484 characters, of which the plan was 696,221 and 778,968.
  The ollama run of the first failed with `LLM run reported a failure (terminal_reason
  "blocking_limit"): Prompt is too long`, AIDE0's failure mode. Handing over the whole plan is
  deliberate (the step's header: a request made on one node may belong on another, so the agent needs
  every node's id). The transcript is every message ever posted on the node, across tasks
  (`plan_node_messages` filtered by node alone); it is small so far (at most 5,580 characters). → P4.
- **F5. Two more plan renders reach prompts unbounded.** `11f-plan-reconcile` and
  `01f-external-plan-sync` render titles to depth 4 with no character bound. One 11f prompt was 358,017
  characters; 01f is unmeasured. → P5.
- **F6. Haive's background blocks already do what AIDE85 does. No work.** The task ledger
  (`augmentPromptWithLedger`, a 4,000-character block), the prior fix diagnoses (`loadPriorFixContext`,
  400 per entry and 4,000 per block), the honored constraints (`loadHonoredConstraints`, 3,000 with a
  400 floor per source) and learned guidance (5 items, 1,500 characters) are all bounded, drop whole
  oldest entries rather than slicing one, deduplicate by `contentFingerprint` and state what they
  dropped. Do not re-propose them.
- **F7. A check that keeps failing spends every fix round on the same approach.**
  `detectFixLoopOscillation` trips only when a DIFFERENT source loops back in between, so one source
  re-raising its defect runs to the round cap (5 by default in `06-run-config`, and all 75 tasks on the
  install use it). The cap gate offers Continue, Accept or Abort, with the next round on the same CLI
  (`buildFixLoopEscalationSchema`, `buildOscillationEscalationSchema`). 08c's loop-back tells 07 when
  a (reviewer, file) complaint survived earlier rounds ("### Already tried", `buildRecurringNote`,
  whose own comment records that a prose fingerprint treats a reworded repeat as new), but no other
  source's loop-back tells 07 that its approach failed before, and 07's fix framing asks it to identify
  the actual error without asking for the cause before it edits. The only way to move a stuck task's
  fixer to another model is the step CLI switch, and that writes a user-wide preference:
  `PATCH /tasks/:id/steps/:stepId/cli-provider` upserts `user_step_cli_preferences` or
  `user_step_cli_role_preferences`, neither keyed on a task.
  Plan chat task e63c6ce9 shows it used as a manual escape: after the ollama failure in F4, two
  `step.cli_provider_preference_changed` events 8 s apart moved the step to codex and then to
  claude-code, each rewriting the default for every later task. How often loops stall, from AGENTS.md
  ("Review findings and waivers"): 42.7% of (reviewer, file) pairs were re-raised in a later round, one
  for 19 rounds. → P2, P3.
- **F8. The 08b fix pass can make its own grader pass (thin).** Its prompt lets the agent decide that
  the TEST is wrong and fix the test, and those same tests then grade it; `buildTestFailureDiagnosis`
  hands 07 the same three-way choice. All 7 stored 08b rows with fix passes edited tests during them
  (3 tasks), and none went green that way. Too few to show gaming; the opening is structural. → P6.
- **F9. Per-seat provider routing already exists.** A fan-out resolves its provider per `roleKey`
  (`resolvePreferredCli`, called per seat in `step-runner.ts`), built so that 08c's refuter panel is
  not three copies of one model. The sequence agents dispatch as role `expand`. Moving a narrow,
  high-volume seat to a cheaper provider is configuration plus measurement, not code, although the
  preference is user-wide. → P7.
- **F10. A run does not record which Haive build produced it.** `cli_invocations` has no build or
  commit column (`tasks.commit_sha` is the task's own commit), and `APP_VERSION` is the dev sentinel.
  Comparing a step before and after a prompt change therefore means guessing from timestamps, and a dev
  checkout can switch branches under a running worker. The only evaluation scripts cover deterministic
  rules (`rag-eval.ts`, `kb-scrub-eval.ts`); nothing re-runs an LLM step on fixed inputs and grades
  the result. → P0, P8.
- **F11. Test output reaches prompts as a bare tail (thin).** `runTestCommand` keeps the last 4,000
  characters with no deduplication. Across the 4 stored 08b diagnoses, 18.3% of characters are
  repeated lines (37.3% at worst). Too few to act on. → D5.
- **F12. Dev side, not the product: `AGENTS.md` is 311,309 bytes (2,942 lines).** `CLAUDE.md`
  imports it into every Claude Code session on this repository, the load-everything shape AIDE85 moved
  away from, and AGENTS.md itself notes that Codex reads only its first 32 KiB. → D6.
- **F13. The reviewer-overlap question cannot be answered on this install.** `review_findings` holds
  workflow-review rows from 3 tasks. AGENTS.md's own open question ("Review scope": whether
  07b/08c/08c2/08d catch what the per-issue DAG reviewer catches) and the paper's result that extra
  judges and ensembles lost at a fixed budget both point at an ablation, which P8 is the vehicle for.
  The paper's judges SELECTED among candidates while Haive's reviewers DETECT defects, so the result is
  a reason to measure, not a verdict.

## Phases

Each phase is its own PR. A change is off by default or byte-identical where it can be, and each
phase names its undo.

### P0. Stamp the build on every run (small; first)

Each CLI run records the Haive build that produced it: the release tag on a published image, the
commit plus a dirty flag in a dev checkout, and `unknown` when neither can be read, never a guess. A
nullable column on `cli_invocations`, written with the row. Why first: P1 to P7 are each judged in the
field by comparing runs before and after, and F10 leaves that to timestamps. Verification: a run
started after the change carries the stamp, and a dirty dev checkout says so. Rollback: stop writing
it; the column is additive and nullable, and a later change drops it.

### P1. Bound the sequence agents' plan context (recommended first change)

Invariant: a plan render that reaches a sequence agent is bounded and says what it left out. Two arms,
in order:

1. **Parity.** Build each agent's context with `buildPlanExpansionContext`, focused on the node whose
   children the agent orders: the shape 01 and 02 already use, links still omitted as the step
   requires. This alone ends F1's breach of the provider-neutral bound, with the precedent of F3.
2. **Role-sized.** The same neighbourhood with the outline cut to depth 1 or 2, or a small character
   budget. F2 says 99.7% of this role's output stays inside what it is shown about its own node.

Trade-off, stated in the prompt: a node outside the neighbourhood carries no id, so the rare
cross-subtree `depends_on` (0.3% in F2) can no longer be named. Verification: zero-token first, by
building the prompts for a real 800-node plan and measuring them; then one wave per arm (12 agents,
`SEQUENCE_AGENTS_PER_WAVE`) on the same plan, comparing cache-write tokens per agent, the step's
`disagreements` count, order agreement between the arms per parent, and a person's spot check of the
parents where the arms differ. The step has no ground truth by design (a disagreement is "two
independent judgements … only a person can say which is right"), so that check is the grade. D1 picks
the arm. Rollback: revert the builder call; no schema change.

### P2. Tell the fixer when its approach already failed (prompt only)

Every fix round asks for the root cause before the edit (paper rewrite 6). When the source that loops
back also looped back in the previous round, meaning the same check still fails after a fix whatever
its wording, 07's fix prompt also says so: which rounds, that the approach taken then did not hold, and
that it should take a different one (rewrite 28's intent, inside one lineage). The trigger is keyed on
the source step and round of the `fix_loop.requested` events, never on diagnosis text, since
fingerprints split on rewording (F7). 08c keeps its own `buildRecurringNote`. Verification:
prompt-builder unit tests (a repeat adds the block; a first occurrence, or a different source, does
not); in the field, rounds-to-green and gate-2 rejections on tasks with a repeat, before and after by
P0's stamp. Rollback: prompt only; revert.

### P3. Run the next fix round on another CLI, for this task only

A task-scoped choice that never writes a user preference; with nothing chosen, dispatch resolves
exactly as today. Offered in two places: both escalation gates, as "run the next round on: the same
CLI, or one of the enabled providers", and `06-run-config` as an opt-in, "when a check fails again
after a fix round, run the next round on …", off by default. The worktree stays, so the best state so
far is kept: AIDE's fork of the champion, and the argument Haive already made for per-seat providers
in 08c (F9). The automatic half reuses P2's repeat signal. Verification: resolution unit tests; live,
a task forced into a repeat runs its next 07 on the chosen provider, and a SELECT of both preference
tables is identical before and after. Rollback: the setting is additive and defaults off; removing it
restores today's resolution.

### P4. Bound plan chat's plan and transcript

The focus node's neighbourhood keeps its bodies, and every other node arrives through the bounded
index (`renderBoundedPlanIndexParts`: titles and ids, depth stepped down to fit, the reduction stated),
so a patch to another node still has its id. The prompt names `.haive-data/plan.md` in the workspace
for any other body, and says the mirror can trail the canvas by one sweep. The transcript keeps its
newest turns whole and older ones as one line each, stating the omission. Verification: the prompt for
the 800-node plan stays under the provider-neutral bound; a turn that patches a node outside the
neighbourhood by id still lands; the ollama run in F4 no longer fails on size. D2 settles the
transcript's scope. Rollback: revert the call.

### P5. Bound the remaining plan renders

`11f-plan-reconcile` and `01f-external-plan-sync` move to the bounded index, keeping depth 4 where it
fits, which needs a depth parameter on `renderBoundedPlanIndexParts`. A source-scan test then pins the
invariant for every later caller: no step prompt calls `renderPlanMarkdown` directly; prompts get the
plan through the bounded helpers. Verification: that test fails on `main` and passes after; the 11f
prompt for the 800-node plan stays under the bound. Rollback: revert.

### P6. Make test edits during a fix visible, and ask for the behaviour fix

Cheap half first:

- Each fix prompt (07's fix pass, 08b's fix pass and the DAG fix coder) gets one line: the defect is
  re-checked by checks the fixer cannot see, so fix the behaviour, and change a test's expectation only
  where the spec says it is wrong, naming that spec line in the reply.
- Gate 2, and gate 3 when no gate-2 decision exists, lists the test files a fix pass changed, with the
  round and the diff of each, as display copy under the rules the similar-sites row follows. 07b and
  08c are told which test files a fix pass changed, as Haive-derived paths.

The heavier half is conditional on the cheap half showing test edits beside gate-2 rejections: re-run
the failing tests as they stood before the fix pass against the fixed code, a check the fixer never
sees. Verification: prompt tests, the gate row rendered from a fixture, and field counts. Rollback:
display and prompt only.

### P7. A cheaper model on a narrow, high-volume seat (configuration, no code)

F9 means nothing needs building. On the dev install, point `03-plan-sequence`'s `expand` seat at a
cheaper provider, run one wave per provider on the same plan, and compare as P1 does, plus tokens and
failures. Local only: the preference is a user setting on the dev install, snapshotted before the run
and restored after. If the cheaper seat holds up, D4 decides whether it becomes a product default.
Rollback: restore the snapshot.

### P8. Grade LLM-step changes on fixed inputs (larger; conditional)

A replay set of stored step inputs (`detect_output` and the dispatched prompt) for steps whose outcome
can be graded by something the prompt under test cannot see: the sequence step's orders against a
person-checked order on a held-out plan, and reviewer prompts against known defects (the untracked
review-corpus harvester already holds Codex and Greptile findings on this repository's own PRs). A
fixed budget per run, at least three runs per arm, and the spread reported beside the mean. It is the
vehicle for F13's reviewer ablation, for the spec writer's ~40k plan-index experiment that
`_plan-index.ts` names, and for P1's second arm at scale. Build it only once P1 and P2 show whether
field comparison by P0's stamp is enough. Rollback: tooling only.

## Open decisions

- **D1.** P1: keep parity (96k) or adopt the role-sized arm, decided by P1's measurement.
- **D2.** Plan chat's transcript: one conversation per node across tasks, as today, or one per task.
- **D3.** P3: the gates only, or the automatic opt-in as well.
- **D4.** A cheaper provider for narrow seats as a product default, or user configuration only.
- **D5.** F11: collapse repeated lines in test output before the tail cut (structural, with no banner
  matching), parked until more 08b runs exist.
- **D6.** F12: split AGENTS.md into a lean core plus per-area files loaded only where the work is. A
  dev-side restructure, the user's call, outside these phases.
- **D7.** The step CLI switch sits under `/tasks/:id/…` but writes a user-wide preference. Outside this
  plan's scope, found while checking F7; P3 does not depend on it changing.

## Decided

None yet.

## Critical files

- `packages/worker/src/step-engine/steps/plan/03-plan-sequence.ts` (`buildWave`,
  `buildSequencePrompt`, `SequenceDisagreement`, `SEQUENCE_AGENTS_PER_WAVE`)
- `packages/worker/src/step-engine/steps/plan/_plan-expansion-context.ts`
  (`buildPlanExpansionContext`, `PLAN_EXPANSION_CONTEXT_MAX_CHARS`)
- `packages/worker/src/step-engine/steps/plan/_plan-index.ts` (`renderBoundedPlanIndexParts`)
- `packages/worker/src/step-engine/steps/plan/01-plan-chat.ts` (`buildChatPrompt`, `detect`)
- `packages/worker/src/step-engine/steps/workflow/11f-plan-reconcile.ts`,
  `packages/worker/src/step-engine/steps/workflow/01f-external-plan-sync.ts`
- `packages/shared/src/plan/render.ts` (`renderPlanMarkdown`)
- `packages/worker/src/step-engine/steps/workflow/_fix-loop.ts` (`detectFixLoopOscillation`,
  `buildFixLoopEscalationSchema`, `buildOscillationEscalationSchema`, `loadPriorFixContext`)
- `packages/worker/src/step-engine/steps/workflow/07-phase-2-implement.ts` (fix framing)
- `packages/worker/src/step-engine/steps/workflow/08b-test-management.ts` (fix pass,
  `buildTestFailureDiagnosis`, `runTestCommand`)
- `packages/worker/src/step-engine/steps/workflow/08c-code-review.ts` (`buildRecurringNote`)
- `packages/worker/src/step-engine/dag-executor.ts` (the DAG fix coder's prompt)
- `packages/worker/src/step-engine/step-runner.ts` (per-seat `resolvePreferredCli`)
- `packages/worker/src/step-engine/steps/workflow/06-run-config.ts` (the round cap; P3's opt-in)
- `packages/api/src/routes/tasks/steps.ts` (the step CLI switch)
- `packages/database/src/schema/tasks.ts` (`cliInvocations`, for P0)

## Re-measuring

Read-only, on the dev database (`docker exec haive-postgres psql -U haive -d haive`). Prompts join to
their step through `task_step_id`; a step recap's run carries `summary_for_step_id` instead.

- **Prompt size and cache use per step (F1, F3).** Percentiles of `length(prompt)` and of
  `token_usage->>'cacheCreationTokens'` and `->>'cacheReadTokens'`, grouped by `task_steps.step_id`,
  split at a date to compare before and after a change (or by P0's stamp once it exists). On this
  install only claude-code rows (and amp's) carry `cacheCreationTokens`; `cacheReadTokens` comes from
  most providers.
- **Own-node links (F2).**

  ```sql
  with m as (
    select m.id, m.raw_output,
      substring(ci.prompt from position('## Your node' in ci.prompt)
        for greatest(0, position('Decide the order' in ci.prompt) - position('## Your node' in ci.prompt))) as own
    from task_step_agent_minings m
    join task_steps ts on ts.id = m.task_step_id
    join cli_invocations ci on ci.id = m.cli_invocation_id
    where ts.step_id in ('03-plan-sequence', '00-plan-sequence')
      and m.raw_output is not null and position('## Your node' in ci.prompt) > 0),
  own_ids as (
    select m.id, array_agg(x[1]) as ids
    from m, regexp_matches(m.own, 'node:([0-9a-f-]{36})', 'g') x group by m.id),
  links as (
    select m.id, mm[1] as from_id, mm[2] as to_id
    from m, regexp_matches(m.raw_output,
      '"op":\s*"link",\s*"fromRef":\s*"node:([0-9a-f-]{36})",\s*"toRef":\s*"node:([0-9a-f-]{36})",\s*"kind":\s*"depends_on"',
      'g') as mm)
  select count(distinct m.id) as agents, count(l.*) as links,
    count(l.*) filter (where l.from_id = any(o.ids) and l.to_id = any(o.ids)) as within_own_node
  from m join own_ids o on o.id = m.id left join links l on l.id = m.id;
  ```

  The pattern reads `depends_on` link ops written in `op`, `fromRef`, `toRef`, `kind` order: 5,322 of
  the 9,333 `link` ops in the stored replies match it, and the rest use another key order or another
  kind. The two prompt markers are text `buildSequencePrompt` emits today; re-check them before reuse.
- **Plan chat (F4).** The plan's size is `position('## The user is looking at' in prompt) -
  position('Here is the WHOLE plan' in prompt)`, and the transcript's is the span from `## Conversation
  so far` to `## What to do`.
- **Fix-pass test edits (F8).** For `08b-test-management` rows, `output->>'fixPasses'` beside the
  lengths of `output->'testsUpdated'`, `'testsCreated'` and `'testsDeleted'`, and
  `output->>'testsPassed'`.
- **Repeated lines (F11).** Split each `fix_loop.requested` diagnosis in `task_events` on newlines and
  compare the characters of all lines against those of the distinct lines, per source step.
