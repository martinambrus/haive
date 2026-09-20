# Whole-reply losses to two deliberate guards

> **DONE 2026-09-19, as built below.** `663ef973` makes a malformed code link cost the link, not
> the reply. `38911203` makes the breadth guard count a `node:`-prefixed parent's children, and
> `b9085ad4` makes a coverage repair see the node it repairs. `a9ec07e1` stops a partially applied
> plan-build wave from being re-rolled; that loss was found beside these ones. **What this plan
> recorded but left alone was then fixed on 2026-09-20** — `dac734bf`, `f304136e` and `cc789f2b` —
> and the fourth item was dropped on its own measurement. See "Follow-ups" below.
>
> **Both designs this plan first leaned toward rested on wrong premises.** Each section corrects its
> own:
> - No caller re-prompts an agent for an invalid patch, so "strip only on the final attempt" had no
>   retry to protect.
> - The breadth refusals came from a repair prompt that told the agent its node had no children, not
>   from agents writing too widely.
>
> Verified:
> - `plan-canvas-smoke` passes 112 of 112 checks;
> - both recorded code-link replies now validate;
> - a repair prompt built from a real plan lists its node's existing children;
> - in the browser, a chat turn names the link it could not record, and the header still counts the
>   change.
>
> The shared, api and worker typechecks, which now cover test files too, all pass.

## 1. A malformed code link rejects the reply it rides on

**Measured:** 2 of the 81 agents of `10_8-plan-build` on the dev install. Both were stamped
`plan patch not applied: plan patch rejected: plan patch failed validation:`

- `ops[0].codeLinks[0..2].repoPath`, with "Invalid input: expected string, received undefined".
  That summary names only the first three links. **Replayed as built:** the reply's 18 ops carried
  59 links, and every one put its path under `"path"`. The contract's own example uses
  `"repoPath"` (`_plan-prompt.ts`), so this is a model deviation, not an unclear contract.
- `ops[3].codeLinks[0].symbol`, with "Too big: expected string to have <=512 characters". Two such
  symbols appeared in a 19-op reply.

**Mechanism.** `applyPlanPatch` validates the WHOLE patch with `planPatchSchema.safeParse` before any
op runs, and a failure is a `PlanPatchError('invalid')`. A code link is an annotation on an op, yet
it cost the op, its subtree and every other op in the reply.

**Corrected:** this section used to say the rows were FINAL attempts, because `applyAgentPatch`
re-prompts on the earlier ones. Neither half holds:
- The `plan patch rejected:` prefix exists only when `retryable` was true, so these were not final
  attempts.
- No caller re-prompts at all. plan-build's `apply()` and plan chat each catch the
  `RetryableParseError` themselves, and coverage and sequencing pass `retryable: false`.

So "strip, and give up the retry" gave up nothing.

**As built, `663ef973`:**
- **Option:** `onInvalidCodeLink: 'strip'` removes only the links that fail `planCodeLinkSchema`, and
  their ops land. The default stays `fail`, so a person editing in the UI is still told.
- **Callers:** every agent patch opts in through `applyAgentPatch`. So do 11f and 01f: their approved
  ops are agent-written, and their form never shows a link it cannot read.
- **The report channel:** stripped links go in `ApplyPlanPatchResult.strippedCodeLinks`, never in
  `dropped`. `dropped` stays one entry per op, because plan chat, 11f and 01f compute "applied" as
  ops minus `dropped.length`. Each caller surfaces them differently:
  - plan chat notes them in the transcript;
  - 11f and 01f add a sentence to their summary;
  - plan-build and coverage only log them, and stamp nothing.

  A PARTIAL stamp would have coverage offer a repair agent for a lost annotation.

The cost is plain in the replay: the strip recovers all 18 ops of the first reply, and none of its 59
links.

## 2. The breadth cap rejects a coverage repair outright

**Measured:** 10 of the 231 agents of `02-plan-coverage`, each stamped `plan patch not applied:
breadth cap 12 exceeded (<node>: <existing> existing + <new> new = <total>)`. The figures, as
existing + new: 9+9, 0+13, 7+9, 10+6, 8+8, 11+11, 10+10, 19+3, 8+8, 9+10.

**Mechanism.** `assertPlanPatchWithinBreadth` (`steps/plan/_plan-breadth.ts`) enforces the build's
breadth choice: `breadthCap`, a form value from 2 to 12, default 6, and these builds chose 12. It
rejects an over-wide reply before any operation lands, and coverage passes `retryable: false`.

**Corrected: the agents were not writing too widely; the prompt was false.**
- **What the prompts said:** 9 of the 10 were manual structural repairs (`cover-node-*`) of nodes
  whose decomposition had been THINNED by a partial apply. Every one of the 9 prompts said "it
  currently has no children. Rebuild the missing subtree", to a node with 7-19 children.
- **What the agents could see:** a titles-only listing cut at `slice(0, 60_000)`. All 9 were cut at
  exactly 60,002 characters, and only 1 of them contained the node at all.
- **What they did:** five of the refused replies re-added exactly as many children as already
  existed (8+8, 9+9, 10+10, 11+11, 9+10). That is the same subtree again: the cap was keeping
  duplicates out.
- **What landed:** 7 of the 10 partial repairs that DID land added 2-12 children each. Whether they
  duplicated anything cannot be checked, because every repaired node has since been deleted (0 of
  21 exist).

**Two more claims here were wrong:**
- **"The gap stays open until a later pass lists it again"** was false for 9 of the 10.
  `findStructuralGaps` reported a rejected attempt only on a CHILDLESS node, so a refused repair of a
  thinned node dropped off the gate for good.
- **The guard under-counted.** It read refs before the applier strips their `node:` marker, so a
  prefixed parent counted 0 existing children. 4 of 231 coverage replies parented that way.

**The two rows the fix had to get right:**
- `19 existing + 3 new`. The build gave that node 8 children, and no mining reply names it as a
  parent, so the other 11 arrived through a writer the guard never runs on (chat, a UI edit, an
  import). A node past the cap is therefore a legitimate state. The prompt now handles it: add
  nothing directly under the node, or reply with an empty patch.
- `0 existing + 13 new`. The guard is right here. The refusal's own counts now reach the next
  attempt.

**As built:**
- **`38911203`:** the guard classifies refs through the applier's own `stripNodeRefPrefix`.
- **`b9085ad4`, the prompt:**
  - A structural repair reads its node's live neighbourhood through `buildPlanExpansionContext`, the
    view that plan-build and coverage's automatic wave already use. It lists the target, its
    ancestors, its siblings and every existing child, with exact refs.
  - The instruction follows the live child count. It names the children already there, asks only
    for what is missing, and says how much room is left under the cap.
- **`b9085ad4`, the gap scan:**
  - `findStructuralGaps` carries each gap's stamp, minus its prefix, as `detail`, and the prompt
    quotes it as what the previous attempt lost.
  - The scan also offers again a node that has children and whose latest attempt was rejected.

No retry machinery was added: the gate's existing re-offer carries the refusal to the next attempt.

**Found beside it, `a9ec07e1`:** plan-build re-rolled a whole wave when `failures.length ===
fold.length`, but `failures` also reports PARTIAL applies, whose nodes had already landed. A
one-agent wave whose reply landed with one dropped op would therefore be re-rolled and folded twice.
The re-roll now counts only agents that wrote nothing.
- **Evidence:** this is a code-level finding with no instance on record. The three plan-root
  re-rolls on the dev install followed transient CLI failures.
- **Test:** the new test fails on the old condition.

## Follow-ups, done 2026-09-20

Three of the four things this plan recorded but did not fix are now fixed, and the fourth is
dropped on its own measurement.

- **`dac734bf` — the dead retry translation is gone.** `applyAgentPatch` turned `invalid` into a
  `RetryableParseError` that no caller could act on: plan-build and plan chat catch every apply
  error themselves, coverage and sequencing asked for no retry, and plan chat declares no
  `llm.retry`, so a rethrow would have failed the step rather than re-rolled it. MEASURED across
  1,523 plan agent rows: no invalid patch at all besides the 2 fixed above. A stamp now reads
  `plan patch not applied: plan patch failed validation: …`.
- **`f304136e` — a stripped code link is reported, not just logged.** plan-build and coverage
  record a `plan.code_links_dropped` task event with the agent id, the count and the first 5
  entries. The Activity tab renders any event type, so no web change was needed. Still not the
  mining stamp: its prefixes drive `findStructuralGaps` and `askedState`, and a stripped link
  costs no op.
- **`cc789f2b` — a section repair reads a bounded index.** Its plan listing was
  `slice(0, 60_000)`, and `renderPlanMarkdown` spends 150-250 characters per node, so it stopped
  around 300-400 nodes and could cut a `node:<uuid>` in half. The spec writer's depth ladder
  (`steps/plan/_plan-index.ts`, moved out of 04-phase-0b so both steps share it) replaces it:
  VERIFIED on a 507-node plan, a 10,446-character index, the reduction stated, and all 23 refs
  whole. `CoverageDetect.planMarkdown` went with it — nothing read it, and it stored a full plan
  render on every coverage step row.

**DROPPED — the breadth guard ignoring a move.** An upsert that re-parents an existing node takes
a child slot at its destination and the guard does not count it. MEASURED across 636 plan-build
and coverage replies: 12 ops carry a uuid `nodeRef` and none of them carries a `parentRef`, in
either key order. Agents do not move nodes, so a current-parent lookup would be built for a case
that has never occurred. Re-run this if one ever shows up:

```sql
select ts.step_id, count(*) as move_ops
from task_step_agent_minings m join task_steps ts on ts.id = m.task_step_id
where m.raw_output ~ '\{[^{}]*"nodeRef"\s*:\s*"(node:)?[0-9a-f-]{36}"[^{}]*"parentRef"'
group by 1;
```

## Rollback

Every change is code only: no schema change, no migration and no data rewrite, and each commit
reverts on its own.
- `onInvalidCodeLink` defaults to `fail`, so a revert restores whole-patch rejection.
- `strippedCodeLinks` is an additive result field.
- `StructuralGap.detail` is optional in the persisted `detect_output`, so a revert simply ignores
  it.
- The prompt text and the guard's normalisation apply to new dispatches and replies only.
