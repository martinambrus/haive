/**
 * A task description written from the plan nodes the task will deliver.
 *
 * IMPORT-SAFE FOR THE BROWSER, and that is a constraint, not a coincidence. This
 * module has no imports at all and is reachable as `@haive/shared/plan-describe`
 * precisely so the create form can call it: the `@haive/shared/plan` barrel
 * re-exports `apply-patch`, which reaches `@haive/database` and therefore
 * `postgres`, and pulling that into a client component fails the web build with
 * a node-builtin resolution error. Keep this file dependency-free.
 *
 * "What should I put in the description?" has no good answer once the work came
 * from a plan: the nodes already say what to build, in what order, and with what
 * constraints, and asking a person to restate that is asking them to paraphrase
 * a document they are looking at. Worse, `tasks.description` is not decoration —
 * `heuristicTriage` measures its length, the triage agent classifies on it,
 * 03-phase-0a discovers against it and it is what the task list shows. An empty
 * one makes every one of those guess.
 *
 * This is NOT the same rendering `renderSeededNodesForSpec` produces for
 * 04-phase-0b, and the two must not be collapsed. That one exists so the spec
 * writer can quote `node:<uuid>` ids back, so it carries ids and no ordering
 * prose. This one is read by a person in a form and by a classifier, so it
 * carries the ordering in words and no ids at all — a uuid is noise to both.
 */

/** The node fields a description is a function of. Structurally satisfied by
 *  `PlanNodeRecord` and by the API's `PlanNode` view, so both the web form and a
 *  server caller can pass what they already hold. */
export interface DescribableNode {
  id: string;
  title: string;
  body: string | null;
  /** Ancestor titles, outermost first. A node called "part_3" means nothing on
   *  its own; the trail is what places it. Optional — a caller that has not
   *  loaded ancestry omits it rather than inventing one. */
  ancestry?: string[];
}

/** `<from>` cannot start until `<to>` is done, both by node id. */
export interface DescribableDependency {
  fromNodeId: string;
  toNodeId: string;
}

/** Per-node body budget. A plan body is prose someone wrote to be read, so this
 *  is generous — the point of the cap is to stop one 40 KB node turning the
 *  description into something nobody scrolls, not to summarise. Elision is
 *  STATED rather than silent, the same rule `changedFilesBlock` follows: a
 *  truncated requirement that looks complete is how an agent builds the wrong
 *  half of something. */
export const PLAN_DESCRIPTION_BODY_BUDGET = 4000;

function clip(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= PLAN_DESCRIPTION_BODY_BUDGET) return trimmed;
  return `${trimmed.slice(0, PLAN_DESCRIPTION_BODY_BUDGET)}\n\n_(truncated here — read the full node in the plan before implementing this part.)_`;
}

/**
 * Order the set among itself, as a sentence rather than a graph.
 *
 * Only dependencies BETWEEN the given nodes. One pointing outside the set is
 * another task's problem — the create gate already refused this task if such a
 * prerequisite was outstanding — and naming it here would read as something this
 * task has to build.
 */
function buildOrderLines(
  nodes: DescribableNode[],
  deps: DescribableDependency[],
): { lines: string[]; waitsFor: Map<string, string[]> } {
  const titleById = new Map(nodes.map((n) => [n.id, n.title]));
  const waitsFor = new Map<string, string[]>();
  const lines: string[] = [];
  for (const d of deps) {
    if (!titleById.has(d.fromNodeId) || !titleById.has(d.toNodeId)) continue;
    const run = waitsFor.get(d.fromNodeId);
    if (run) run.push(titleById.get(d.toNodeId)!);
    else waitsFor.set(d.fromNodeId, [titleById.get(d.toNodeId)!]);
  }
  for (const [nodeId, before] of waitsFor) {
    lines.push(
      `- ${before.map((b) => `"${b}"`).join(' and ')} must land before "${titleById.get(nodeId)!}".`,
    );
  }
  return { lines, waitsFor };
}

/**
 * The description for a task covering `nodes`.
 *
 * Returns '' for an empty set, so a caller can use the result directly as "did
 * this produce anything" without a second test.
 */
export function describePlanNodesForTask(
  nodes: DescribableNode[],
  deps: DescribableDependency[] = [],
): string {
  if (nodes.length === 0) return '';
  const { lines: orderLines, waitsFor } = buildOrderLines(nodes, deps);

  const out: string[] = [];
  out.push(
    nodes.length === 1
      ? 'Implement this part of the project plan.'
      : `Implement these ${nodes.length} parts of the project plan together.`,
  );

  if (orderLines.length > 0) {
    out.push(
      '',
      '## Build order',
      '',
      // Stated as a requirement, not as trivia: this is the reason the parts are
      // one task rather than several, and the DAG planner is told the same thing
      // from the plan itself.
      'The plan records this order and it has to hold:',
      ...orderLines,
      '',
      'Everything not named above can be built in parallel.',
    );
  }

  for (const node of nodes) {
    out.push('', `## ${node.title}`);
    const trail = node.ancestry?.filter(Boolean) ?? [];
    if (trail.length > 0) out.push(`_In: ${trail.join(' › ')}_`);
    const before = waitsFor.get(node.id);
    if (before && before.length > 0) {
      out.push(
        `_Cannot start until ${before.map((b) => `"${b}"`).join(' and ')} ${before.length === 1 ? 'is' : 'are'} done._`,
      );
    }
    const body = node.body?.trim();
    out.push('', body ? clip(body) : '_This node has no description in the plan yet._');
  }

  return out.join('\n');
}
