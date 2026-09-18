# One bad reference must not cost a whole reply

> **SHIPPED — and the remedy is this plan's own, not a substitute.** Re-measured 2026-09-18.
> `dropUnresolvableOps` (`shared/src/plan/apply-patch.ts:233`) runs as a PRE-FLIGHT at `:709`
> whenever a caller passes `onUnresolvableRef: 'drop'`, removing the ops that cannot resolve rather
> than letting the first of them abort the transaction and take the rest with it. Every AGENT path
> passes it, through `applyAgentPatch` (`_plan-prompt.ts:303`): the expansion fan-out
> (`01-plan-build.ts:707`), `02-plan-coverage.ts:572`, `01-plan-chat.ts:259` and
> `03-plan-sequence.ts:508`.
>
> **`fail` stays the default, and that is deliberate rather than an oversight** — a person who typed
> a bad id should be told, not silently trimmed. So the api's UI edits keep it, and so do the
> deterministic writers: `03-plan-sequence.ts:259` (a chunked ordinal projection its own comment
> calls "a projection being brought up to date, not a unit of intent"), `:794` (`origin: 'user'`),
> `02-advisory-decision.ts:170` (a form the person submitted) and `plan/task-link.ts:68` (recording a
> fact that already happened).
>
> Three details are load-bearing. The drop is a PRE-FLIGHT, so nothing half-applies and the
> transaction's all-or-nothing guarantee is untouched. Refs are normalised ONCE, feeding both the
> pre-flight and the op loop, because a `node:<uuid>` prefix was itself a measured cause — 11 of 13
> unknown-reference drops carried one. And the drop ITERATES to a fixed point, so a dropped upsert
> cascades to the ops naming its temp id; one pass would have kept a link and re-broken the patch.
>
> **What is NOT measured is whether the 27% loss rate below actually fell.** The figures in
> `ApplyPlanPatchOptions` are this plan's own PRE-fix measurement plus a counterfactual ("dropping
> just those links would have landed 191 nodes"), not a post-fix observation; confirming it needs a
> large plan build on a live install. Coverage exists at both levels meanwhile —
> `drop-unresolvable.test.ts` pins the helper (the cascade, a temp-ref chain, the `self` alias, the
> prefixed-ref composition) and `plan-canvas-smoke.ts:307` drives `applyPlanPatch` with the mode.
>
> **Corrected 2026-09-18:** an earlier version of this blockquote called the fix a separate
> `drop-unresolvable.ts` module "at a different layer", and read the throws at `:356`/`:692` as proof
> the plan's mechanism had not shipped. There is no such module — only its test file — and those
> throws are reachable only under `fail`. `:692` is a different rule again: it refuses to resurrect a
> stale uuid as a NEW node, which is correct and is not this plan's defect.

## Context

The previous fixes made plan-build failures visible for the first time. What
they revealed, on a rebuild of the 687-node `vareska` plan: **22 of 82 expansion
agents (27%) had their patch rejected**, every one for the same reason —

```
plan patch not applied: plan node '<uuid>' not found
```

A patch is ONE transaction, so a single unresolvable reference in a 30 KB reply
discards everything in it. MEASURED across those 22 replies:

| where the bad uuid sits | count |
| ----------------------- | ----- |
| `link.toRef`            | 17    |
| `upsert.parentRef`      | 5     |
| `link.fromRef`          | 3     |
| `unlink.toRef`          | 2     |

So this is NOT mainly agents mistyping their own parent — only 3 of 22 bad ids
are near-misses of the agent's own node. It is agents naming OTHER nodes in
cross-links, and taking their own good work down with them.

The cost, measured: **16 of the 22 are recoverable by dropping the bad
link/unlink ops alone, which would have landed 191 nodes.** The other 5 carry a
bad `upsert.parentRef` worth 60 more.

The principle this plan establishes: **an unresolvable reference costs the OP
that carries it, never the reply that contains it.** A dropped link loses an
edge; a dropped reply loses a subtree.

**Rollback.** The new behaviour is opt-in per call (`onUnresolvableRef`), so
reverting the flag restores today's strictness. No schema change, no migration.

## A. Drop the offending op, keep the rest

`packages/shared/src/plan/apply-patch.ts`

`ApplyPlanPatchOptions` gains `onUnresolvableRef?: 'fail' | 'drop'`, defaulting
to **`fail`** — a person editing a plan in the UI who names a bad id must still
be told, not silently trimmed. Only agent patches opt into `drop`.

Under `drop`, a pre-flight pass before the op loop:

1. Resolvable = the temp refs this patch introduces (upsert `nodeRef`s) ∪ the
   uuid-shaped refs that are live rows in THIS repository. One `inArray` query,
   not one per op.
2. Drop `link`/`unlink` ops naming an unresolvable ref.
3. Drop an `upsert` whose `parentRef` is unresolvable — losing one node rather
   than the twelve around it.
4. **Cascade until stable**: dropping an upsert invalidates the temp ref it would
   have introduced, so ops naming that ref go too. Iterate rather than single-pass
   — a temp ref chain is the normal shape of these replies, not an edge case.

The transaction contract is untouched: ops that would fail are never submitted,
rather than being applied and rolled back piecemeal.

The result gains what was dropped, so the caller can report it.

## B. `self` — the ref an expansion agent should never have to type

An expansion agent decomposes exactly ONE node and must currently transcribe that
node's 36-character uuid to parent its children to it. `ApplyPlanPatchOptions`
gains `selfNodeId?: string`; seeding `refs.set('self', selfNodeId)` before the op
loop makes `"parentRef": "self"` resolve through the EXISTING map with no new
resolution logic (`planNodeRefSchema` is already any short string).

The builder derives it from the agent id it is folding —
`plan-expand-<uuid>-p<N>` already carries the node. The expansion prompt then
tells the agent to use `"self"` for the node it is expanding, and to link only
ids it was actually shown.

## C. Say what was dropped

The builder records a partial drop on the agent's mining row, reusing the durable
record added last time but with a DISTINCT prefix — the patch applied, so it must
not read as a failure. That distinction is load-bearing: `askedState` re-asks a
node only on `plan patch not applied:`, and a node that got its children must not
be re-asked. A different prefix gives that for free.

## Files

- `packages/shared/src/plan/apply-patch.ts` (option, pre-flight, `self`, result)
- `packages/worker/src/step-engine/steps/plan/_plan-prompt.ts` (`applyAgentPatch`
  passes both options; contract text for `self`)
- `packages/worker/src/step-engine/steps/plan/01-plan-build.ts` (derive
  `selfNodeId`, record partial drops, expansion prompt)
- Tests beside each.

## Verification

1. Unit on `applyPlanPatch`: a bad link drops the link and KEEPS the upserts; a
   bad `parentRef` drops only that upsert; a dropped upsert cascades to ops naming
   its temp ref; `self` resolves; and the default `fail` mode is byte-for-byte
   unchanged — that last one guards every existing caller.
2. **Replay the 22 real rejected replies.** They are still in
   `task_step_agent_minings`. Apply each against a THROWAWAY repository under the
   new option and count nodes created; expect ~16 to apply cleanly and roughly 191
   nodes to land. This is the only check that uses the inputs that actually
   defeated the applier. Delete the throwaway repo afterwards.
3. `pnpm --filter @haive/worker smoke:plan-canvas` — it covers the applier against
   a real Postgres, including the "a failing op rolls the WHOLE patch back" case,
   which must still hold under the default.
4. Per-container tsc, prettier, vitest in shared and worker.
5. Then, with the user's approval already given: re-run the `vareska` build. It
   MERGES, and the 17 childless nodes have no children, so they return to the
   frontier and are re-asked with the fix in place. Re-audit afterwards against
   the document and report the node count and the new rejection rate.
