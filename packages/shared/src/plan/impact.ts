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

/**
 * A mermaid `flowchart` of an impact result.
 *
 * Rendered with `securityLevel: 'strict'` by the existing mermaid block, so
 * labels are the one injection surface — a plan node title is LLM- or
 * user-authored text. Titles are quoted and the quote character stripped, which
 * is what keeps a title containing `"` or a mermaid keyword from ending the
 * label early and turning the rest into syntax.
 */
export function renderImpactMermaid(result: ImpactResult, titleById: Map<string, string>): string {
  const label = (id: string): string => {
    const raw = titleById.get(id) ?? id;
    return raw.replace(/["\n\r]/g, ' ').slice(0, 80);
  };
  const nodeId = (id: string): string => `n${id.replace(/-/g, '')}`;

  const lines = ['flowchart TD'];
  lines.push(`  ${nodeId(result.originNodeId)}["${label(result.originNodeId)}"]:::origin`);
  for (const hop of result.hops) {
    lines.push(`  ${nodeId(hop.nodeId)}["${label(hop.nodeId)}"]`);
  }
  for (const hop of result.hops) {
    const arrow = hop.reversed ? '-.->' : '-->';
    const [a, b] = hop.reversed
      ? [nodeId(hop.nodeId), nodeId(hop.viaNodeId)]
      : [nodeId(hop.viaNodeId), nodeId(hop.nodeId)];
    lines.push(`  ${a} ${arrow}|${hop.viaKind.replace(/_/g, ' ')}| ${b}`);
  }
  lines.push('  classDef origin stroke-width:3px;');
  return lines.join('\n');
}
