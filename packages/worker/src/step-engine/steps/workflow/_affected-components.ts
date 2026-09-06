import {
  IMPACT_DEFAULT_VIEW_DEPTH,
  IMPACT_DIAGRAM_MAX_NODES,
  computeImpact,
  loadPlanEdges,
  loadPlanSkeletons,
  parsePlanNodeRefs,
  renderImpactMermaid,
} from '@haive/shared/plan';
import type { StepContext } from '../../step-definition.js';

/**
 * The plan components a spec named, and what the plan says they reach.
 *
 * Lives here rather than in `04-phase-0b` because two steps must agree on it:
 * 04 stores the answer for the implementer's prompt (`_plan-impact.ts`), and 06
 * renders it to the human at gate 1. `_plan-impact.ts` states the invariant —
 * "agent and human reading different blast radii would be worse than either
 * reading none" — so there is one resolver, not two.
 *
 * Purely additive: a repo with no plan, a spec that named nothing, or a lookup
 * that fails all leave the caller's output untouched.
 */

/** How far the LIST walks. Wider than the diagram: prose can carry a set a
 *  picture cannot, and the prompt block downstream narrows it again to
 *  `IMPACT_DEFAULT_VIEW_DEPTH` for its own reasons. */
const LIST_MAX_DEPTH = 3;

export interface AffectedComponents {
  /** `parentTitle` is the plan parent, so the list can be grouped the way the
   *  tree the reader browses is. Null for the plan root. */
  named: { id: string; title: string; parentTitle: string | null }[];
  /** `reversed` says which way the edge points — without it "depends on" and
   *  "depended on by" collapse into one wrong label. Optional in the TYPE only
   *  because this shape is PERSISTED: a task whose 04 ran before the field
   *  existed replays without it, and `06` re-resolves rather than guessing. */
  reached: { id: string; title: string; depth: number; via: string; reversed?: boolean }[];
  truncated: null | { reason: 'depth' | 'nodes'; limit: number };
  /** One bounded picture per radius the walk actually found something at, so the
   *  gate's reach buttons switch between them without the browser re-deriving a
   *  traversal the server already owns. */
  diagrams?: { depth: number; mermaid: string; omitted: number }[];
  /** Named components the DIAGRAM could not take as origins. Stated rather than
   *  implied — a picture of 40 of 161 read as the whole set is the same failure
   *  a short list is. */
  namedOmitted?: number;
}

/**
 * Resolve the plan nodes a spec named, and what they reach.
 *
 * The parse is by NODE ID — a stable identifier the agent copied from the index
 * it was given — and never by matching its prose. A component index is a list of
 * names, and matching names would silently pick the wrong node the first time
 * two of them read alike.
 */
export async function resolveAffectedComponents(
  ctx: StepContext,
  repositoryId: string | null,
  spec: string,
): Promise<AffectedComponents | undefined> {
  if (!repositoryId) return undefined;
  try {
    const ids = parsePlanNodeRefs(spec);
    if (ids.length === 0) return undefined;
    return await resolveForNodeIds(ctx, repositoryId, ids);
  } catch (err) {
    ctx.logger.warn({ err }, 'affected-components resolution failed (non-fatal)');
    return undefined;
  }
}

/** The same answer for a set of ids already in hand — the repair path for a
 *  persisted payload written before this shape existed. Throws nothing the
 *  caller has to catch beyond what `resolveAffectedComponents` already does. */
export async function resolveAffectedComponentsForIds(
  ctx: StepContext,
  repositoryId: string,
  ids: string[],
): Promise<AffectedComponents | undefined> {
  try {
    if (ids.length === 0) return undefined;
    return await resolveForNodeIds(ctx, repositoryId, ids);
  } catch (err) {
    ctx.logger.warn({ err }, 'affected-components re-resolution failed (non-fatal)');
    return undefined;
  }
}

async function resolveForNodeIds(
  ctx: StepContext,
  repositoryId: string,
  ids: string[],
): Promise<AffectedComponents | undefined> {
  const [skeletons, edges] = await Promise.all([
    loadPlanSkeletons(ctx.db, repositoryId),
    loadPlanEdges(ctx.db, repositoryId),
  ]);
  const byId = new Map(skeletons.map((n) => [n.id, n]));
  const titleById = new Map(skeletons.map((n) => [n.id, n.title]));
  // An id the agent invented, or one from another repo, is DROPPED rather than
  // rendered as an unresolvable uuid.
  const named = ids.flatMap((id) => {
    const n = byId.get(id);
    if (!n) return [];
    return [
      {
        id: n.id,
        title: n.title,
        parentTitle: (n.parentId ? titleById.get(n.parentId) : null) ?? null,
      },
    ];
  });
  if (named.length === 0) return undefined;

  // ONE walk seeded with every named node. It used to be one walk per node,
  // deduped — which produced the same set, but left the diagram below with no
  // multi-origin result to render and so drawing only the first node's radius.
  const list = computeImpact(
    named.map((n) => n.id),
    edges,
    { maxDepth: LIST_MAX_DEPTH },
  );
  const reached = list.hops.map((hop) => ({
    id: hop.nodeId,
    title: titleById.get(hop.nodeId) ?? hop.nodeId,
    depth: hop.depth,
    via: hop.viaKind,
    reversed: hop.reversed,
  }));

  // The PICTURE is one hop, not three. `impact.ts` carries the measurement: on a
  // real plan one hop reaches a median of 3 nodes and two reach 130, because the
  // graph is hub-shaped — a three-hop picture is "essentially the whole plan",
  // which shows nothing. The list above keeps the wider set.
  //
  // `IMPACT_DIAGRAM_MAX_NODES` is the whole picture's budget here, spent on
  // ORIGINS first and on their neighbours with whatever is left. Origins first
  // because the components a spec NAMED are the subject; a neighbour is context.
  //
  // A wide named set therefore draws origins and nothing else, which is a real
  // subgraph rather than a row of loose boxes: MEASURED on a 161-named task,
  // the first 40 named components carry 40 edges between them and only 4 of the
  // 40 are isolated (217 edges among all 161). `opts.edges` below is what draws
  // those, and it is why refusing to draw at all was the wrong call.
  const diagramOrigins = named.slice(0, IMPACT_DIAGRAM_MAX_NODES);
  // Spec order, not "most connected": the diagram has to be explainable — which
  // 40 of 161 got drawn is answered by "the ones the spec cites first", and a
  // connectivity ranking answers it with nothing a reader can check.
  const hopBudget = Math.max(0, IMPACT_DIAGRAM_MAX_NODES - diagramOrigins.length);
  // One picture per radius the LIST found something at, rather than one at the
  // default radius. The gate offers the same reach buttons the plan canvas's
  // Impact tab does, and rendering them here keeps the traversal, its cycle
  // guard and its caps on the server — the browser has no `viaNodeId` to draw an
  // edge from and should not be re-deriving a walk either way.
  //
  // Only depths the walk REACHED get a button: the plan panel's fixed 1-4 can
  // afford to offer a radius that returns nothing because it re-fetches, while
  // a button over a frozen snapshot that changes nothing reads as broken.
  const depths = [...new Set(list.hops.map((h) => h.depth))].sort((a, b) => a - b);
  const originIds = diagramOrigins.map((n) => n.id);
  const diagrams = (depths.length > 0 ? depths : [IMPACT_DEFAULT_VIEW_DEPTH]).map((depth) => {
    // `edges` so the links BETWEEN the named components are drawn: the walk seeds
    // every origin as visited, so it never discovers one.
    const rendered = renderImpactMermaid(
      computeImpact(originIds, edges, { maxDepth: depth }),
      titleById,
      { edges, maxNodes: hopBudget },
    );
    return { depth, mermaid: rendered.source, omitted: rendered.omitted };
  });
  return {
    named,
    reached,
    truncated: list.truncated,
    diagrams,
    namedOmitted: named.length - diagramOrigins.length,
  };
}
