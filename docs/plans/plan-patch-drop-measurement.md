# Measure what the unresolvable-ref drop actually saved

> **NOT STARTED.** Written 2026-09-18 as the follow-up #169 named. That PR corrected
> `plan-patch-partial-refs` from "landed differently" to **shipped** after re-measuring the applier,
> and left exactly one thing open: whether the **27% reply-loss rate actually fell**. The figures in
> `ApplyPlanPatchOptions` are that plan's own PRE-fix measurement plus a counterfactual ("dropping
> just those links would have landed 191 nodes"), never a post-fix observation.
>
> **Part A needs no dev stack and should be done first** — it is a code-verified hypothesis about a
> residual class the pre-flight cannot see, and it is worth more than the headline rate. Part B is
> the rate itself and needs a live install.

## Why the code-level answer is not enough

`dropUnresolvableOps` (`shared/src/plan/apply-patch.ts:233`) runs as a pre-flight at `:709` under
`onUnresolvableRef: 'drop'`, and every agent path passes that option through `applyAgentPatch`
(`_plan-prompt.ts:303`). That much is verified. What it does NOT tell us is whether agents still lose
replies in practice, and to what — a mechanism can be correct and still be bypassed by the shape of
real output.

## Part A — the residual class, answerable without the dev stack

**Code-verified 2026-09-18, three facts that compose into one gap:**

1. `refsOf` inside `dropUnresolvableOps` returns **only `parentRef`** for an upsert.
2. The upsert's own `nodeRef` IS added to `wanted`, so a **live** uuid becomes resolvable for sibling
   ops — but it is never passed through the `bad` filter, so a **dead** uuid is not a reason to drop
   the op.
3. There is **no `try`/`catch` anywhere in `apply-patch.ts`** (grep confirms zero), so a throw from
   the op loop aborts the transaction and reaches `applyAgentPatch`, which does NOT retry
   `not_found`.

`applyUpsert` then throws `not_found` at `:692` for a uuid ref resolving to nothing. That throw is
deliberate and correct as a RULE — creating a node under a stale id "would resurrect something the
author believed still existed, under an id other rows may already reference" — but under `drop` it
still costs the whole reply.

**Hypothesis to test:** a patch containing one upsert whose `nodeRef` is a DEAD uuid, alongside
otherwise valid ops, loses everything even with `onUnresolvableRef: 'drop'`.

**Where the test belongs, and why not the obvious place.** `drop-unresolvable.test.ts` drives
`dropUnresolvableOps` directly with a stub `tx`, which cannot reach `applyUpsert` at all — the
hypothesis is about the applier, not the helper. It therefore belongs in
`packages/worker/test/plan-canvas-smoke.ts`, which already drives `applyPlanPatch` with this exact
mode at `:307` against live Postgres. Shape:

    ops: [
      { op: 'upsert', nodeRef: '<a uuid that is not in this repository>', title: 'X' },
      { op: 'upsert', nodeRef: 'child', parentRef: '<a live node>', title: 'Child' },
      { op: 'link',   fromRef: 'child', toRef: '<a live node>', kind: 'implements' },
    ]

Run it with `onUnresolvableRef: 'drop'`. **If the hypothesis holds** the call rejects with
`PlanPatchError('not_found')` and neither the child nor the link lands — one bad id costing a whole
reply, which is precisely what `plan-patch-partial-refs` exists to prevent.

**If it holds, the fix is one line — and it is a behaviour DECISION, not a tidy-up.** Including a
uuid-shaped `nodeRef` in `refsOf` for upserts would drop that op instead of failing the patch. The
cost is that the node the agent meant to UPDATE silently keeps its old content, where today the agent
is told the whole reply failed. Decide it deliberately; the plan's own reasoning — lose an edge, not
the twelve children — points at dropping, and the `dropped` report makes the loss visible rather than
silent.

## Part B — the rate, needs the dev stack

**The evidence is already persisted per agent, so most of this is read-only SQL.**

- `01-plan-build.ts:719-740` writes `PARTIAL_APPLY_PREFIX` (`plan patch partially applied:`) plus the
  dropped list onto `task_step_agent_minings.error_message`; its failure path at `:752` writes
  `APPLY_FAILURE_PREFIX` (`plan patch not applied:`). The two prefixes differ deliberately, because
  `askedState` re-asks a node only on the failure one.
- `02-plan-coverage.ts:585` records the same pair, so coverage repairs count too.
- **NOT covered by SQL:** `01-plan-chat.ts:278` logs `droppedRefs` as a log line and has no mining
  rows at all (it is a self-targeting revise loop), so plan chat is visible only in worker logs.
- **A trap that will overcount losses:** `03-plan-sequence.ts:502` writes the FAILURE prefix for ops
  "outside this step's remit" — remit filtering, not an unresolvable ref. Exclude that step or read
  the messages.

```sql
-- Partial applies (reply survived, ops dropped) against outright losses, per step.
select ts.step_id,
       count(*) filter (where m.error_message like 'plan patch partially applied:%') as partial,
       count(*) filter (where m.error_message like 'plan patch not applied:%')       as not_applied,
       count(*)                                                                     as agents
from task_step_agent_minings m
join task_steps ts on ts.id = m.task_step_id
where ts.step_id in ('01-plan-build', '10_8-plan-build', '02-plan-coverage')
group by ts.step_id
order by ts.step_id;
```

```sql
-- What the drops actually were. The pre-fix claim was 17 of 22 in a cross-link (`link.toRef`);
-- this says whether that still describes them.
select ts.step_id, m.agent_id, m.error_message
from task_step_agent_minings m
join task_steps ts on ts.id = m.task_step_id
where m.error_message like 'plan patch partially applied:%'
order by m.id desc
limit 50;
```

**Fresh data, if the stored rows are too few to read.** The pre-fix figure came from a rebuild of the
687-node `vareska` plan with 82 expansion agents. A comparable build is what makes the numbers
comparable — a 20-node plan proves nothing in either direction, because the defect scales with how
many ids an agent has to quote. Record: total agents, `partial`, `not_applied`, and nodes created.

## What each outcome means

| Result | Reading |
|---|---|
| `partial > 0`, `not_applied` ~ 0 | The fix works in the field. Put the figure in `plan-patch-partial-refs`'s blockquote and close the question |
| `not_applied` still material, messages naming a node id | Part A's residual class is live — fix `refsOf` |
| `not_applied` material, messages naming breadth or remit | NOT this defect. Say what it actually was and retire the question |
| No `partial` rows at all on a large build | Either no agent mistyped an id (possible — the pre-fix 27% may have been model-specific) or the drop never engaged. Distinguish by checking whether ANY historical row carries the partial prefix |

The last row is the one to be careful with: an absent signal is not evidence the fix worked, and it
is the reading this plan most easily produces by accident.

## Out of scope

- **Changing `fail` for human edits.** A person who typed a bad id should be told, not silently
  trimmed, and the api routes keep that default by design.
- **The `:692` rule itself.** Refusing to resurrect a stale uuid as a new node is correct; the only
  question here is whether a whole patch should die with it.

## Rollback

Part A adds a test case. Part B is read-only SQL plus one ordinary plan build — nothing to undo. Any
`refsOf` change that comes out of Part A is one line, behind the existing `drop` mode, and reverts
with the line.
