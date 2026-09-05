import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { PLAN_PATCH_MAX_OPS, type FormSchema, type FormValues } from '@haive/shared';
import {
  PLAN_NODE_REF_PREFIX,
  applyPlanPatch,
  computePlanSequence,
  loadPlanEdges,
  loadPlanSkeletons,
  orderSiblingsByDependency,
  renderPlanMarkdown,
} from '@haive/shared/plan';
import type { PlanEdgeRecord, PlanNodeSkeleton } from '@haive/shared/plan';
import type { AgentMiningResult, StepContext, StepDefinition } from '../../step-definition.js';
import { MiningWaveError, ReopenStepFormError } from '../../step-definition.js';
import { shouldRetryMiningTerminalFailure } from '../../mining-failure.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { APPLY_FAILURE_PREFIX, PLAN_AGENT_TIMEOUT_MS } from './01-plan-build.js';
import { PLAN_PATCH_CONTRACT, applyAgentPatch, parsePlanPatch } from './_plan-prompt.js';

/**
 * Put the plan in BUILD ORDER.
 *
 * The plan is numbered post-order from `plan_nodes.ordinal` — every descendant
 * before its container — so a reader follows the numbers to decide what to do
 * next. That numbering is only as good as `ordinal`, and until this step existed
 * `ordinal` was the order an expansion agent happened to emit its children in.
 * The number was therefore real and meaningless at the same time.
 *
 * Two passes, cheapest first, because they answer different questions:
 *
 *  1. DETERMINISTIC. `orderSiblingsByDependency` sorts each sibling run by the
 *     `depends_on` edges its own members already declare. No agent, no tokens,
 *     and MEASURED on the dev install it settles 87 of 334 sibling runs outright.
 *     Where the edges pin exactly one order there is nothing left to ask.
 *  2. AGENTS, one per sibling run the edges left a choice in. Ordering is
 *     sibling-local — a run is its own little problem — so this fans out wide and
 *     each agent's reply is small.
 *
 * The fan-out rides `MiningWaveError`, not `loop`: the runner's loop re-entry
 * calls `resolveLlmPhase`, which asserts `stepDef.llm` exists, and this step
 * defines none. Same reason 01-plan-build gives.
 *
 * One agent per parent, `plan-seq-<parentId>-p<wave>`, mirroring
 * `plan-expand-<nodeId>-p<N>`. Batching several parents into one agent would be
 * ~8x cheaper, but the batch membership would then have to survive across apply
 * passes that are independent calls; the one-parent-per-id scheme gets the
 * asked-set out of the ids themselves and needs no bookkeeping at all.
 */

/** A sibling run that needs a reader to decide its order. */
interface SequenceTarget {
  parentId: string;
  parentTitle: string;
  childCount: number;
}

/**
 * A recorded `depends_on` that an agent, ordering the same siblings without
 * being shown it, put the wrong way round.
 *
 * NOT a defect: unlike a cycle or an ancestor dependency this is perfectly
 * satisfiable, and nothing structural says it is wrong. It is two independent
 * judgements disagreeing — the edge says A waits for B, the agent said do A
 * first — and only a person can say which is right.
 */
export interface SequenceDisagreement {
  edgeId: string;
  fromNodeId: string;
  fromTitle: string;
  toNodeId: string;
  toTitle: string;
  /** The reason recorded on the edge when it was written. */
  note: string | null;
}

export interface PlanSequenceDetect {
  repositoryId: string | null;
  nodeCount: number;
  /** Runs the edges already settle — reported so the form can say what the free
   *  pass covered rather than leaving it invisible. */
  decidedRuns: number;
  targets: SequenceTarget[];
  /** Sibling runs whose own edges contradict each other, plus the plan-wide
   *  dependency knots. An agent is asked to repair these, and a person is shown
   *  them either way: neither can ever be satisfied. */
  contradictoryRuns: number;
  cycles: number;
  ancestorDeps: number;
  agentsUsed: number;
  wave: number;
  disagreements: SequenceDisagreement[];
}

export interface PlanSequenceApply {
  reordered: number;
  dispatched: number;
  remaining: number;
  decision: 'sequenced' | 'deterministic_only' | 'skipped' | 'nothing_to_do';
  /** Edges an independent ordering contradicted, and how many of them the
   *  developer chose to remove. Reported even when none were removed: the
   *  disagreement is the finding, the removal is the optional response. */
  disagreements: number;
  edgesRemoved: number;
}

/** Matches 02-plan-coverage's cadence: modest waves, with a per-pass ceiling
 *  that is a runaway guard rather than a number the user has to click through. */
const SEQUENCE_AGENTS_PER_WAVE = 12;
export const SEQUENCE_AGENTS_PER_PASS = 400;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SEQUENCE_AGENT_RE = new RegExp(`^plan-seq-(${UUID_SOURCE})-p(\\d+)$`, 'i');
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, 'i');

/** The node id behind a ref, as `applyPlanPatch` resolves it.
 *
 *  `renderPlanMarkdown` prints every id as `node:<uuid>` and the patch contract
 *  tells the agent to COPY ids rather than retype them, so an agent obeying both
 *  replies with the prefix — MEASURED on one 400-agent pass, 250 of 400 replies
 *  carried it. The applier strips it (`normalizeOpRefs`), so those agents' ORDER
 *  was written correctly; only this lookup kept the ref verbatim, and
 *  `collectDisagreements` asks it for a bare node id, so a majority of the
 *  orderings could contradict nothing and the second opinion silently covered
 *  the minority that happened to retype the uuid.
 *
 *  Stripped only when the remainder is uuid-shaped, exactly as the applier does,
 *  so a temp id an agent happens to call `node:api` still names a new node. */
function bareNodeRef(ref: string): string {
  const lower = ref.toLowerCase();
  if (!lower.startsWith(PLAN_NODE_REF_PREFIX)) return lower;
  const bare = lower.slice(PLAN_NODE_REF_PREFIX.length);
  return UUID_RE.test(bare) ? bare : lower;
}

/** The one step, under the id each workflow registers it as. Declared here rather
 *  than inline in `metadata` because the repo-wide asked-set below has to name
 *  BOTH — a literal there would silently read nothing for whichever id it is not,
 *  which is the same trap `loadSequenceRows` avoids by keying on the step row. */
const SEQUENCE_STEP_ID = {
  plan_build: '03-plan-sequence',
  plan_sequence: '00-plan-sequence',
} as const;
const SEQUENCE_STEP_IDS = Object.values(SEQUENCE_STEP_ID);

export function sequenceAgentId(parentId: string, wave: number): string {
  return `plan-seq-${parentId}-p${wave}`;
}

/** The parent a reply is about, so `applyAgentPatch` can offer it as `self` and
 *  the agent never transcribes a uuid. */
function sequenceSelfNodeId(agentId: string): string | null {
  return SEQUENCE_AGENT_RE.exec(agentId)?.[1] ?? null;
}

export type MiningRow = {
  agentId: string;
  status: string;
  output: unknown;
  rawOutput: string | null;
};

async function loadSequenceRows(ctx: StepContext): Promise<MiningRow[]> {
  // Keyed on this step's own row rather than joined through `task_steps` on a
  // step id: the step is registered under two ids (one per workflow type) and a
  // literal here would silently read nothing for whichever one it is not.
  return ctx.db
    .select({
      agentId: schema.taskStepAgentMinings.agentId,
      status: schema.taskStepAgentMinings.status,
      output: schema.taskStepAgentMinings.output,
      rawOutput: schema.taskStepAgentMinings.rawOutput,
    })
    .from(schema.taskStepAgentMinings)
    .where(eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId));
}

/** Which parents have already been asked, and how far the pass has got. The
 *  agent ids ARE the record — apply passes are independent calls and the step
 *  row is rewritten each wave, so anything held only in memory is gone. */
function askedState(rows: MiningRow[]): { asked: Set<string>; agents: number; wave: number } {
  const asked = new Set<string>();
  let wave = 0;
  for (const row of rows) {
    const m = SEQUENCE_AGENT_RE.exec(row.agentId);
    if (!m) continue;
    asked.add(m[1]!.toLowerCase());
    wave = Math.max(wave, Number(m[2]));
  }
  return { asked, agents: asked.size, wave };
}

/** One row of the repo-wide asked-set: which parent, from which pass, how it ended. */
export type AskedRow = { agentId: string; status: string; taskStepId: string };

/**
 * Every parent any pass ON THIS REPOSITORY has already ordered.
 *
 * The BUDGET is per pass; the FRONTIER is not. A pass stops at
 * `SEQUENCE_AGENTS_PER_PASS` with groups still pending, and the asked-set used to
 * live only on the current step's mining rows — so the next task rebuilt `targets`
 * in plan order and started again from the top. MEASURED on a 7,983-node plan: of
 * the 400 groups a second pass would ask, 390 had already been ordered by the
 * first, and the 476 at the tail were unreachable however often the button was
 * pressed. The frontier cannot shrink its own way out of that either — a run
 * leaves `targets` only once its edges pin a TOTAL order, which an agent's links
 * rarely do (13 of 889 over a full pass).
 *
 * A row from ANOTHER pass counts only once it has ANSWERED: an agent that failed
 * there left its group unordered, and never asking again would strand exactly the
 * groups that most need a second try. Rows of the CURRENT step count whatever
 * their status, because a pending or running one is a group already out with an
 * agent and must not be dispatched twice by the next wave of the same pass.
 */
export function askedParents(rows: AskedRow[], currentStepId: string): Set<string> {
  const asked = new Set<string>();
  for (const row of rows) {
    if (row.taskStepId !== currentStepId && row.status !== 'done') continue;
    const m = SEQUENCE_AGENT_RE.exec(row.agentId);
    if (m) asked.add(m[1]!.toLowerCase());
  }
  return asked;
}

async function loadAskedParents(ctx: StepContext, repositoryId: string): Promise<Set<string>> {
  const rows = await ctx.db
    .select({
      agentId: schema.taskStepAgentMinings.agentId,
      status: schema.taskStepAgentMinings.status,
      taskStepId: schema.taskStepAgentMinings.taskStepId,
    })
    .from(schema.taskStepAgentMinings)
    .innerJoin(schema.taskSteps, eq(schema.taskSteps.id, schema.taskStepAgentMinings.taskStepId))
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        inArray(schema.taskSteps.stepId, SEQUENCE_STEP_IDS),
      ),
    );
  return askedParents(rows, ctx.taskStepId);
}

/** Group children by parent, preserving the loader's `ordinal` order. */
function childrenByParent(nodes: PlanNodeSkeleton[]): Map<string, PlanNodeSkeleton[]> {
  const out = new Map<string, PlanNodeSkeleton[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const run = out.get(node.parentId);
    if (run) run.push(node);
    else out.set(node.parentId, [node]);
  }
  return out;
}

/**
 * Pass 1: write the order the existing edges already imply.
 *
 * Goes through `applyPlanPatch` like every other plan write, and only for runs
 * that actually move — a settled plan produces zero ops and therefore no mirror
 * revision, which is what makes re-running this step a no-op rather than a
 * commit.
 *
 * No `expectedVersion`: this records a fact derived from edges that are already
 * in the database, and a conflict would drop the whole run's ordering to protect
 * a field nobody was editing. Same reasoning as `completePlanNodesForTask`.
 */
async function applyDeterministicOrder(
  ctx: StepContext,
  repositoryId: string,
  nodes: PlanNodeSkeleton[],
  edges: PlanEdgeRecord[],
): Promise<number> {
  const ops: { op: 'upsert'; nodeRef: string; ordinal: number }[] = [];
  for (const run of childrenByParent(nodes).values()) {
    const { ordered } = orderSiblingsByDependency(run, edges);
    ordered.forEach((child, index) => {
      if (child.ordinal !== index) ops.push({ op: 'upsert', nodeRef: child.id, ordinal: index });
    });
  }
  if (ops.length === 0) return 0;
  // Chunked: this pass covers the WHOLE plan at once and a patch is capped at
  // PLAN_PATCH_MAX_OPS. On the dev install's 4106-node plan a first run moves
  // far more rows than that, so an unchunked patch would be rejected outright by
  // the schema — not partially applied, rejected — and the free pass would
  // silently never work on exactly the large plans it exists for.
  //
  // Several transactions rather than one is safe HERE specifically: each op is
  // an idempotent assignment derived from edges that are not changing, so a run
  // interrupted between chunks leaves a partly reordered tree that the next run
  // finishes. It is a projection being brought up to date, not a unit of intent.
  for (let i = 0; i < ops.length; i += PLAN_PATCH_MAX_OPS) {
    await applyPlanPatch(
      ctx.db,
      {
        ops: ops.slice(i, i + PLAN_PATCH_MAX_OPS),
        summary: 'build order from declared dependencies',
      },
      { repositoryId, origin: 'llm', sourceTaskId: ctx.taskId },
    );
  }
  return ops.length;
}

/** The runs an agent still has to decide, in plan order so the fan-out works
 *  down the tree rather than jumping about. */
function computeTargets(
  nodes: PlanNodeSkeleton[],
  edges: PlanEdgeRecord[],
): { targets: SequenceTarget[]; decidedRuns: number; contradictoryRuns: number } {
  const titleById = new Map(nodes.map((n) => [n.id, n.title]));
  const targets: SequenceTarget[] = [];
  let decidedRuns = 0;
  let contradictoryRuns = 0;
  for (const [parentId, run] of childrenByParent(nodes)) {
    if (run.length < 2) continue;
    const { decided, contradictory } = orderSiblingsByDependency(run, edges);
    if (contradictory) contradictoryRuns++;
    if (decided) {
      decidedRuns++;
      continue;
    }
    targets.push({
      parentId,
      parentTitle: titleById.get(parentId) ?? 'unknown',
      childCount: run.length,
    });
  }
  return { targets, decidedRuns, contradictoryRuns };
}

async function detectSequence(ctx: StepContext): Promise<PlanSequenceDetect> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { repositoryId: true },
  });
  const repositoryId = task?.repositoryId ?? null;
  if (!repositoryId) {
    return {
      repositoryId: null,
      nodeCount: 0,
      decidedRuns: 0,
      targets: [],
      contradictoryRuns: 0,
      cycles: 0,
      ancestorDeps: 0,
      agentsUsed: 0,
      wave: 0,
      disagreements: [],
    };
  }

  const [nodes, edges, rows, askedRepo] = await Promise.all([
    loadPlanSkeletons(ctx.db, repositoryId),
    loadPlanEdges(ctx.db, repositoryId),
    loadSequenceRows(ctx),
    loadAskedParents(ctx, repositoryId),
  ]);
  const derived = computePlanSequence(nodes, edges);
  const { targets, decidedRuns, contradictoryRuns } = computeTargets(nodes, edges);
  const state = askedState(rows);
  return {
    repositoryId,
    nodeCount: nodes.length,
    decidedRuns,
    targets: targets.filter((t) => !askedRepo.has(t.parentId.toLowerCase())),
    contradictoryRuns,
    cycles: derived.cycles.length,
    ancestorDeps: derived.ancestorDeps.length,
    agentsUsed: state.agents,
    wave: state.wave,
    disagreements: collectDisagreements(nodes, edges, agentOrdinals(rows)),
  };
}

function dispatchCount(targetCount: number, agentsUsed: number): number {
  return Math.max(
    0,
    Math.min(SEQUENCE_AGENTS_PER_WAVE, targetCount, SEQUENCE_AGENTS_PER_PASS - agentsUsed),
  );
}

/** Is the pass over — will no further agent go out?
 *
 *  Two readers have to answer this the same way: apply(), deciding whether to
 *  reopen the form for the end-of-pass review, and form(), deciding whether to
 *  build that form. When they disagree the step asks the runner for a form the
 *  form then refuses to produce, and the runner fails the step with "requested
 *  another form, but refreshed detection produced no form". MEASURED: that
 *  killed a plan_build on a 7,983-node plan whose 889 sibling runs spent the
 *  400-agent budget with groups still pending, so the old form-side test
 *  (`targets.length === 0`) was never going to become true.
 *
 *  The budget being spent ends the pass exactly as running out of groups does —
 *  what is left over is reported as `remaining` and picked up by re-running the
 *  step. */
export function sequencePassComplete(pendingTargets: number, agentsUsed: number): boolean {
  return pendingTargets === 0 || agentsUsed >= SEQUENCE_AGENTS_PER_PASS;
}

function buildSequencePrompt(
  target: SequenceTarget,
  children: PlanNodeSkeleton[],
  planMarkdown: string,
): string {
  return [
    'You are deciding the ORDER in which one part of a project plan gets built.',
    '',
    'Here is the plan as it stands, for context on what exists elsewhere. Every node carries',
    'its current build-order number, so you can see where your part sits in the whole.',
    '',
    planMarkdown,
    '',
    '## Your node',
    `${target.parentTitle} (\`node:${target.parentId}\`)`,
    '',
    'Its children, in their CURRENT order — which is the order an agent happened to write them',
    'in, not a considered one:',
    '',
    ...children.map((c, i) => `${i}. ${c.title} (\`node:${c.id}\`)`),
    '',
    'Decide the order a developer would actually build these in: foundations, data shapes and',
    'contracts before the things that use them; a thing before the thing that tests or presents',
    'it. Send ONE `upsert` per child carrying only its new `ordinal`, numbered from 0 with no',
    'gaps and no repeats. Change nothing else about them — not the title, not the body, not the',
    'status.',
    '',
    'Where one of these children genuinely CANNOT BE STARTED until another has landed, also add',
    'a `depends_on` link from the one that waits to the one it waits for. That is a stronger',
    'claim than the order: a node whose prerequisite is unfinished is BLOCKED, and the product',
    'refuses to open a task for it. Use it where the work truly cannot begin, not merely where',
    'two things are related — an ordering you are only fairly confident about belongs in the',
    '`ordinal` alone.',
    '',
    'Never point a `depends_on` at the parent above or at any ancestor, and never close a loop',
    'between two nodes. Neither can ever be satisfied, so both strand every node on them',
    'permanently. If you can see an existing link like that among these children, remove it with',
    'an `unlink` op.',
    '',
    PLAN_PATCH_CONTRACT,
  ].join('\n');
}

async function buildWave(
  ctx: StepContext,
  detected: PlanSequenceDetect,
  nodes: PlanNodeSkeleton[],
  wave: number,
) {
  const slice = detected.targets.slice(
    0,
    dispatchCount(detected.targets.length, detected.agentsUsed),
  );
  if (slice.length === 0) return [];
  // Rendered ONCE per wave rather than per agent: it is the same document for
  // every one of them and a plan is thousands of nodes.
  const planMarkdown = await renderPlanMarkdown(ctx.db, detected.repositoryId!, {
    titlesOnly: true,
    maxDepth: 3,
    // The order this agent returns is COMPARED against the recorded
    // `depends_on` edges. Showing it those edges would make it an echo of the
    // claim under test rather than a second reader of the work.
    omitLinks: true,
  });
  const byParent = childrenByParent(nodes);
  return slice.map((target) => ({
    agentId: sequenceAgentId(target.parentId, wave),
    agentTitle: `Order: ${target.parentTitle}`,
    roleKey: 'expand',
    prompt: buildSequencePrompt(target, byParent.get(target.parentId) ?? [], planMarkdown),
  }));
}

async function stampMiningError(ctx: StepContext, agentId: string, message: string): Promise<void> {
  await ctx.db
    .update(schema.taskStepAgentMinings)
    .set({ errorMessage: message.slice(0, 2000) })
    .where(
      and(
        eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId),
        eq(schema.taskStepAgentMinings.agentId, agentId),
      ),
    )
    .catch(() => undefined);
}

/** Keep only the ops this step asked for.
 *
 *  An agent handed the whole patch contract can emit anything in it, and a
 *  reordering pass that quietly rewrote a body or flipped a status would be a
 *  content edit nobody asked for and nobody would see — this step's own summary
 *  says "reordered", and a person reads that and does not go looking. So the
 *  filter is on the OPS, not on the prompt: `upsert` keeps `ordinal` and drops
 *  every other field, and only link ops that are `depends_on` survive. */
function keepOrderingOps(ops: unknown[]): { ops: unknown[]; discarded: number } {
  const kept: unknown[] = [];
  let discarded = 0;
  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    if (op?.op === 'upsert') {
      if (typeof op.ordinal !== 'number') {
        discarded++;
        continue;
      }
      kept.push({ op: 'upsert', nodeRef: op.nodeRef, ordinal: op.ordinal });
      if (Object.keys(op).length > 3) discarded++;
      continue;
    }
    if ((op?.op === 'link' || op?.op === 'unlink') && op.kind === 'depends_on') {
      kept.push(op);
      continue;
    }
    discarded++;
  }
  return { ops: kept, discarded };
}

async function foldSequenceResults(
  ctx: StepContext,
  repositoryId: string,
  results: AgentMiningResult[],
): Promise<number> {
  let applied = 0;
  for (const result of results) {
    if (result.status !== 'done') continue;
    const patch = parsePlanPatch(result.output ?? result.rawOutput);
    if (!patch) {
      await stampMiningError(ctx, result.agentId, `${APPLY_FAILURE_PREFIX} no patch in reply`);
      continue;
    }
    const { ops, discarded } = keepOrderingOps(patch.ops);
    if (discarded > 0) {
      await stampMiningError(
        ctx,
        result.agentId,
        `${APPLY_FAILURE_PREFIX} ${discarded} op(s) outside this step's remit were dropped`,
      );
    }
    if (ops.length === 0) continue;
    const self = sequenceSelfNodeId(result.agentId);
    try {
      const outcome = await applyAgentPatch(
        ctx.db,
        { ...patch, ops },
        {
          repositoryId,
          sourceTaskId: ctx.taskId,
          retryable: false,
          ...(self ? { selfNodeId: self } : {}),
        },
      );
      applied += outcome.updated.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn({ err, agentId: result.agentId }, 'plan sequencing patch failed');
      await stampMiningError(ctx, result.agentId, `${APPLY_FAILURE_PREFIX} ${message}`);
    }
  }
  return applied;
}

/**
 * Every build order an agent of THIS step actually stated, node id -> ordinal.
 *
 * Read back from the mining rows rather than carried in memory, for the same
 * reason the asked-set is: apply passes are independent calls and the step row
 * is rewritten each wave. Agents cover disjoint sibling runs, so the assignments
 * never collide.
 */
export function agentOrdinals(rows: MiningRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== 'done') continue;
    const patch = parsePlanPatch(row.output ?? row.rawOutput);
    if (!patch) continue;
    for (const raw of keepOrderingOps(patch.ops).ops) {
      const op = raw as { op?: string; nodeRef?: unknown; ordinal?: unknown };
      if (op.op !== 'upsert') continue;
      if (typeof op.nodeRef !== 'string' || typeof op.ordinal !== 'number') continue;
      out.set(bareNodeRef(op.nodeRef), op.ordinal);
    }
  }
  return out;
}

/**
 * The independent second opinion.
 *
 * Each agent was asked to order one sibling run WITHOUT being shown the
 * `depends_on` edges among those siblings (`omitLinks` on the plan render). So
 * where its stated order puts a node BEFORE something that node is recorded as
 * waiting for, two independent judgements have contradicted each other about
 * the same pair.
 *
 * This is the only check available for a dependency written the wrong way round
 * between two ordinary nodes. It closes no loop and touches no ancestor, so
 * nothing structural can refuse it at the write — MEASURED, a lexical check on
 * the edge's own note is worse than useless: on a real plan, narrowing to
 * containment verbs still left roughly two correct edges for every wrong one,
 * because "A is invoked by B" and "A is driven by B" are the same sentence and
 * only one of them is an inversion.
 *
 * Reported, never applied. The agent is not more authoritative than the edge —
 * it is a second reader, and the value is that it read independently.
 */
export function collectDisagreements(
  nodes: PlanNodeSkeleton[],
  edges: PlanEdgeRecord[],
  ordinals: Map<string, number>,
): SequenceDisagreement[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: SequenceDisagreement[] = [];
  for (const edge of edges) {
    if (edge.kind !== 'depends_on') continue;
    const from = byId.get(edge.fromNodeId);
    const to = byId.get(edge.toNodeId);
    // Only within one sibling run: that is the only scope an agent was asked
    // about, so it is the only scope its silence or its order means anything in.
    if (!from || !to || from.parentId === null || from.parentId !== to.parentId) continue;
    const fromOrdinal = ordinals.get(edge.fromNodeId.toLowerCase());
    const toOrdinal = ordinals.get(edge.toNodeId.toLowerCase());
    if (fromOrdinal === undefined || toOrdinal === undefined) continue;
    // `from` waits for `to`, so `to` must be built first. The agent said otherwise.
    if (fromOrdinal >= toOrdinal) continue;
    out.push({
      edgeId: edge.id,
      fromNodeId: from.id,
      fromTitle: from.title,
      toNodeId: to.id,
      toTitle: to.title,
      note: edge.note,
    });
  }
  return out;
}

/** The end-of-pass review: edges an independent ordering contradicted.
 *
 *  Nothing is preselected. Neither reader outranks the other — the edge is an
 *  explicit claim someone wrote down, the ordering is a fresh judgement made
 *  without seeing it — so the default is to keep what is recorded and let a
 *  person who knows the system decide. */
function disagreementForm(detected: PlanSequenceDetect): FormSchema {
  return {
    title: 'Dependencies a second opinion disagreed with',
    description:
      `${detected.disagreements.length} recorded dependency(ies) point the opposite way to the ` +
      'build order a model chose for the same group — and it chose that order WITHOUT being ' +
      'shown them, so this is two independent readings contradicting each other rather than a ' +
      'model marking its own work. Neither is automatically right. Nothing is selected: tick ' +
      'only the ones you can see are backwards, and the rest stay exactly as they are.',
    fields: [
      {
        id: 'removeEdges',
        type: 'multi-select',
        label: 'Dependencies to remove',
        defaults: [],
        options: detected.disagreements.map((d) => ({
          value: d.edgeId,
          label: `"${d.fromTitle}" waits for "${d.toTitle}" — the ordering put it first instead`,
          ...(d.note ? { description: `Recorded reason: ${d.note}` } : {}),
        })),
      },
    ],
  };
}

export function sequenceForm(detected: PlanSequenceDetect): FormSchema | null {
  if (!detected.repositoryId || detected.nodeCount === 0) return null;
  // Only the FIRST pass asks about the budget. Once a wave has gone out the user
  // has already agreed to it, and re-parking every twelve agents would turn an
  // unattended pass into a clicking exercise.
  if (detected.agentsUsed > 0) {
    // ...but the END of the pass asks once more, because by then there is
    // something to show that did not exist when the budget was agreed.
    return sequencePassComplete(detected.targets.length, detected.agentsUsed) &&
      detected.disagreements.length > 0
      ? disagreementForm(detected)
      : null;
  }
  if (detected.targets.length === 0) return null;

  const defects = detected.cycles + detected.ancestorDeps;
  return {
    title: 'Put the plan in build order',
    description:
      `${detected.nodeCount} nodes. ${detected.decidedRuns} group(s) are already ordered by ` +
      `dependencies they declare, and ${detected.targets.length} still need a reader to decide. ` +
      `That is up to ${detected.targets.length} agent runs at ${SEQUENCE_AGENTS_PER_WAVE} at a ` +
      'time — the largest thing this step spends, so it is asked for rather than assumed.' +
      (defects > 0
        ? ` This plan also has ${defects} dependency(ies) that can never be satisfied ` +
          `(${detected.cycles} loop(s), ${detected.ancestorDeps} pointing at an own ancestor); ` +
          'those need an edge removed by hand and are not fixed here.'
        : ''),
    fields: [
      {
        id: 'decision',
        type: 'select',
        label: 'How far to go',
        required: true,
        default: 'sequence',
        options: [
          {
            value: 'sequence',
            label: `Order the whole plan (up to ${detected.targets.length} agents)`,
            description: 'Ask a model to order every group the declared dependencies leave open.',
          },
          {
            value: 'deterministic_only',
            label: 'Dependencies only (free)',
            description:
              'Apply just the order the existing depends_on edges already imply. No agents, no ' +
              'spend. Groups with no declared dependencies keep the order they have.',
          },
          {
            value: 'skip',
            label: 'Leave the order alone',
            description: 'Change nothing. The numbering keeps whatever order is stored now.',
          },
        ],
      },
    ],
  };
}

export function createPlanSequenceStep(opts: {
  workflowType: 'plan_build' | 'plan_sequence';
  index: number;
  title: string;
}): StepDefinition<PlanSequenceDetect, PlanSequenceApply> {
  return {
    metadata: {
      id: SEQUENCE_STEP_ID[opts.workflowType],
      workflowType: opts.workflowType,
      index: opts.index,
      title: opts.title,
      description:
        'Orders every group of sibling nodes so the plan can be followed by number — the ' +
        'declared dependencies first, then a model for the groups they leave open.',
      requiresCli: true,
    },

    detect: detectSequence,

    form(_ctx, detected): FormSchema | null {
      return sequenceForm(detected);
    },

    agentMining: {
      requiredCapabilities: ['tool_use'],
      toolProfile: 'rag_only',
      timeoutMs: PLAN_AGENT_TIMEOUT_MS,
      retry: { maxAttempts: 2, retryOnInvocationFailure: shouldRetryMiningTerminalFailure },
      async selectAgents({ ctx, detected, formValues }) {
        if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
        const d = detected as PlanSequenceDetect | null;
        if (!d?.repositoryId) return [];
        const decision = typeof formValues.decision === 'string' ? formValues.decision : 'sequence';
        if (decision !== 'sequence') return [];
        const nodes = await loadPlanSkeletons(ctx.db, d.repositoryId);
        return buildWave(ctx, d, nodes, d.wave + 1);
      },
    },

    async apply(ctx, args): Promise<PlanSequenceApply> {
      const d = args.detected;
      const result: PlanSequenceApply = {
        reordered: 0,
        dispatched: 0,
        remaining: d.targets.length,
        decision: 'nothing_to_do',
        disagreements: d.disagreements.length,
        edgesRemoved: 0,
      };
      if (!d.repositoryId || d.nodeCount === 0) return result;

      const values = (args.formValues ?? {}) as FormValues;

      /** Write the order the recorded edges already imply, then flush. Runs at
       *  the END of a pass, never before the agents: ordering the siblings first
       *  would hand every agent the edge-derived order as its starting point,
       *  and an agent anchored on the claim it is being used to check is not a
       *  second opinion. */
      const settle = async (): Promise<void> => {
        const [nodes, edges] = await Promise.all([
          loadPlanSkeletons(ctx.db, d.repositoryId!),
          loadPlanEdges(ctx.db, d.repositoryId!),
        ]);
        result.reordered += await applyDeterministicOrder(ctx, d.repositoryId!, nodes, edges);
        // Groups still to ASK, matching what `detect` reports and what the next pass
        // would pick up — not every group the edges leave open. Those differ once the
        // asked-set spans passes, and the undecided count would say a finished plan
        // still had 876 groups to go.
        const asked = await loadAskedParents(ctx, d.repositoryId!);
        result.remaining = computeTargets(nodes, edges).targets.filter(
          (t) => !asked.has(t.parentId.toLowerCase()),
        ).length;
        if (result.reordered === 0) return;
        try {
          await writePlanMirror(ctx.db, d.repositoryId!, ctx.repoPath);
        } catch (err) {
          ctx.logger.warn({ err }, 'plan mirror write failed after sequencing');
        }
      };

      // The review answer. Checked FIRST and returning unconditionally, so the
      // reopen below can never loop: once this key exists the step finishes.
      if ('removeEdges' in values) {
        const chosen = Array.isArray(values.removeEdges)
          ? values.removeEdges.filter((v): v is string => typeof v === 'string')
          : [];
        const byId = new Map(d.disagreements.map((x) => [x.edgeId, x]));
        const ops = chosen.flatMap((edgeId) => {
          const x = byId.get(edgeId);
          return x
            ? [
                {
                  op: 'unlink' as const,
                  fromRef: x.fromNodeId,
                  toRef: x.toNodeId,
                  kind: 'depends_on' as const,
                },
              ]
            : [];
        });
        if (ops.length > 0) {
          const removed = await applyPlanPatch(
            ctx.db,
            { ops, summary: 'removed dependencies a second opinion contradicted' },
            { repositoryId: d.repositoryId, origin: 'user', sourceTaskId: ctx.taskId },
          );
          result.edgesRemoved = removed.unlinked;
        }
        await settle();
        result.decision = 'sequenced';
        return result;
      }

      const decision = typeof values.decision === 'string' ? values.decision : 'sequence';
      if (decision === 'skip') {
        result.decision = 'skipped';
        return result;
      }

      const fold = args.newAgentMiningResults ?? args.agentMiningResults ?? [];
      if (fold.length > 0) result.reordered += await foldSequenceResults(ctx, d.repositoryId, fold);

      if (decision === 'deterministic_only') {
        await settle();
        result.decision = 'deterministic_only';
        return result;
      }

      const [nodes, edges] = await Promise.all([
        loadPlanSkeletons(ctx.db, d.repositoryId),
        loadPlanEdges(ctx.db, d.repositoryId),
      ]);
      // The frontier is recomputed from the DATABASE every wave, minus the
      // parents whose ids already appear among this step's agents — so a parent
      // is never asked twice even though apply passes are independent calls.
      const rows = await loadSequenceRows(ctx);
      const state = askedState(rows);
      const askedRepo = await loadAskedParents(ctx, d.repositoryId);
      const { targets } = computeTargets(nodes, edges);
      const pending = targets.filter((t) => !askedRepo.has(t.parentId.toLowerCase()));
      result.remaining = pending.length;
      result.decision = 'sequenced';

      if (
        pending.length > 0 &&
        state.agents < SEQUENCE_AGENTS_PER_PASS &&
        !args.miningWaveExhausted
      ) {
        const dispatches = await buildWave(
          ctx,
          { ...d, targets: pending, agentsUsed: state.agents },
          nodes,
          state.wave + 1,
        );
        if (dispatches.length > 0) {
          result.dispatched = dispatches.length;
          throw new MiningWaveError(
            dispatches,
            `build order: ${dispatches.length} group(s) (${state.agents + dispatches.length}/${SEQUENCE_AGENTS_PER_PASS})`,
          );
        }
      }

      // Pass finished. `detected` was computed BEFORE this apply folded the last
      // wave, so it cannot see that wave's disagreements — re-park so detect runs
      // again over everything and the form has the complete set.
      //
      // Gated on the same predicate the form uses, from the values detect will
      // recompute: reopening on anything the form cannot see (a wave that
      // dispatched nothing, which leaves groups pending and the budget unspent)
      // asks for a form that will not exist and fails the step instead. Those
      // disagreements are not lost — they surface when the step is re-run.
      const disagreements = collectDisagreements(nodes, edges, agentOrdinals(rows));
      if (disagreements.length > 0 && sequencePassComplete(pending.length, state.agents)) {
        result.disagreements = disagreements.length;
        throw new ReopenStepFormError(
          `${disagreements.length} recorded dependency(ies) contradict the order chosen without them`,
        );
      }

      await settle();
      return result;
    },
  };
}

/** Runs at the end of a plan build, once the tree exists. */
export const planSequenceStep = createPlanSequenceStep({
  workflowType: 'plan_build',
  index: 2,
  title: 'Build order',
});

/** The same step as its own task, so an ALREADY-BUILT plan can be ordered
 *  without rebuilding it. That is not a nicety: `plan_build` runs its steps
 *  once, so every plan that existed before this feature — including the one this
 *  was written for — can be reached no other way. */
export const standalonePlanSequenceStep = createPlanSequenceStep({
  workflowType: 'plan_sequence',
  index: 0,
  title: 'Build order',
});
