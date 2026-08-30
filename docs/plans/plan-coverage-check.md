# Coverage check: what the document says that the plan does not

## Context

A `from_md` plan is built from an authoritative document, and nothing verifies
that the result covers it. The build stops when its frontier empties, which says
nothing about the source. Both coverage audits in this repo were done BY HAND,
and the first found a real hole — a top-level component with no children where
the document gave it 180 lines.

The prompt for this was three "missing identifiers" in the latest audit. Those
turned out NOT to be gaps: one was a regex artifact, and the other two are REST
paths covered by a node describing that exact surface. The metric was measuring
transcription, not coverage. The capability is still worth having for the case
where something IS missing — but that history is the reason this step REPORTS
rather than fixes.

Decided with the user: run after every document-driven build, finish unattended
when clean, park only when there is something to show, and offer to re-run
decomposition for the gaps the user ticks.

**Rollback.** A new step, additive. Removing its registration returns
`plan_build` to a single step; nothing else reads what it writes.

## Design

A second registered step, `02-plan-coverage`, `workflowType: 'plan_build'`,
`index: 1`. `stepRegistry.listByWorkflow` builds the run list, so registering it
appends it automatically.

**Detection is deterministic, and the HUMAN adjudicates.** No LLM decides whether
a section is covered. That is the point of report-only, and it also means the
engine's natural order — detect, then form, then apply — is enough; no LLM runs
before the gate, so none of the two-pass machinery `01-plan-chat` needed applies
here. The model is spent only on gaps a person confirmed.

- **detect**: read the document from `task_attachments.stored_path` (the worker
  can read that path directly — verified), extract its headings, and score each
  against the plan's titles AND bodies. Bodies matter: scoring titles alone
  produced two false positives in an earlier audit, and title+body scoring
  produced none. Sections that are pure reference (a glossary, a bibliography)
  are candidates like any other — the human dismisses them in one click, which is
  cheaper than encoding a taxonomy of what counts as work.
- **form**: `null` when there are no candidates, so a clean build finishes
  unattended exactly as today. Otherwise a gate in the shape gate 1.5 already
  uses (`08d2-adversarial-qa-review.ts:280-315`): a `radio` for the decision, a
  `select` for scope, a `multi-select` of the candidate sections, and a
  `textarea` for extra instruction — all field types the renderer already has.
  Each candidate carries its evidence (how many plan nodes matched, which terms
  are absent) so a false positive is obvious rather than a puzzle.
- **apply**: for the ticked sections, dispatch one decomposition agent each by
  throwing `MiningWaveError` — the same fan-out `01-plan-build` uses for its
  waves. Each agent gets that section's text, the plan rendered titles-only, and
  the standard patch contract, and adds what is missing under the parent it
  judges right. Accepting instead records the decision and finishes.

Patches go through `applyAgentPatch`, so they inherit what was just built: the
last-block parser, `onUnresolvableRef: 'drop'`, and `selfNodeId`.

## What this step must NOT do

- **Never edit the plan on its own.** An agent asked "what is missing?" against a
  200 KB document and 800 nodes will always find something, so an autonomous
  fixer has no fixed point and would grow the plan on every run. The human tick
  is the fixed point.
- **Never re-park after a fix round.** One pass, then done. A re-check loop is
  the same non-termination by a slower route.

## Files

- `packages/worker/src/step-engine/steps/plan/02-plan-coverage.ts` (new)
- `packages/worker/src/step-engine/steps/plan/index.ts` (register it)
- A shared scorer beside it, pure and unit-testable, taking headings + node
  text and returning candidates with evidence.
- Tests beside both.

## Verification

1. Unit on the scorer: a section whose terms appear in node BODIES is not a
   candidate; one absent from both is; evidence counts are right; and the two
   historical false positives ("3. Architecture and repository contract", covered
   by its children; the endpoint paths covered by an API-surface node) do NOT
   come back as gaps. Those are the regression cases that justify the scoring
   rule.
2. Unit on the step: `form()` returns null with no candidates (the auto-pass), a
   gate with them; and "accept" records without dispatching.
3. Live against the KNOWN answer, on the finished build
   `4f8a80d6-17ad-428a-942e-6af92343b7e5`: its document is still attached and its
   plan measured 0 headings absent from titles+bodies, so the step must find
   nothing and auto-pass. A step that flags gaps on that plan is mis-scoring.
   Reopening a completed task to run it is a testing shortcut, not the production
   path — say so.
4. Then a NEGATIVE control: delete one component's subtree on a throwaway copy
   and confirm the step now flags exactly the sections that subtree covered.
   Without this, a step that always reports "nothing missing" passes step 3.
5. Per-container tsc, prettier, vitest in worker; `smoke:plan-canvas`.
6. NOT verified live: a full build ending in a real fix round, which spends CLI
   budget. Say so rather than implying it.
