import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, type FormSchema, type FormValues } from '@haive/shared';
import {
  applyPlanPatch,
  findPlanRoot,
  loadPlanSkeletons,
  renderPlanMarkdown,
} from '@haive/shared/plan';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { PLAN_PATCH_CONTRACT } from '../plan/_plan-prompt.js';
import { MAX_PROPOSED_OPS, describePlanOp, proposedOps } from './_plan-ops.js';
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
  /** Every node id to its title, so the form can NAME what each op touches.
   *  form() is synchronous and cannot read the database, so the titles have to
   *  travel in the detect payload. Optional: a payload persisted before this
   *  existed renders shortened ids instead. */
  nodeTitles?: Record<string, string>;
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
    loadPlanSkeletons(ctx.db, task.repositoryId),
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
    nodeTitles: Object.fromEntries(nodes.map((n) => [n.id, n.title])),
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
    '2. CODE LINKS. Add `codeLinks` for files above that belong to an existing node. Only for a',
    '   file you can see in the list, and say in `evidence` why it belongs. A guessed path makes',
    '   the impact view lie. Set `"role": "covers"` for a TEST file and leave the default',
    '   `implements` for production code — the test steps of a later task are told which tests',
    '   cover the components it touches, and they can only be told from these links.',
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
    const titleById = new Map(Object.entries(detected.nodeTitles ?? {}));
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
