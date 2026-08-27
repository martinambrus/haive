import type { PlanEdgeKind } from '../schemas/plan.js';
import type { PlanEdgeRecord } from './read.js';

/**
 * "If I change this, what else must change?"
 *
 * The edge graph HAS cycles by construction — two components that each affect
 * the other is a normal thing for a plan to say — so this is an explicit
 * breadth-first walk with a visited set, not a recursive CTE. A `WITH RECURSIVE`
 * without `UNION` dedup would not terminate on such a graph, and one WITH dedup
 * still cannot report where it stopped.
 *
 * Both caps are REPORTED rather than applied silently. An impact view that
 * quietly truncates is worse than one that refuses: the user reads a short list
 * as "nothing else is affected".
 */

export interface ImpactOptions {
  /** How many hops out from the origin. */
  maxDepth?: number;
  /** How many nodes may be returned (excluding the origin). */
  maxNodes?: number;
  /** Which edge kinds propagate impact. Defaults to all of them: a `depends_on`
   *  and an `implements` both mean "a change here reaches there", just from
   *  different directions of authorship. */
  kinds?: PlanEdgeKind[];
  /** Follow edges pointing AT the origin as well as away from it. On by default:
   *  "A affects B" means changing B is also of interest to whoever owns A, and a
   *  user asking for impact wants the blast radius, not one arrow's direction. */
  bidirectional?: boolean;
}

export interface ImpactHop {
  nodeId: string;
  /** Hops from the origin (the origin itself is 0). */
  depth: number;
  /** The edge that first reached this node, for rendering the path. */
  viaNodeId: string;
  viaKind: PlanEdgeKind;
  /** True when the edge was followed against its direction. */
  reversed: boolean;
}

export interface ImpactResult {
  originNodeId: string;
  hops: ImpactHop[];
  /** Set when a cap stopped the walk. Rendered to the user verbatim — the point
   *  is that a truncated answer says so. */
  truncated: null | { reason: 'depth' | 'nodes'; limit: number };
}

export const IMPACT_DEFAULT_MAX_DEPTH = 4;
export const IMPACT_DEFAULT_MAX_NODES = 200;

/** The radius a VIEW opens at, which is not the same question as the walk's
 *  safety cap above.
 *
 *  MEASURED on a 226-node, 530-edge plan: one hop reaches a median of 3 nodes
 *  (p90 7), two hops reach a median of 130. The jump is hub structure — almost
 *  any node's neighbour is connected to almost everything — so a transitive
 *  answer is "essentially the whole plan", which answers nothing. One hop is
 *  what "if I change this, what else must change?" actually means; further is
 *  available, but asked for.
 *
 *  Deliberately NOT applied by lowering `IMPACT_DEFAULT_MAX_DEPTH`, which would
 *  silently narrow every caller of `computeImpact` rather than one view. */
export const IMPACT_DEFAULT_VIEW_DEPTH = 1;

/** How many nodes a DIAGRAM may draw. Past this the picture stops being one:
 *  192 nodes rendered as a 45,871 x 950 px SVG in a 702px panel, which fits at
 *  zoom 0.0153 and draws a 16px label at a quarter of a pixel. The hops are in
 *  BFS order, so the cap keeps the NEAREST nodes — the ones the question is
 *  about — and the caller is told how many it left for the list. */
export const IMPACT_DIAGRAM_MAX_NODES = 40;

/** Longest label a diagram box may carry. A mermaid box is as wide as its
 *  label, and plan titles run past 70 characters; the full title is one click
 *  away in the node itself and is listed verbatim beside the diagram. */
const DIAGRAM_LABEL_CHARS = 40;

export function computeImpact(
  originNodeId: string,
  edges: PlanEdgeRecord[],
  opts: ImpactOptions = {},
): ImpactResult {
  const maxDepth = opts.maxDepth ?? IMPACT_DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? IMPACT_DEFAULT_MAX_NODES;
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const bidirectional = opts.bidirectional ?? true;

  const forward = new Map<string, PlanEdgeRecord[]>();
  const backward = new Map<string, PlanEdgeRecord[]>();
  const push = (m: Map<string, PlanEdgeRecord[]>, key: string, e: PlanEdgeRecord): void => {
    const run = m.get(key);
    if (run) run.push(e);
    else m.set(key, [e]);
  };
  for (const e of edges) {
    if (kinds && !kinds.has(e.kind)) continue;
    push(forward, e.fromNodeId, e);
    push(backward, e.toNodeId, e);
  }

  const hops: ImpactHop[] = [];
  // The origin is seeded as visited, which is also what makes a cycle back to it
  // terminate rather than re-enter.
  const visited = new Set<string>([originNodeId]);
  let frontier: string[] = [originNodeId];
  let truncated: ImpactResult['truncated'] = null;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      const outgoing = forward.get(current) ?? [];
      const incoming = bidirectional ? (backward.get(current) ?? []) : [];

      for (const e of outgoing) {
        if (pushHop(e.toNodeId, current, e.kind, false, depth)) next.push(e.toNodeId);
        if (truncated) return { originNodeId, hops, truncated };
      }
      for (const e of incoming) {
        if (pushHop(e.fromNodeId, current, e.kind, true, depth)) next.push(e.fromNodeId);
        if (truncated) return { originNodeId, hops, truncated };
      }
    }
    if (next.length === 0) return { originNodeId, hops, truncated: null };
    frontier = next;
  }

  // The depth budget is spent. Whether the answer is INCOMPLETE is a different
  // question from whether the last level found anything: report truncation only
  // if some node on the frontier still has an unvisited neighbour. Claiming
  // truncation because the last level was non-empty would mark almost every
  // result incomplete, which trains the reader to ignore the warning.
  const moreToSee = frontier.some((id) =>
    [...(forward.get(id) ?? []), ...(bidirectional ? (backward.get(id) ?? []) : [])].some((e) => {
      const other = e.fromNodeId === id ? e.toNodeId : e.fromNodeId;
      return !visited.has(other);
    }),
  );
  return {
    originNodeId,
    hops,
    truncated: moreToSee ? { reason: 'depth', limit: maxDepth } : null,
  };

  function pushHop(
    nodeId: string,
    viaNodeId: string,
    viaKind: PlanEdgeKind,
    reversed: boolean,
    depth: number,
  ): boolean {
    if (visited.has(nodeId)) return false;
    if (hops.length >= maxNodes) {
      truncated = { reason: 'nodes', limit: maxNodes };
      return false;
    }
    visited.add(nodeId);
    hops.push({ nodeId, depth, viaNodeId, viaKind, reversed });
    return true;
  }
}

/** A bounded diagram plus what it had to leave out. An object rather than a
 *  bare string so a caller cannot draw the wall by ignoring the cap — the two
 *  facts travel together or the omission goes unsaid. */
export interface ImpactDiagram {
  /** mermaid source. */
  source: string;
  /** Nodes in the result that the diagram does NOT show, origin excluded. */
  omitted: number;
}

/**
 * A mermaid `flowchart` of an impact result.
 *
 * `LR`, not `TD`: a flowchart lays each BFS level out along the cross-axis, so
 * top-down turns one level into a ROW — measured at 45,871 px wide for a level
 * holding 122 nodes. Left-to-right makes DEPTH the x-axis, which the depth cap
 * already bounds to a handful of columns, and stacks siblings vertically, which
 * a narrow panel can scroll.
 *
 * Rendered with `securityLevel: 'strict'` by the existing mermaid block, so
 * labels are the one injection surface — a plan node title is LLM- or
 * user-authored text. Titles are quoted and the quote character stripped, which
 * is what keeps a title containing `"` or a mermaid keyword from ending the
 * label early and turning the rest into syntax. The display truncation below is
 * ON TOP of that guard, never instead of it.
 */
export function renderImpactMermaid(
  result: ImpactResult,
  titleById: Map<string, string>,
  opts: { maxNodes?: number } = {},
): ImpactDiagram {
  const maxNodes = opts.maxNodes ?? IMPACT_DIAGRAM_MAX_NODES;
  const label = (id: string): string => {
    const safe = (titleById.get(id) ?? id).replace(/["\n\r]/g, ' ').slice(0, 80);
    return safe.length > DIAGRAM_LABEL_CHARS
      ? `${safe.slice(0, DIAGRAM_LABEL_CHARS - 1).trimEnd()}…`
      : safe;
  };
  // `pnode` + the hyphen-stripped uuid. The prefix is deliberately distinctive
  // because the browser has to recover the uuid from the RENDERED DOM id, and
  // mermaid decorates what it is given: the element ends up as
  // `<renderId>-flowchart-<thisId>-<index>`. Keying the client on `pnode<32 hex>`
  // means it keys on OUR token — the part we control — instead of on mermaid's
  // surrounding decoration, which is an internal convention that can be reworded
  // in any release.
  const nodeId = (id: string): string => `pnode${id.replace(/-/g, '')}`;

  // Nearest-first, because `hops` is in BFS order. A hop is drawable only if the
  // node it was reached FROM is drawn too, which nearest-first guarantees: the
  // via-node is always at a shallower depth and so at a lower index.
  const drawn = result.hops.slice(0, Math.max(0, maxNodes));

  const lines = ['flowchart LR'];
  lines.push(`  ${nodeId(result.originNodeId)}["${label(result.originNodeId)}"]:::origin`);
  for (const hop of drawn) {
    lines.push(`  ${nodeId(hop.nodeId)}["${label(hop.nodeId)}"]`);
  }
  for (const hop of drawn) {
    const arrow = hop.reversed ? '-.->' : '-->';
    const [a, b] = hop.reversed
      ? [nodeId(hop.nodeId), nodeId(hop.viaNodeId)]
      : [nodeId(hop.viaNodeId), nodeId(hop.nodeId)];
    lines.push(`  ${a} ${arrow}|${hop.viaKind.replace(/_/g, ' ')}| ${b}`);
  }
  lines.push('  classDef origin stroke-width:3px;');
  return { source: lines.join('\n'), omitted: result.hops.length - drawn.length };
}
