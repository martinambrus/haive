# Impact view: a readable radius, and a diagram that fits

## Context

The Impact tab answers "if I change this, what else must change?" by walking the
plan's edge graph. On a real plan it answers "essentially everything", and draws
that answer as a wall.

MEASURED on the dev install (226 nodes, 530 edges):

| depth | median hops | p90 | nodes over 40 hops |
| ----- | ----------- | --- | ------------------ |
| **1** | **3**       | 7   | 2 of 226           |
| 2     | 130         | 142 | 142                |
| 3     | 189         | 197 | 205                |
| 4     | 200         | 200 | 216                |

The jump from 3 to 130 between depth 1 and 2 is the whole diagnosis: this graph
has hubs, so almost any node's neighbour is connected to almost everything. At
the shipped default (depth 4, bidirectional) 171 of 226 nodes hit the 200-node
cap and 44 more hit the depth cap with 100-199 hops each.

The user's node — `rs_dynamic_modules dialog` — renders 192 nodes as an SVG of
**45,871 x 950 px** inside a 702px panel. Fit-to-width is zoom **0.0153**, so a
16px label draws at **0.24px**, and the zoom control tops out at 3 (still 4.6%).
`flowchart TD` puts each BFS level in a ROW, and depth 4 holds 122 nodes.

They also read a depth-limit warning as a bug. It is not: it is correct, and it
fires while showing 192 of 226 nodes, which is why it reads wrong. The copy
states only what is missing and never what is shown.

Mermaid is NOT the problem and is not being replaced — at depth 1 (median 3
nodes) it renders perfectly, keeps click-through, and is already shared with the
spec gate. A bespoke mind-map widget would be exactly as unreadable at 192 nodes.
The radius is the problem.

Decided with the user: past a readable size, CAP THE DIAGRAM and keep the full
set in the list; apply the same treatment to the spec gate's diagram.

## A. Shared — a bounded, readable renderer

`packages/shared/src/plan/impact.ts`

1. `flowchart TD` becomes `flowchart LR`. Depth becomes the x-axis, so width is
   bounded by the depth cap (at most 4-5 columns) and siblings stack vertically —
   the orientation a narrow side panel can actually scroll.
2. Labels truncate to ~40 chars with an ellipsis. A mermaid box is as wide as its
   label and titles run to 78 chars; the full title stays in the list below and
   in the node it navigates to. The existing `slice(0, 80)` + quote/newline strip
   STAYS as the injection guard — the display cut sits on top of it, it does not
   replace it.
3. New `IMPACT_DIAGRAM_MAX_NODES = 40` and an options arg. `result.hops` is
   already in BFS order, so the cap takes the NEAREST nodes — the ones the
   question is actually about.
4. `renderImpactMermaid` returns `{ source, omitted }` instead of a bare string.
   An object rather than a second helper, so neither caller can silently draw the
   wall by using the old form. Both call sites are ours.
5. New `IMPACT_DEFAULT_VIEW_DEPTH = 1`, exported beside the existing caps.
   `IMPACT_DEFAULT_MAX_DEPTH = 4` STAYS as it is: the walk's own safety cap and a
   view's default radius are different questions, and conflating them would
   silently narrow every future caller of `computeImpact`.

## B. API — default the panel's radius to 1

`packages/api/src/routes/plan.ts` (`GET /:id/plan/impact/:nodeId`)

- Absent `maxDepth` now means `IMPACT_DEFAULT_VIEW_DEPTH`, not the walk's cap.
  The query param already exists and already wins.
- Response gains `mermaidOmitted: number` beside the existing `mermaid: string`.
  Additive rather than a shape change, matching the constraint in section D.

## C. Web — a depth control, grouped hops, honest copy

`packages/web/src/components/plan/plan-detail-panel.tsx`

1. `impactDepth` state (default `IMPACT_DEFAULT_VIEW_DEPTH`) with a small
   `1 · 2 · 3 · 4` segmented control in the Impact tab. The load effect currently
   short-circuits on `if (tab !== 'impact' || impact) return` — it must also
   invalidate on depth change, or the control does nothing.
   `getPlanImpact(repositoryId, nodeId, maxDepth)` already takes the argument
   (`api-client.ts:1420`); the panel just never passed it.
2. The flat 192-row `impact.hops.map` list becomes grouped by depth —
   `1 hop (2)`, `2 hops (128)` — with groups past the first collapsed by default,
   the same convention the Links tab already uses. Grouping goes in a new pure
   `plan-impact-groups.ts` mirroring `plan-edge-groups.ts`, because that is the
   only shape the web test setup can reach (no JSX transform, no RTL).
3. Copy states what IS shown before what is not:
   - truncation: `Showing 192 of 226 nodes within 4 hops — the walk stopped at
     the depth limit, so more lie beyond.`
   - diagram cap: `Diagram shows the 40 nearest; 152 more are in the list below.`
   Both are the same anti-failure rule the current banner encodes — a short list
   read as "nothing else is affected" — just stated from the other end.
4. `PlanGraph` and its zoom bounds are UNTOUCHED. The 0.0153 fit was a symptom of
   the radius; with the cap the fit lands near 1 on its own.

## D. Worker — the spec gate inherits the same diagram

`04-phase-0b-pre-planning.ts` keeps `maxDepth: 3` for the WALK (the prose list
wants the wider set) and takes the capped diagram plus its `omitted` count.
`06-gate-1-spec-approval.ts` states the omission next to the existing truncation
line; its prose already lists every reached component, so the picture is the only
thing being bounded.

`AffectedComponents` is declared in BOTH step files and is persisted in
`task_steps.output`. So it gains an OPTIONAL `mermaidOmitted?: number` and
`mermaid` stays a string — turning it into an object would render `[object
Object]` in an already-parked gate whose output was written under the old shape.

Observed, deliberately NOT touched: 04 draws only `named[0]`'s walk while
`reached` is the union over every named node, so the picture and the list already
disagree when a spec names more than one component. Out of scope; worth its own
change.

## Files

- `packages/shared/src/plan/impact.ts`, `impact.test.ts`
- `packages/api/src/routes/plan.ts`
- `packages/web/src/lib/api-client.ts` (`PlanImpact.mermaidOmitted`)
- `packages/web/src/components/plan/plan-detail-panel.tsx`
- `packages/web/src/components/plan/plan-impact-groups.ts` + `.test.ts` (new)
- `packages/worker/src/step-engine/steps/workflow/04-phase-0b-pre-planning.ts`,
  `06-gate-1-spec-approval.ts`

## Verification

1. Unit: `impact.test.ts` gains LR orientation, label truncation, the node cap
   and its `omitted` count, and that the cap changes the DIAGRAM only — never
   `result.hops`. New `plan-impact-groups.test.ts` covers grouping, counts and
   ordering. Then per-container `tsc --noEmit`, prettier, and vitest in shared,
   api, web and worker.
2. Live, on the node that prompted this
   (`3faf51a6-a1d4-48c9-8993-b9f1c1a13b58`, repo `e417d390-…`): the Impact tab
   opens at depth 1 with 2 hops and a diagram whose measured intrinsic width is
   within a few hundred px of the panel — re-measure `getBBox()` and the fit
   zoom, do not eyeball it. Stepping the control to 4 must show the 40-node
   diagram, the omission line, and grouped counts summing to 192.
3. A node with NO links still says "Nothing else is linked to this node yet"
   (9 such nodes exist in this plan), and a depth change on it must not error.
4. Gate 1: no live run needed — assert the rendered section from a fixture in the
   worker test, including that an output written WITHOUT `mermaidOmitted` still
   renders (the persisted-shape case).
5. Browser session note: the MCP browser's cookie had expired during
   investigation; a JWT minted inside the api container and set as `haive_access`
   restores it. Delete any probe script copied into a container afterwards.
