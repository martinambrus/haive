import {
  orderSiblingsByDependency,
  type PlanSequenceEdge,
  type PlanSequenceNode,
} from './sequence.js';

/**
 * How much of a plan still needs a reader to decide its build order.
 *
 * Split out of the worker's sequencing step so the API can answer the same
 * question: the plan page shows the number on its Order button, and the worker
 * cannot be imported from there. Everything here is pure — no database, no task —
 * which is why it can live in shared at all.
 *
 * The unit throughout is a sibling RUN (one parent's children), not a node. That
 * is what an agent is asked about, what the per-pass budget counts, and therefore
 * what a person deciding whether to run another pass needs to see.
 */

/** Modest waves with a per-pass ceiling that is a runaway guard rather than a
 *  number the user has to click through. Shared because the API quotes it when it
 *  says how many passes are left. */
export const SEQUENCE_AGENTS_PER_PASS = 400;

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SEQUENCE_AGENT_RE = new RegExp(`^plan-seq-(${UUID_SOURCE})-p(\\d+)$`, 'i');

/** One agent per parent, mirroring `plan-expand-<nodeId>-p<N>`. The id IS the
 *  record of what has been asked, which is why it is built and parsed in one
 *  place. */
export function sequenceAgentId(parentId: string, wave: number): string {
  return `plan-seq-${parentId}-p${wave}`;
}

/** The parent a sequencing agent was asked about, or null for any other id. */
export function sequenceAgentParent(agentId: string): string | null {
  return SEQUENCE_AGENT_RE.exec(agentId)?.[1] ?? null;
}

/** The wave number in a sequencing agent id, or 0 for any other id. */
export function sequenceAgentWave(agentId: string): number {
  const m = SEQUENCE_AGENT_RE.exec(agentId);
  return m ? Number(m[2]) : 0;
}

/** One row of the repo-wide asked-set: which parent, from which pass, how it ended. */
export type AskedRow = { agentId: string; status: string; taskStepId: string };

/**
 * Every parent any pass ON THIS REPOSITORY has already ordered.
 *
 * The BUDGET is per pass; the FRONTIER is not. A pass stops at
 * `SEQUENCE_AGENTS_PER_PASS` with groups still pending, and the asked-set used to
 * live only on the current step's mining rows — so the next task rebuilt its
 * targets in plan order and started again from the top. MEASURED on a 7,983-node
 * plan: of the 400 groups a second pass would ask, 390 had already been ordered by
 * the first, and the 476 at the tail were unreachable however often the button was
 * pressed. The frontier cannot shrink its own way out of that either — a run leaves
 * the target list only once its edges pin a TOTAL order, which an agent's links
 * rarely do (19 of 889 across two full passes).
 *
 * A row from ANOTHER pass counts only once it has ANSWERED: an agent that failed
 * there left its group unordered, and never asking it again would strand exactly
 * the groups that most need a second try. Rows of the CURRENT step count whatever
 * their status, because a pending or running one is a group already out with an
 * agent and must not be dispatched twice by the next wave of the same pass.
 *
 * `currentStepId` is deliberately required rather than optional: a caller with no
 * step of its own (the API, counting what is left) passes a value that matches
 * nothing, and gets the strict "only answered rows count" reading — which is the
 * correct one for a question asked from outside any pass.
 */
export function askedParents(rows: AskedRow[], currentStepId: string): Set<string> {
  const asked = new Set<string>();
  for (const row of rows) {
    if (row.taskStepId !== currentStepId && row.status !== 'done') continue;
    const parent = sequenceAgentParent(row.agentId);
    if (parent) asked.add(parent.toLowerCase());
  }
  return asked;
}

export interface SequenceProgress {
  /** Sibling runs still needing a reader — the unit of work and of the budget. */
  groupsRemaining: number;
  /** Nodes inside those runs. Reported because "87 groups" answers how many passes
   *  are left while "412 nodes" answers how much plan is still unordered, and a
   *  person asking about their plan means the second. */
  nodesRemaining: number;
  /** Passes needed to cover them at the current budget. */
  passesRemaining: number;
  /** The budget, so a caller can say what one pass covers without hardcoding it. */
  perPass: number;
}

/**
 * What another ordering pass would still have to do.
 *
 * Deliberately NOT reusing the worker's `computeTargets`: that answers a richer
 * question (each target's title and child count, plus how many runs the edges
 * already settle) and is what builds the fan-out. This is the tally. The part that
 * must never diverge between them — whether a run's edges pin exactly one order —
 * is `orderSiblingsByDependency`, and both call it.
 */
export function computeSequenceProgress(
  nodes: PlanSequenceNode[],
  edges: PlanSequenceEdge[],
  asked: Set<string>,
): SequenceProgress {
  const byParent = new Map<string, PlanSequenceNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const run = byParent.get(node.parentId);
    if (run) run.push(node);
    else byParent.set(node.parentId, [node]);
  }

  let groupsRemaining = 0;
  let nodesRemaining = 0;
  for (const [parentId, run] of byParent) {
    // A run of one has no order to decide.
    if (run.length < 2) continue;
    if (asked.has(parentId.toLowerCase())) continue;
    if (orderSiblingsByDependency(run, edges).decided) continue;
    groupsRemaining++;
    nodesRemaining += run.length;
  }

  return {
    groupsRemaining,
    nodesRemaining,
    passesRemaining: Math.ceil(groupsRemaining / SEQUENCE_AGENTS_PER_PASS),
    perPass: SEQUENCE_AGENTS_PER_PASS,
  };
}
