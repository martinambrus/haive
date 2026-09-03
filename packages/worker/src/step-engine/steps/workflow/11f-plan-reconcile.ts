import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, type FormSchema, type FormValues } from '@haive/shared';
import {
  applyPlanPatch,
  findPlanRoot,
  loadPlanNodes,
  renderPlanMarkdown,
} from '@haive/shared/plan';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { PLAN_PATCH_CONTRACT, parsePlanPatch } from '../plan/_plan-prompt.js';
import { resolveApprovedSpec, resolveTaskWorktreePath } from './_spec-artifact.js';
import { collectImplementationFiles } from './_impl-changes.js';

/**
 * What this task changed, offered back to the plan as a patch a person approves.
 *
 * The plan is the durable statement of what a project is MEANT to be, and an
 * implementation task changes the project without telling it anything. Parts 1
 * and 2 stopped the plan lying about that and made the drift visible; this is
 * the step that can actually close it — it reads the diff and the spec, proposes
 * node status changes, code links and new nodes, and then STOPS.
 *
 * It never applies anything the developer did not tick. That is not caution for
 * its own sake: an agent inferring plan structure from a diff is exactly the
 * judgement the sequencing work already showed needs a human, and a plan that
 * silently reshapes itself after every task is worse than one that is merely
 * behind.
 */

/** Everything the agent is shown, and what the form needs to describe itself. */
export interface PlanReconcileDetect {
  repositoryId: string | null;
  planMarkdown: string;
  spec: string;
  changedPaths: string[];
  /** Nodes 04-phase-0b said this task affects, so the agent starts where the
   *  spec already pointed rather than re-deriving it from the diff. */
  affected: { id: string; title: string }[];
  nodeCount: number;
}

export interface PlanReconcileApply {
  proposed: number;
  applied: number;
  created: number;
  updated: number;
  codeLinked: number;
  decision: 'applied' | 'declined' | 'nothing_to_do';
}

/** A patch bigger than this is not a reconcile, it is a rewrite, and no one can
 *  review it in a form. The agent is told the limit; this is the backstop. */
export const MAX_PROPOSED_OPS = 40;

type ProposedOp = Record<string, unknown>;

/** The proposals, however the runner hands them over. */
export function proposedOps(llmOutput: unknown): ProposedOp[] {
  const patch = parsePlanPatch(llmOutput);
  if (!patch) return [];
  return patch.ops.slice(0, MAX_PROPOSED_OPS) as ProposedOp[];
}

/**
 * One proposed op as a line a person can judge without reading JSON.
 *
 * Exported for its own test: this is the only thing standing between the
 * developer and approving something they did not understand, so an op shape it
 * cannot describe must say so rather than render as an empty tick box.
 */
export function describePlanOp(op: ProposedOp, titleById: Map<string, string>): string {
  const name = (ref: unknown): string => {
    if (typeof ref !== 'string') return 'a node';
    return titleById.get(ref) ? `"${titleById.get(ref)}"` : `"${ref.slice(0, 8)}…"`;
  };
  switch (op.op) {
    case 'upsert': {
      const known = typeof op.nodeRef === 'string' && titleById.has(op.nodeRef);
      if (!known) return `Add node "${String(op.title ?? 'untitled')}" under ${name(op.parentRef)}`;
      const parts: string[] = [];
      if (op.status) parts.push(`mark ${String(op.status)}`);
      if (op.taskable !== undefined) parts.push(op.taskable ? 'mark taskable' : 'unmark taskable');
      if (op.title) parts.push('rename');
      if (op.body !== undefined) parts.push('rewrite its description');
      if (Array.isArray(op.codeLinks)) {
        const paths = op.codeLinks
          .map((l) => (l as { repoPath?: unknown }).repoPath)
          .filter((x): x is string => typeof x === 'string');
        if (paths.length > 0) parts.push(`link ${paths.join(', ')}`);
      }
      return `Update ${name(op.nodeRef)}: ${parts.length > 0 ? parts.join('; ') : 'no visible change'}`;
    }
    case 'link':
      return `Link ${name(op.fromRef)} → ${name(op.toRef)} (${String(op.kind)})`;
    case 'unlink':
      return `Remove the ${String(op.kind)} link ${name(op.fromRef)} → ${name(op.toRef)}`;
    case 'delete':
      return `Delete ${name(op.nodeRef)} and everything under it`;
    default:
      // Never a silent empty label: an op nobody can read is one nobody should
      // be able to approve by accident.
      return `Unrecognised change (${String(op.op ?? 'no op')}) — leave this unticked`;
  }
}

async function detectReconcile(ctx: StepContext): Promise<PlanReconcileDetect> {
  const empty: PlanReconcileDetect = {
    repositoryId: null,
    planMarkdown: '',
    spec: '',
    changedPaths: [],
    affected: [],
    nodeCount: 0,
  };
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { repositoryId: true, changedPaths: true },
  });
  if (!task?.repositoryId) return empty;
  const root = await findPlanRoot(ctx.db, task.repositoryId);
  if (!root) return empty;

  // `changedPaths` is written only on gate 3's SUCCESS branch, so an unticked
  // "commit now", a repo with no git, or an empty stage all leave it null. That
  // is not "nothing happened" — fall back to what the implementation step and
  // the DAG recorded.
  let changedPaths = task.changedPaths ?? [];
  if (changedPaths.length === 0) {
    try {
      // Durable (reads `tasks.worktree_path`), so it survives a Retry that
      // nulls 01-worktree-setup's output. Null when no worktree was made.
      const worktree = await resolveTaskWorktreePath(ctx);
      if (worktree) changedPaths = (await collectImplementationFiles(ctx, worktree)).files;
    } catch (err) {
      ctx.logger.warn({ err }, 'could not resolve changed files for plan reconcile');
    }
  }

  const [planMarkdown, spec, nodes] = await Promise.all([
    renderPlanMarkdown(ctx.db, task.repositoryId, { titlesOnly: true, maxDepth: 4 }),
    resolveApprovedSpec(ctx),
    loadPlanNodes(ctx.db, task.repositoryId),
  ]);

  // 04-phase-0b resolved this already; it is best-effort because `_step-reset`
  // nulls step output on a Retry cascade.
  const affected = await ctx.db
    .select({ nodeId: schema.planNodeTasks.nodeId })
    .from(schema.planNodeTasks)
    .where(eq(schema.planNodeTasks.taskId, ctx.taskId))
    .then((rows) => {
      const byId = new Map(nodes.map((n) => [n.id, n.title]));
      return rows.flatMap((r) =>
        byId.has(r.nodeId) ? [{ id: r.nodeId, title: byId.get(r.nodeId)! }] : [],
      );
    })
    .catch(() => []);

  return {
    repositoryId: task.repositoryId,
    planMarkdown,
    spec,
    changedPaths,
    affected,
    nodeCount: nodes.length,
  };
}

function buildReconcilePrompt(d: PlanReconcileDetect): string {
  return [
    'A development task has just finished on this repository. Bring the PROJECT PLAN back in',
    'line with what now exists.',
    '',
    'The plan is a durable statement of what the project is MEANT to be. It is not a changelog',
    'and not a description of the diff — do not add a node for a bug that was fixed or for a',
    'refactor that changed no capability.',
    '',
    '## The plan as it stands',
    '',
    d.planMarkdown,
    '',
    ...(d.affected.length > 0
      ? [
          '## Components this task was expected to affect',
          '',
          ...d.affected.map((a) => `- ${a.title} (\`node:${a.id}\`)`),
          '',
        ]
      : []),
    '## Files this task changed',
    '',
    ...d.changedPaths.slice(0, 200).map((p) => `- ${p}`),
    '',
    ...(d.spec ? ['## What the task set out to do', '', d.spec, ''] : []),
    '## What to propose',
    '',
    'Exactly three kinds of change, and nothing else:',
    '',
    '1. STATUS. Mark a node `done` when this task actually finished the thing it describes.',
    '   A node this task merely touched is NOT finished — most affected components are still',
    '   partly built, and marking one done when it is not is worse than leaving it alone,',
    '   because the plan is what someone reads to decide what is left.',
    '2. CODE LINKS. Add `codeLinks` for files above that implement an existing node. Only for a',
    '   file you can see in the list, and say in `evidence` why it belongs. A guessed path makes',
    '   the impact view lie.',
    '3. NEW NODES. Add a node only for a real capability this task built that the plan does not',
    '   describe anywhere. Check the plan above first — a node that duplicates an existing one',
    '   is worse than a missing one.',
    '',
    `Propose at most ${MAX_PROPOSED_OPS} operations. Propose NOTHING (an empty \`ops\` array) if`,
    'the plan already describes what happened — that is the normal outcome for a task that',
    'implemented an existing node, and an empty reply is a good answer.',
    '',
    'Every change you propose is shown to a developer who ticks the ones they want. Write each',
    'one so it can be judged on its own.',
    '',
    PLAN_PATCH_CONTRACT,
  ].join('\n');
}

export const planReconcileStep: StepDefinition<PlanReconcileDetect, PlanReconcileApply> = {
  metadata: {
    id: '11f-plan-reconcile',
    workflowType: 'workflow',
    // 11.7 is the RAG re-index and 11.8 is prompt-guidance triage; this sits
    // after both and before the 11a push gate (12), while the worktree still
    // exists and the task's code is committed.
    index: 11.9,
    title: 'Plan reconcile',
    description:
      'Proposes plan updates from what this task changed — status, code links and any new ' +
      'component — for the developer to approve. Applies only what is ticked.',
    requiresCli: true,
    // Nothing here blocks shipping code; a plan that stays behind one more task
    // is a smaller problem than a task that cannot finish.
    allowSkip: true,
  },

  async shouldRun(): Promise<boolean> {
    return (await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) !== false;
  },

  detect: detectReconcile,

  llm: {
    requiredCapabilities: ['tool_use'],
    // It reads the plan, the spec and a file list, all of which are in the
    // prompt; it has no reason to drive a browser or a container.
    toolProfile: 'rag_only',
    timeoutMs: 10 * 60 * 1000,
    // The proposal has to exist before the form can offer it.
    preForm: true,
    // Load-bearing rather than tidy: this step sits immediately before the push
    // gate, and a plan reconcile that failed or could not be dispatched must
    // never stop a task shipping working code. The runner degrades to
    // `llmOutput = null` and the form finds nothing to offer.
    optional: true,
    skipIf: (args) => {
      const d = args.detected as PlanReconcileDetect | null;
      return !d?.repositoryId || d.nodeCount === 0 || d.changedPaths.length === 0;
    },
    buildPrompt: (args) => buildReconcilePrompt(args.detected as PlanReconcileDetect),
    bypassStub: () => ({ ops: [] }),
  },

  form(_ctx, detected, llmOutput): FormSchema | null {
    if (!detected.repositoryId) return null;
    const ops = proposedOps(llmOutput);
    // An empty proposal is the NORMAL outcome for a task that implemented an
    // existing node. Parking a form on it would ask the developer to confirm
    // that nothing happened.
    if (ops.length === 0) return null;
    const titleById = new Map<string, string>();
    return {
      title: 'Plan updates from this task',
      description:
        `This task changed ${detected.changedPaths.length} file(s). The proposals below bring ` +
        'the plan in line with them. Everything is ticked; untick anything you disagree with, ' +
        'and clear them all to change nothing.',
      fields: [
        {
          id: 'applyOps',
          type: 'multi-select',
          label: 'Changes to apply to the plan',
          options: ops.map((op, i) => ({
            value: String(i),
            label: describePlanOp(op, titleById),
          })),
          // Ticked by default: the step exists to keep the plan current, and a
          // form that starts empty is one nobody fills in. Nothing is applied
          // until it is submitted either way.
          defaults: ops.map((_, i) => String(i)),
        },
      ],
      submitLabel: 'Apply to the plan',
    };
  },

  async apply(ctx, args): Promise<PlanReconcileApply> {
    const d = args.detected;
    const result: PlanReconcileApply = {
      proposed: 0,
      applied: 0,
      created: 0,
      updated: 0,
      codeLinked: 0,
      decision: 'nothing_to_do',
    };
    if (!d.repositoryId) return result;

    const ops = proposedOps(args.llmOutput);
    result.proposed = ops.length;
    if (ops.length === 0) return result;

    const values = (args.formValues ?? {}) as FormValues;
    const ticked = new Set(
      Array.isArray(values.applyOps)
        ? values.applyOps.filter((v): v is string => typeof v === 'string')
        : [],
    );
    const chosen = ops.filter((_, i) => ticked.has(String(i)));
    result.applied = chosen.length;
    if (chosen.length === 0) {
      result.decision = 'declined';
      return result;
    }

    // `origin: 'user'` and NOT `applyAgentPatch`: a developer read each of these
    // and ticked it, so the write is theirs. It also deliberately does NOT set
    // `marksReviewed` — an agent proposing a change is not an agent having
    // reviewed the node against the code, and claiming otherwise would clear the
    // drift warning this whole feature exists to raise.
    //
    // `onUnresolvableRef: 'drop'` because the proposal was made before the form
    // parked, and a node can be deleted by a plan chat while it sits there — one
    // stale id must lose its own op, not the developer's whole approved set.
    const applied = await applyPlanPatch(
      ctx.db,
      { ops: chosen, summary: 'plan reconcile after task implementation' },
      {
        repositoryId: d.repositoryId,
        origin: 'user',
        sourceTaskId: ctx.taskId,
        onUnresolvableRef: 'drop',
      },
    );
    result.created = applied.created.length;
    result.updated = applied.updated.length;
    result.codeLinked = applied.codeLinked;
    result.decision = 'applied';
    if (applied.dropped.length > 0) {
      ctx.logger.warn({ dropped: applied.dropped }, 'plan reconcile dropped stale ops');
    }

    try {
      await writePlanMirror(ctx.db, d.repositoryId, ctx.repoPath);
    } catch (err) {
      ctx.logger.warn({ err }, 'plan mirror write failed after reconcile (non-fatal)');
    }
    return result;
  },
};
