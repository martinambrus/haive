# Whole-reply losses to two deliberate guards

> **NOT STARTED — recorded 2026-09-19, no design chosen.** `plan-patch-drop-measurement`'s Part B
> read every plan agent's mining row on the dev install and found two more classes where one flaw
> costs a WHOLE reply, the same shape `plan-patch-partial-refs` removed for unresolvable refs. Both
> come from a guard that is right to exist, so neither is a bug to patch. Each needs a decision about
> what the guard should give up, which is why they were split out of `plan-patch-gap-sweep` instead
> of fixed there. The evidence below is quoted from the rows, so the decision can be made without
> re-measuring.

## 1. A malformed code link rejects the reply it rides on

**Measured:** 2 of the 81 agents of `10_8-plan-build` on the dev install, both stamped
`plan patch not applied: plan patch rejected: plan patch failed validation:`

- `ops[0].codeLinks[0..2].repoPath` — "Invalid input: expected string, received undefined". Three
  links on one op carried their path under some other key.
- `ops[3].codeLinks[0].symbol` — "Too big: expected string to have <=512 characters".

**Mechanism.** `applyPlanPatch` validates the WHOLE patch with `planPatchSchema.safeParse` before any
op runs, and a failure is `PlanPatchError('invalid')`. `applyAgentPatch` turns `invalid` into a
re-prompt on a non-final attempt, so both rows are FINAL attempts. By then a code link, which is an
annotation on an op, had cost the op, its subtree and every other op in the reply.

**What a fix has to decide:**

- Whether, under `drop`, an invalid code link is stripped and its op kept, or the re-prompt stays
  the answer. A strip gives up the retry that might have produced a well-formed link.
- **The report channel, which is load-bearing, not cosmetic.** `ApplyPlanPatchResult.dropped` holds
  exactly one entry per dropped OP, and two readers do arithmetic on that. Plan chat records
  `outcome.applied = ops.length - dropped.length` (`24d5245d`); 11f and 01f compute
  `applied = chosen.length - dropped.length` (`744ce132`). A stripped link written into `dropped`
  would make every one of those counts wrong. It needs its own field.

## 2. The breadth cap rejects a coverage repair outright

**Measured:** 10 of the 231 agents of `02-plan-coverage`, each stamped `plan patch not applied:
breadth cap 12 exceeded (<node>: <existing> existing + <new> new = <total>)`. The figures, as
existing + new: 9+9, 0+13, 7+9, 10+6, 8+8, 11+11, 10+10, 19+3, 8+8, 9+10.

**Mechanism.** `assertPlanPatchWithinBreadth` (`steps/plan/_plan-breadth.ts`) enforces the build's
breadth choice (`breadthCap`, a form value from 2 to 12, default 6; these builds chose 12)
"transactionally for every plan-producing agent. An over-wide reply is rejected before any operation
lands." Coverage passes `retryable: false`, so the repair is simply lost, and the gap it was filling
stays open until a later coverage pass lists it again.

**Two rows the fix must not get wrong:**

- `19 existing + 3 new` — the node was already over the cap before this agent added anything. No
  coverage reply can add even one child there, however it is worded.
- `0 existing + 13 new` — one reply proposing 13 siblings under an empty node. This is exactly what
  the cap exists to refuse, so here the guard is right.

**What a fix has to decide:** whether a coverage agent may add an intermediate grouping node, gets
retried with the cap in its prompt, has its excess trimmed, or whether the cap should count only NEW
children for a node already past it. The two rows above point in opposite directions, so no single
rule is obviously right.

## Rollback

Nothing is built. Whatever is chosen should stay behind `onUnresolvableRef: 'drop'` (for code links)
or be scoped to coverage (for breadth), so that human edits and the plan builder keep today's
behaviour.
