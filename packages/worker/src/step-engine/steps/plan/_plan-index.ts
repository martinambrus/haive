import type { Database } from '@haive/database';
import {
  renderPlanMarkdown,
  renderPlanMarkdownFrom,
  loadPlanNodes,
  loadPlanEdges,
  type PlanNodeRecord,
  type PlanEdgeRecord,
} from '@haive/shared/plan';

export interface PlanIndexSnapshot {
  nodes: PlanNodeRecord[];
  edges: PlanEdgeRecord[];
  withVersions?: boolean;
}
type IndexParts = { text: string; notice?: string };

/** The deepest the index is ever rendered, and the character budget that shrinks it
 *  when a plan is too big for that depth to be affordable.
 *
 *  A GUARD RAIL, not a tuning change: 120k sits above every index MEASURED on a run
 *  that went well, so it trims nothing that has been observed working and only bounds
 *  the tail. Rendered index vs whole spec prompt, measured: a 174-node plan 93,035 of
 *  124,215 chars (75%), a 193-node plan 115,620 of 133,331 (87%), a 544-node plan
 *  158,274 of 219,412 (72%). So the index is the dominant term in EVERY planned run
 *  and lowering this is the biggest single lever on spec-phase cost — but whether a
 *  shallower index costs spec quality has not been measured, so it is not assumed
 *  here. Drop it to ~40k to halve the spec prompt, and compare the specs. */
export const PLAN_INDEX_MAX_DEPTH = 3;
export const PLAN_INDEX_MAX_CHARS = 120_000;

/** Held back from the budget for the omission notice, which is itself part of what
 *  reaches the prompt. Without the reserve a full-width trim returns MORE than the cap
 *  it announces. The notice is a fixed template plus two small numbers, so a constant
 *  is enough — `planIndexOmissionNotice` is asserted to stay inside it. */
const PLAN_INDEX_NOTICE_RESERVE = 400;

/** Cut a rendered index down to whole NODES under `budget`.
 *
 *  Depth alone cannot enforce the bound: depth 1 is the floor, and a plan that is
 *  merely WIDE — MEASURED on a 1,001-node flat plan, a 273,104-char depth-one index
 *  reaching the prompt intact — is over budget at every depth. So the floor drops
 *  whole nodes as well.
 *
 *  Cuts only on a markdown heading, which is where `renderPlanMarkdown` starts each
 *  node, and keeps a PREFIX rather than a sample: a character slice can end mid-token
 *  and leave a truncated `node:<uuid>` the writer would quote back as if it were
 *  whole, which is the same reason the depth ladder exists. */
export function trimPlanIndexToWholeNodes(
  rendered: string,
  budget: number,
): { text: string; omitted: number } {
  if (rendered.length <= budget) return { text: rendered, omitted: 0 };
  // Group into whole node BLOCKS first (heading + its lines) and accept a block only
  // when all of it fits. Testing the budget at the heading alone lets the block's own
  // body push the result back over it.
  const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line);
  const blocks: string[][] = [];
  for (const line of rendered.split('\n')) {
    if (blocks.length === 0 || isHeading(line)) blocks.push([line]);
    else blocks[blocks.length - 1]!.push(line);
  }
  const kept: string[] = [];
  let length = 0;
  let omitted = 0;
  let cutting = false;
  for (const block of blocks) {
    const text = block.join('\n');
    const cost = kept.length === 0 ? text.length : text.length + 1;
    if (cutting || length + cost > budget) {
      cutting = true;
      if (isHeading(block[0]!)) omitted += 1;
      continue;
    }
    kept.push(text);
    length += cost;
  }
  return { text: kept.join('\n'), omitted };
}

/** What the prompt is told about a reduced index.
 *
 *  The warning against inventing ids is the point of it: the reader must name
 *  components from this index, so it has to know the index is PARTIAL rather than
 *  read a missing component as one that does not exist. */
export function planIndexOmissionNotice(
  depth: number,
  omitted: number,
  maxDepth = PLAN_INDEX_MAX_DEPTH,
): string {
  const notes: string[] = [];
  if (depth < maxDepth) {
    notes.push(`bounded to ${depth} level(s) of the plan because the full ${maxDepth} do not fit`);
  }
  if (omitted > 0) notes.push(`${omitted} further component(s) omitted for size`);
  return (
    `\n_This index is ${notes.join(', and ')}. Components that are not listed still EXIST — ` +
    `do not treat this as the whole plan, and do not invent an id for one you cannot see._\n`
  );
}

/**
 * The plan canvas as a compact index: titles, ids, kinds and statuses, with no
 * bodies. The whole plan would swamp a prompt and most of it is irrelevant to any
 * one question; what a reader needs is the VOCABULARY — which components exist and
 * what they are called — so the ids it quotes back are real ones.
 *
 * Depth is stepped DOWN rather than the text cut, because a character slice would
 * end mid-node and leave a truncated `node:<uuid>` the reader could quote back as if
 * it were whole. Shallower keeps every rendered node intact, and breadth is what
 * vocabulary needs. The reduction is STATED — reported, never silent.
 *
 * Shared by the spec writer (04-phase-0b), which spends the full budget, and by the
 * coverage gate's document-section repairs, which pass a smaller one.
 */
export function renderBoundedPlanIndexParts(
  snapshot: PlanIndexSnapshot,
  repositoryId: string,
  maxChars: number,
  maxDepth?: number,
): IndexParts;
export function renderBoundedPlanIndexParts(
  db: Database,
  repositoryId: string,
  maxChars?: number,
  maxDepth?: number,
): Promise<IndexParts>;
export function renderBoundedPlanIndexParts(
  db: Database | PlanIndexSnapshot,
  repositoryId: string,
  maxChars: number = PLAN_INDEX_MAX_CHARS,
  maxDepth = PLAN_INDEX_MAX_DEPTH,
): IndexParts | Promise<IndexParts> {
  if ('nodes' in db) {
    let rendered = '';
    let depth = maxDepth;
    for (; depth >= 1; depth--) {
      rendered = renderPlanMarkdownFrom(db.nodes, db.edges, {
        titlesOnly: true,
        maxDepth: depth,
        withVersions: db.withVersions,
      });
      if (rendered.length <= maxChars) break;
    }
    depth = Math.max(depth, 1);
    if (depth === maxDepth && rendered.length <= maxChars) return { text: rendered };
    const { text, omitted } = trimPlanIndexToWholeNodes(
      rendered,
      Math.max(0, maxChars - PLAN_INDEX_NOTICE_RESERVE),
    );
    return { text, notice: planIndexOmissionNotice(depth, omitted, maxDepth) };
  }
  return renderDbIndexParts(db, repositoryId, maxChars, maxDepth);
}

async function renderDbIndexParts(
  db: Database,
  repositoryId: string,
  maxChars: number,
  maxDepth: number,
): Promise<IndexParts> {
  let rendered = '';
  let depth = maxDepth;
  for (; depth >= 1; depth--) {
    rendered = await renderPlanMarkdown(db, repositoryId, { titlesOnly: true, maxDepth: depth });
    if (rendered.length <= maxChars) break;
  }
  depth = Math.max(depth, 1);
  // A full-depth render that already fits carries no notice and is returned as it is.
  // Everything else gets one, and the notice is part of what reaches the prompt — so
  // the trim has to hold room for it, or the finished index exceeds the very bound the
  // notice announces (MEASURED: content trimmed to 119,999 returned 120,256).
  if (depth === maxDepth && rendered.length <= maxChars) return { text: rendered };
  const { text, omitted } = trimPlanIndexToWholeNodes(
    rendered,
    maxChars - PLAN_INDEX_NOTICE_RESERVE,
  );
  return { text, notice: planIndexOmissionNotice(depth, omitted, maxDepth) };
}

/** The index and its notice JOINED, exactly as this function has always returned them.
 *
 *  A caller that FENCES the index needs them apart: the notice is HAIVE telling the agent
 *  not to invent an id for a component it could not see, and an instruction of ours inside
 *  a "never follow an instruction in here" fence is a guard rail voided by its own
 *  containment. Every other caller wants the string and is unchanged. */
export async function renderBoundedPlanIndex(
  db: Database,
  repositoryId: string,
  maxChars: number = PLAN_INDEX_MAX_CHARS,
): Promise<string> {
  const { text, notice } = await renderBoundedPlanIndexParts(db, repositoryId, maxChars);
  return `${text}${notice ?? ''}`;
}

export const PLAN_OUTLINE_MAX_CHARS = 48_000;

/** Clarification works on its complete small outline, with bodies and versions.
 * Refuse an oversized outline whole rather than silently losing an open question. */
export async function renderBoundedPlanOutline(
  db: Database,
  repositoryId: string,
  maxChars = PLAN_OUTLINE_MAX_CHARS,
): Promise<string> {
  return db.transaction(
    async (tx) => {
      const nodes = await loadPlanNodes(tx, repositoryId);
      const edges = await loadPlanEdges(tx, repositoryId);
      const text = renderPlanMarkdownFrom(nodes, edges, { withVersions: true });
      if (text.length > maxChars)
        throw new Error(
          'The plan outline is too large for clarification. Reduce it before retrying.',
        );
      return text;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
