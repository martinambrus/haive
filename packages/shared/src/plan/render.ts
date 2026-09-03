import type { Database } from '@haive/database';
import type { PlanEdgeKind } from '../schemas/plan.js';
import { loadPlanEdges, loadPlanNodes, indexChildren, type PlanNodeRecord } from './read.js';
import { planNodeDepth } from './paths.js';
import { computePlanSequence } from './sequence.js';

/**
 * The plan as ONE markdown document.
 *
 * This is deliberately a single function with a single format, because it is
 * both the prompt input for every plan LLM turn AND the `.haive-data/plan.md`
 * mirror committed into the repo. Two renderers would let what the agent reads
 * and what a human reads drift apart, and the whole point of handing the agent
 * the entire plan is that a conversation rooted at one node can correctly patch
 * another.
 *
 * Node ids are rendered VISIBLY (`node:<uuid>`) rather than as HTML comments.
 * The agent has to quote them back in its patches and the technical-spec writer
 * has to name them in its "Affected components" section, so they must survive a
 * model that ignores comments, and a human reading the committed file should be
 * able to see what an id refers to.
 */

/** Marker prefix for a plan node id in generated prose. Parsed back by the spec
 *  writer's apply so the affected-components set is resolved from a STABLE
 *  identifier rather than by matching the agent's wording. */
export const PLAN_NODE_REF_PREFIX = 'node:';

const PLAN_NODE_REF_RE = /node:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Every plan node id mentioned in `text`, deduped, in first-appearance order. */
export function parsePlanNodeRefs(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(PLAN_NODE_REF_RE)) {
    seen.add(m[1]!.toLowerCase());
  }
  return [...seen];
}

const EDGE_LABEL: Record<PlanEdgeKind, string> = {
  depends_on: 'depends on',
  affects: 'affects',
  implements: 'implements',
};

export interface RenderPlanOptions {
  /** Stop at this depth (root = 0). Used for the compact component index handed
   *  to the technical-spec writer, where the full plan would swamp the prompt. */
  maxDepth?: number;
  /** Omit node bodies, leaving titles + ids + status. The same compact-index case. */
  titlesOnly?: boolean;
  /** Mark one node as the conversation's focus, so a plan_chat prompt can say
   *  "you are here" without a second copy of the tree. */
  focusNodeId?: string;
  /** Omit the typed cross-links entirely.
   *
   *  For the sequencing step, whose agents are asked to decide a build order
   *  that is then COMPARED against the `depends_on` edges already recorded. An
   *  agent shown those edges is not a second opinion, it is an echo — and the
   *  whole point of the comparison is to catch an edge pointing the wrong way,
   *  which is exactly the claim the agent would be reading. */
  omitLinks?: boolean;
}

export function renderPlanMarkdownFrom(
  nodes: PlanNodeRecord[],
  edges: { fromNodeId: string; toNodeId: string; kind: PlanEdgeKind; note: string | null }[],
  opts: RenderPlanOptions = {},
): string {
  if (nodes.length === 0) return '_This repository has no plan yet._\n';

  const byParent = indexChildren(nodes);
  const titleById = new Map(nodes.map((n) => [n.id, n.title]));
  const outgoing = new Map<string, typeof edges>();
  for (const e of edges) {
    const run = outgoing.get(e.fromNodeId);
    if (run) run.push(e);
    else outgoing.set(e.fromNodeId, [e]);
  }

  // The build-order number and the unmet prerequisites come from the same
  // derivation the API serves, so the document an agent reads, the one committed
  // to `.haive-data/plan.md` and the canvas all say the same thing.
  const derived = computePlanSequence(nodes, edges);

  const lines: string[] = [];

  const emit = (node: PlanNodeRecord): void => {
    const depth = planNodeDepth(node.path);
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) return;

    // Markdown has six heading levels and a plan can be deeper. Past h6 the
    // heading stops carrying the depth, so the breadcrumb line does instead —
    // clamping silently would make level 7 and level 9 look identical.
    const hashes = '#'.repeat(Math.min(depth + 1, 6));
    const focus = opts.focusNodeId === node.id ? '  <- you are here' : '';
    // The number leads the heading because it is what the reader is scanning
    // for. It is a position in the CURRENT plan, not an id — the `node:` ref
    // below is the thing to quote back.
    const seq = derived.sequenceById.get(node.id);
    lines.push(`${hashes} ${seq === undefined ? '' : `${seq}. `}${node.title}${focus}`);

    const blockers = derived.blockedById.get(node.id) ?? [];
    const attrs = [
      `${PLAN_NODE_REF_PREFIX}${node.id}`,
      node.kind,
      node.status,
      ...(node.taskable ? ['taskable'] : []),
      ...(blockers.length > 0
        ? [`blocked by ${blockers.map((b) => `#${b.sequence}`).join(', ')}`]
        : []),
      ...(depth >= 6 ? [`depth ${depth}`] : []),
    ];
    lines.push(`\`${attrs.join('\` · \`')}\``);

    const links = opts.omitLinks ? [] : (outgoing.get(node.id) ?? []);
    for (const link of links) {
      const target = titleById.get(link.toNodeId);
      if (!target) continue;
      const note = link.note ? ` — ${link.note}` : '';
      lines.push(
        `- ${EDGE_LABEL[link.kind]}: ${target} (\`${PLAN_NODE_REF_PREFIX}${link.toNodeId}\`)${note}`,
      );
    }

    if (!opts.titlesOnly && node.body?.trim()) {
      lines.push('');
      lines.push(node.body.trim());
    }
    lines.push('');

    for (const child of byParent.get(node.id) ?? []) emit(child);
  };

  for (const root of byParent.get(null) ?? []) emit(root);
  return lines.join('\n');
}

/** Render straight from the database. */
export async function renderPlanMarkdown(
  db: Database,
  repositoryId: string,
  opts: RenderPlanOptions = {},
): Promise<string> {
  const [nodes, edges] = await Promise.all([
    loadPlanNodes(db, repositoryId),
    loadPlanEdges(db, repositoryId),
  ]);
  return renderPlanMarkdownFrom(nodes, edges, opts);
}
