# A plan build must not lose a subtree in silence

## Context

An audit of the `vareska` plan against the 1,919-line document it was built from
found the decomposition sound — 111 of 113 headings covered, 143 of 167
backticked identifiers present, 19 of 20 sections substantially represented —
except that one top-level component, "Campaign packaging, cryptography,
installation and offline delivery", has ZERO children where the document gives it
180 lines across six subsections.

The build did not fail. 70 agents, all `done`. What happened, traced end to end:

1. The expansion agent for that node returned 58 KB and correctly parented 12
   children to it.
2. Its draft contained a hallucinated uuid — `…afeb-7691f7b3b0a1` where the real
   accounts node is `…afeb-7961d67c1a5b`.
3. **The agent noticed**, appended prose — "my draft above contains placeholder
   link churn that should not be applied. Use this reply instead:" — and emitted
   a corrected second JSON block.
4. `parsePlanPatch` reads the FIRST block. Verified by running the real parser
   over the stored output: 33 ops, 12 upserts, the retracted draft.
5. A patch is one transaction. Of the 5 uuids its link ops name, only 3 exist, so
   the applier rolled the whole thing back — all 12 upserts with it.
6. The agent row stayed `done`; that wave's `failures[]` was overwritten by the
   final pass's empty one; and the node counted as asked forever after, because
   the asked-set is derived from agent ids alone.

Three defects, each of which alone would have been survivable.

**Rollback.** All three changes are behavioural, in one step module and one
parser. No schema change, no data migration; reverting the commit restores the
previous behaviour exactly.

## A. Parse the agent's final answer, not its first draft

`packages/worker/src/step-engine/steps/plan/_plan-prompt.ts`

`parsePlanPatch` calls `parseJsonLoose`, which anchors on the first fence and
never looks further. The codebase already has the fix and does not use it here:
`parseJsonLooseValidated` (`steps/_fenced-json.ts`) scans every balanced object
and takes the LAST one the caller accepts, and its docstring names this exact
mode — "the agent prompts all say 'when finished emit ONE JSON object': the
answer is what it finishes with, and anything JSON-shaped before it is working
material."

Switch to it via `parseAgentJson` (`steps/workflow/_agent-json.ts`), the existing
wrapper that also handles the already-parsed-object case. The `accept` guard is
the shape test `parsePlanPatch` already applies: an object carrying an `ops`
array, or one that spoke through `summary`/`reply`.

This helps the plan CHAT too, where an agent's final word is equally the answer.

## B. An apply failure must outlive its wave

`packages/worker/src/step-engine/steps/plan/01-plan-build.ts`

When `applyAgentPatch` throws in the fold, the message goes into a local
`failures[]` that the next wave's apply rebuilds and the final pass's output
overwrites. That is why a build which lost 12 nodes reported clean, and why
`task_steps.output.failures` was `[]` when I looked.

Stamp the message on that agent's `task_step_agent_minings.error_message`. The
row is per-agent, already exists, and survives — unlike step output, which a
manual retry nulls. The aggregate stays in the step output as it is; the row
becomes the durable record and the input to section C.

## C. A node whose expansion was lost is not "asked"

`askedState` marks a node asked from its agent id alone
(`plan-expand-<uuid>-p<N>`). It should require that the expansion actually
LANDED: skip agents whose row carries an apply error, so the node returns to the
frontier and a later wave re-asks it as `-p<N+1>`.

Two invariants this must not break:

- **"This cannot be broken down further" must still stick.** That agent applied
  cleanly with zero ops, so it carries no error and stays asked — the case the
  existing comment protects.
- **It cannot loop.** `MAX_WAVES = 8` already bounds the wave count, so a node
  that keeps failing is retried a few times and then left alone with its error
  recorded, rather than spinning.

## Files

- `packages/worker/src/step-engine/steps/plan/_plan-prompt.ts` (parser)
- `packages/worker/src/step-engine/steps/plan/01-plan-build.ts` (failure
  recording, asked-set)
- Tests beside both; `parsePlanPatch` and `askedState` are pure.

## Verification

1. Unit, `parsePlanPatch`:
   - A two-block reply — bad draft, "use this reply instead", corrected block —
     yields the SECOND. A minimal fixture reproducing the incident's shape rather
     than the 58 KB original.
   - A single-block reply is unchanged, and a reply whose only block is malformed
     still reaches the existing salvage chain (jsonrepair, truncated tails).
     Those paths are load-bearing and easy to lose in a rewrite.
2. Unit, `askedState`: an agent with an apply error does NOT mark its node asked;
   one without does; and a clean zero-op reply still does.
3. Replay the REAL stored reply (the 58 KB row is still in
   `task_step_agent_minings`) through the new parser and assert it now yields the
   corrected block — the one naming the real accounts uuid. This is the only
   check that proves the fix against the actual input that defeated it.
4. `pnpm --filter @haive/worker smoke:plan-canvas`, then per-container tsc,
   prettier and vitest in worker and shared.
5. NOT verified live: a full from_repo build, which spends real CLI budget across
   several waves. Say so rather than implying end-to-end proof.

## Follow-up, deliberately not in scope

The `vareska` plan still has that node empty. Once this ships, the cheapest
repair is a plan chat on it asking for the decomposition — a new build would
re-ask it, but rebuilding a 567-node plan to recover 12 nodes is the wrong trade.
