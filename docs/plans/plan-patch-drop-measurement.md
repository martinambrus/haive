# Measure what the unresolvable-ref drop actually saved

> **DONE 2026-09-18 — measured, and the residual Part A predicted was real; fixed in
> `76e1d542`, with drops recorded where they had been thrown away in `0c70ac1b`.**
>
> Part B answered the headline question. Across the **393** plan-build expansion agents recorded
> since the drop landed (`aaaf4fef`, 2026-08-30), **0** replies were lost to an unresolvable ref,
> against 22 of 82 (27%) before it. The drop ENGAGED 20 times across plan-build and coverage, so this
> is not the absent-signal reading the outcome table warns about. What this cannot separate is how
> much of the zero is the drop and how much is fewer bad refs at the source: only 10 of those 393
> replies had any op dropped, and two changes cut refs at the source over the same window — the
> `self` alias, which landed in `aaaf4fef` itself, and `b05b7112`'s `node:` prefix strip, whose own
> measurement put 11 of 13 unknown-reference drops on that prefix.
>
> Part A's hypothesis held, in the smoke AND in the field: four `03-plan-sequence` replies of 16-45
> ops each were lost whole to one mistyped uuid in an upsert's OWN `nodeRef`, and never re-asked. The
> fix goes further than the one line this plan proposed, because reading the op loop turned up two
> more classes no pre-flight can see — a temp id that only a LATER upsert introduces, and a node that
> an EARLIER op of the same patch deleted. So under `drop` the op loop now skips an op whose ref does
> not resolve AT ITS POSITION, not just the pre-flight.
>
> The plan's assumption that "the `dropped` report makes the loss visible" was true for 01 and 02
> only. Plan chat never read the report and 03 never recorded it, so without `0c70ac1b` the
> fix would have turned a visible failure into a silent drop in exactly the two places it bites.

## Why the code-level answer is not enough

`dropUnresolvableOps` (`shared/src/plan/apply-patch.ts:233`) runs as a pre-flight at `:709`
(`:715` as built) under `onUnresolvableRef: 'drop'`, and every agent path passes that option
through `applyAgentPatch` (`_plan-prompt.ts:303`). That much is verified. What it does NOT tell us
is whether agents still lose replies in practice, and to what — a mechanism can be correct and still
be bypassed by the shape of real output.

## Part A — the residual class, answerable without the dev stack

**Code-verified 2026-09-18, three facts that compose into one gap:**

1. `refsOf` inside `dropUnresolvableOps` returns **only `parentRef`** for an upsert.
2. The upsert's own `nodeRef` IS added to `wanted`, so a **live** uuid becomes resolvable for sibling
   ops — but it is never passed through the `bad` filter, so a **dead** uuid is not a reason to drop
   the op.
3. There is **no `try`/`catch` anywhere in `apply-patch.ts`** (grep confirms zero), so a throw from
   the op loop aborts the transaction and reaches `applyAgentPatch`, which does NOT retry
   `not_found`. **As built:** there is exactly one now, in the op loop, and it catches only the
   private `UnresolvableRefError` under `drop` — every other refusal still fails the patch.

`applyUpsert` then throws `not_found` at `:692` for a uuid ref resolving to nothing. That throw is
deliberate and correct as a RULE — creating a node under a stale id "would resurrect something the
author believed still existed, under an id other rows may already reference" — but under `drop` it
still costs the whole reply.

**Hypothesis to test:** a patch containing one upsert whose `nodeRef` is a DEAD uuid, alongside
otherwise valid ops, loses everything even with `onUnresolvableRef: 'drop'`.

**CONFIRMED 2026-09-18, in both places it could be.** The smoke check below threw
`PlanPatchError('not_found')` after 25 passing checks, against a baseline run of 107/107 on the
unmodified smoke. In the field, every `not found` failure on a mining row is this class, and all
four are sequencing replies — the step where every op an agent may emit is an upsert naming a uuid:

| step | agent row | ops lost | uuid the agent wrote | nearest uuid in its prompt | chars differ |
|---|---|---|---|---|---|
| `03-plan-sequence` | `plan-seq-3a68e78d…-p2` | 18 | `037754ef-e267-45c3-8b1a-3180cb9ff2f0` | `037754ef-e267-49db-b6af-3180cb9ff2f0` | 7 |
| `03-plan-sequence` | `plan-seq-b37e8b66…-p13` | 45 | `5d828d76-b4cd-4d21-8212-7471520d0fb3` | `…-4d27-…` | 1 |
| `00-plan-sequence` | `plan-seq-8f3722eb…-p13` | 28 | `e72ca666-9085-4999-82bf-f4b8adc43fd1` | `…-f4b8acd43fd1` | 2 |
| `00-plan-sequence` | `plan-seq-3ccf95f4…-p14` | 16 | `feeb35e3-5b71-471e-9f81-358878f5f776` | `…-81b8-…` | 4 |

None of the four uuids appears in its own prompt (each prompt carried ~920), and all four appear in
the agent's raw output, so these are TRANSCRIPTION errors — a digit, a transposed pair, a scrambled
segment. Ops are counted as `"op":` occurrences in the raw reply, because `output` is null on a row
whose patch failed. Each loss was permanent: all four rows are `status = 'done'`, and `askedParents`
(`shared/src/plan/sequence-progress.ts`) counts any row as asked, so none of those parents was ever
ordered. The four plans have since been deleted, which is why the nearest-uuid comparison is against
the PROMPT rather than against live nodes.

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

**As built:** section 8.5 of the smoke (`plan-canvas-smoke.ts:380`) uses a node deleted in section 7
as the dead uuid, and carries two more checks for the positional classes below. The smoke is
110/110 with the fix. `drop-unresolvable.test.ts` gained the two cases it CAN reach — an update
whose own node is gone is dropped, an update of a live node is kept.

**If it holds, the fix is one line — and it is a behaviour DECISION, not a tidy-up.** Including a
uuid-shaped `nodeRef` in `refsOf` for upserts would drop that op instead of failing the patch. The
cost is that the node the agent meant to UPDATE silently keeps its old content, where today the agent
is told the whole reply failed. Decide it deliberately; the plan's own reasoning — lose an edge, not
the twelve children — points at dropping, and the `dropped` report makes the loss visible rather than
silent.

**As built — decided for dropping, and more than one line, for three reasons found while doing it:**

- **The report was not visible everywhere.** Plan chat discarded `ApplyPlanPatchResult.dropped`
  entirely, and `03-plan-sequence`'s `foldSequenceResults` never wrote it. Dropping there would have
  swapped a visible `not found` for nothing at all. `0c70ac1b` records both: 03 stamps the
  partial prefix on its mining row the way 01 and 02 do (keeping its remit note, since the partial
  stamp replaces the remit stamp on the same row), and plan chat appends `_N change(s) not applied:
  …_` to the assistant's turn — verified rendered in the browser as an italic line under the reply.
- **Two classes are positional, so no pre-flight can see them.** The pre-flight reads a patch as a
  SET — `provided` counts a temp id wherever its upsert sits, and `live` is computed before any op
  runs. The op loop resolves in ORDER. A link naming a temp id that a later upsert introduces, or any
  op naming a node an earlier op deleted (including a descendant this same patch created under it),
  passes the pre-flight and then throws. Predicting either would mean re-simulating the op loop —
  moves, subtree deletes, in-patch creates — so instead `resolveExisting`'s three unresolvable cases
  and `applyUpsert`'s stale-ref refusal throw a private `UnresolvableRefError`, and under `drop` the
  loop skips that op and reports it. Every op resolves all its refs before its first write, so a
  skipped op leaves nothing half-applied. MEASURED: neither class has occurred on this install, so
  that half is prevention, not repair.
- **`applyUpsert` let a KNOWN ref resurrect.** It refused only an unknown uuid (`!known &&
  candidateId`). A ref that already named a node in this patch — a temp id, `self`, a uuid updated
  earlier — and no longer resolved fell through to `createNode`, re-creating the node under a fresh
  id. The refusal is now `candidateId` alone.

One behaviour moves with it: a positional failure used to be `invalid`, which `applyAgentPatch` turns
into a re-prompt on any non-final attempt. It is now dropped, the same trade the pre-flight already
makes for a ref that resolves nowhere. No field row shows the old path firing.

## Part B — the rate, needs the dev stack

**The evidence is already persisted per agent, so most of this is read-only SQL.**

- `01-plan-build.ts:719-740` writes `PARTIAL_APPLY_PREFIX` (`plan patch partially applied:`) plus the
  dropped list onto `task_step_agent_minings.error_message`; its failure path at `:752` writes
  `APPLY_FAILURE_PREFIX` (`plan patch not applied:`). The two prefixes differ deliberately, because
  `askedState` re-asks a node only on the failure one.
- `02-plan-coverage.ts:585` records the same pair, so coverage repairs count too.
- **NOT covered by SQL:** `01-plan-chat.ts:278` logs `droppedRefs` as a log line and has no mining
  rows at all (it is a self-targeting revise loop), so plan chat is visible only in worker logs.
  **Corrected:** that log line is the TASK PROPOSAL's `droppedRefs`, not the patch's. Plan chat
  discarded patch drops entirely — no log, no row. As built, they now reach the transcript turn.
- **A trap that will overcount losses:** `03-plan-sequence.ts:502` writes the FAILURE prefix for ops
  "outside this step's remit" — remit filtering, not an unresolvable ref. Exclude that step or read
  the messages. **Read, not excluded** — 03 is where Part A lives. Note also that 03 never wrote the
  PARTIAL prefix at all, which is why it reads `partial = 0` below; as built it does.

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

**Measured 2026-09-18.** Every row on the install post-dates the drop — no row from before
2026-08-30 11:57 UTC survives for these steps — so the 27% baseline is the documented pre-fix figure
and cannot be re-derived here.

| step | agents | partial | not_applied | lost to an unresolvable ref |
|---|---|---|---|---|
| `01` + `10_8` plan-build, expansion agents | 393 | 10 | 2 (schema validation) | **0** |
| ↳ prompts quoting ≥ 1000 uuids | 84 | 0 | 0 | 0 |
| `02-plan-coverage` | 231 | 10 | 11 (10 breadth cap, 1 no patch) | 0 |
| `03` + `00-plan-sequence` | 887 | 0 | 7 (4 Part A, 2 remit, 1 garbled ref) | **4** |

The drops inside those 20 partial applies are still the pre-fix shape: 77 of 84 are
`link: unknown ref`, then four unlinks, two loop-closing dependencies and one unknown parent. The
≥ 1000 row is the one comparable to the pre-fix build, where the defect scales with how many ids an
agent has to quote, and it is clean.

The seventh sequencing loss is a third class, not fixed here: `new plan node '9237ecad-…" == null'
needs a title` — a uuid garbled into something that is not uuid-shaped, which the applier reads as a
temp id and therefore as a CREATE. That is a contract refusal (`invalid`), not an unresolvable ref,
and it would need a remit rule in 03 rather than an applier change. One row.

**Fresh data, if the stored rows are too few to read.** The pre-fix figure came from a rebuild of the
687-node `vareska` plan with 82 expansion agents. A comparable build is what makes the numbers
comparable — a 20-node plan proves nothing in either direction, because the defect scales with how
many ids an agent has to quote. Record: total agents, `partial`, `not_applied`, and nodes created.
**Not needed:** 393 stored expansion agents, 84 of them at that scale.

## What each outcome means

| Result | Reading |
|---|---|
| `partial > 0`, `not_applied` ~ 0 | The fix works in the field. Put the figure in `plan-patch-partial-refs`'s blockquote and close the question |
| `not_applied` still material, messages naming a node id | Part A's residual class is live — fix `refsOf` |
| `not_applied` material, messages naming breadth or remit | NOT this defect. Say what it actually was and retire the question |
| No `partial` rows at all on a large build | Either no agent mistyped an id (possible — the pre-fix 27% may have been model-specific) or the drop never engaged. Distinguish by checking whether ANY historical row carries the partial prefix |

The last row is the one to be careful with: an absent signal is not evidence the fix worked, and it
is the reading this plan most easily produces by accident.

**Read 2026-09-18: rows one and two, split by step.** Plan-build and coverage are row one — done, and
the figure is in `plan-patch-partial-refs`'s blockquote. Sequencing is row two — fixed as described
under Part A. Coverage's 11 losses are row three: breadth cap and a reply with no patch, not this
defect. Row four does not apply, since 20 historical rows carry the partial prefix.

## Out of scope

- **Changing `fail` for human edits.** A person who typed a bad id should be told, not silently
  trimmed, and the api routes keep that default by design.
- **The `:692` rule itself.** Refusing to resurrect a stale uuid as a new node is correct; the only
  question here is whether a whole patch should die with it. **As built:** kept under `fail`, costs
  only its op under `drop`, and widened to refs this patch already knew (Part A, third bullet). No
  deterministic writer can reach the widening — the api's two deletes are single-op patches.

## Rollback

Part A adds a test case. Part B is read-only SQL plus one ordinary plan build — nothing to undo. Any
`refsOf` change that comes out of Part A is one line, behind the existing `drop` mode, and reverts
with the line.

**As built:** two commits, no migration and no data. Reverting `76e1d542` restores the old
applier (one bad ref costs the reply again); `0c70ac1b` reverts independently, since it only
records what the applier reports. The smoke's section 8.5 goes with the first.
