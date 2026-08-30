# A plan mined from existing code should not read as a to-do list

## Context

Building a plan from a repository's knowledge base produces a map of code that
ALREADY EXISTS, and every node of it lands `todo`. MEASURED on the dev install:
644 of 644 nodes are `todo`, 628 of them components. The plan therefore presents
a finished codebase as 644 things to do, which is the opposite of what it knows.

Three things make "just mark them done" wrong, all measured rather than assumed:

1. **Status cannot be set during mining.** `computeFrontier`
   (`01-plan-build.ts:116`) excludes `done` nodes from expansion. Nodes created
   done would end the wave machine after level 1 and produce a one-level plan.
2. **Code links are too sparse to be the signal.** "Has code links, therefore
   exists" covers only 248 of 588 leaves, because the builder deliberately links
   only files it actually opened. The other 340 leaves would stay `todo` and
   their parents would never roll up.
3. **Not every node in a from_repo plan exists.** The builder prompt says
   outright that "a component belongs in it even when the code for it does not
   exist yet". A blanket sweep would mislabel precisely the nodes that ARE
   outstanding — the ones most worth seeing.

What makes the fix tractable is `rollUpStatus` (`schemas/plan.ts:293`): with
descendants, the DESCENDANTS decide, so marking leaves `done` greens their
ancestors on its own, and one genuinely-unbuilt leaf renders its whole ancestor
chain `in_progress`. Outstanding work stands out against green instead of
drowning in amber.

**Rollback.** The code half is a default applied at write time; reverting it
changes only what later builds create. The data half is one guarded UPDATE whose
inverse is the same statement with the values swapped — see below.

## A. from_repo creates nodes `done`; the agent opts out per node

`packages/worker/src/step-engine/steps/plan/01-plan-build.ts`

- Where the builder folds each agent's reply (`applyAgentPatch`, the single fold
  point at `:457`), inject `status: 'done'` into every `upsert` op that carries
  NO status — only when `mode === 'from_repo'`. An explicit status from the agent
  therefore wins by construction, with no tracking of "was it explicit" needed.
- The prompt gains one paragraph: this plan is being mined from a codebase that
  already exists, so a component that exists needs no status; put
  `"status": "todo"` on anything named that is NOT built yet.
- `from_md` and the greenfield brief are UNCHANGED. Those describe a project that
  does not exist, where `todo` is already the truth.

## B. The frontier must still expand this build's own nodes

`computeFrontier` gains the current task id and skips its `status !== 'done'`
test for nodes whose `sourceTaskId` matches — `PlanNodeSkeleton` already carries
`sourceTaskId` (`shared/src/plan/read.ts:27`), so this needs no new plumbing.

The done-filter keeps working for everything else, which is the case it exists
for: a build MERGING into an existing plan must not re-expand work already
finished. Only the nodes this run just created are exempt.

## C. Back-fill the plans that already exist

A numbered idempotent migration, `plan_nodes.status`, `todo` → `done`, for nodes
whose `source_task_id` names a `plan_build` task with
`metadata->>'planBuildMode' = 'from_repo'`.

Guarded to `status = 'todo'` so a status a PERSON set is never overwritten, and
scoped through the source task so a hand-built or imported plan is never touched.
Rollback is the same statement with `done` and `todo` swapped, which is why the
guard matters: without it the inverse would flatten legitimately-finished work.

## Files

- `packages/worker/src/step-engine/steps/plan/01-plan-build.ts` (default, prompt,
  frontier call)
- `packages/database/src/migrations/<next>_plan_from_repo_done.sql`
- Tests beside each: the builder's fold and `computeFrontier` are both pure
  enough to unit test with fixtures.

## Verification

1. Unit:
   - The injection applies to a from_repo upsert with no status, does NOT
     override an explicit `todo`, and does NOT fire for `from_md`.
   - `computeFrontier` still returns a `done` node created by THIS task, and
     still skips a `done` node from an earlier one — the merge case, which is the
     regression this could cause.
   - `rollUpStatus` already has tests; add the case that matters here — one
     `todo` leaf among `done` siblings renders the parent `in_progress`, not
     green.
2. Migration: apply it, confirm 644 rows flip, re-run and confirm 0 further
   changes (idempotence), then confirm a node manually set to `blocked_human`
   beforehand is untouched.
3. Live: open the plan and confirm the tree renders green rather than amber, and
   that a node set back to `todo` by hand turns its ancestors amber again.
4. Live, end to end on a THROWAWAY repo: run a small from_repo build and confirm
   the nodes it creates arrive `done` AND that the plan still decomposes past
   level 1 — the frontier regression is the one that would silently halve the
   feature.
5. Per-container tsc, prettier, and vitest in shared, worker and web; plus
   `pnpm --filter @haive/worker smoke:plan-canvas`, which covers the plan
   persistence layer against a real Postgres.
