import { CONFIG_KEYS, configService, type FormSchema, type FormValues } from '@haive/shared';
import {
  applyPlanPatch,
  findPlanRoot,
  loadPlanSkeletons,
  renderPlanMarkdown,
} from '@haive/shared/plan';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { markPlanCodeLinksStaleForPaths } from '../../../plan/code-link-staleness.js';
import { PLAN_PATCH_CONTRACT } from '../plan/_plan-prompt.js';
import { MAX_PROPOSED_OPS, describePlanOp, proposedOps } from './_plan-ops.js';
import {
  externalCommitBlock,
  resolveExternalDrift,
  stampExternalWatermark,
  type ExternalCommit,
} from './_external-drift.js';

/**
 * Bring the plan in line with commits Haive did not make.
 *
 * The plan is the durable statement of what a project is MEANT to be, and work that
 * happens outside the workflow changes the project without telling it anything.
 * `11f-plan-reconcile` closes that gap for what a TASK did — it scopes on
 * `collectImplementationFiles`, this branch's own merge-base diff — so a teammate's push
 * was invisible to it by construction.
 *
 * Two halves with different standing, and the split is the point:
 *
 *  - Code-link staleness is DETERMINISTIC and unconditional. A link recorded at one commit
 *    says "this file implements that component", and any change is a chance for that to
 *    stop being true. That is a fact about the code, so it is flagged in detect() whether
 *    or not the agent runs and whether or not the developer approves anything.
 *  - Everything else is a PROPOSAL a person ticks. An agent inferring plan structure from
 *    a diff is exactly the judgement that needs a human, and a plan that silently reshapes
 *    itself after every pull is worse than one that is merely behind.
 */

export interface ExternalPlanSyncDetect {
  repositoryId: string | null;
  branchPoint: string | null;
  since: string | null;
  firstRun: boolean;
  measured: boolean;
  commits: ExternalCommit[];
  changedPaths: string[];
  commitsOmitted: number;
  pathsOmitted: number;
  reason: string | null;
  planMarkdown: string;
  /** Every node id to its title, so form() — which is synchronous and cannot read the
   *  database — can NAME what each op touches. */
  nodeTitles: Record<string, string>;
  nodeCount: number;
  /** Code links flagged stale by this step's own detect, for the form's disclosure. */
  linksMarkedStale: number;
}

export interface ExternalPlanSyncApply {
  decision: 'applied' | 'declined' | 'nothing_to_review' | 'tracking_started' | 'not_measured';
  commitsReviewed: number;
  reviewedThrough: string | null;
  proposed: number;
  applied: number;
  created: number;
  updated: number;
  codeLinked: number;
  linksMarkedStale: number;
  /** Lifted verbatim into the step's summary panel by `resolveCuratedSummary`. */
  summary: string;
}

function buildPrompt(d: ExternalPlanSyncDetect): string {
  return [
    'Commits reached this repository WITHOUT going through this workflow — a teammate',
    'pushed, someone committed from their own editor, or a pull merged other work in.',
    'Bring the PROJECT PLAN back in line with what now exists.',
    '',
    'The plan is a durable statement of what the project is MEANT to be. It is not a',
    'changelog and not a description of the diff — do not add a node for a bug that was',
    'fixed or for a refactor that changed no capability.',
    '',
    '## The plan as it stands',
    '',
    d.planMarkdown,
    '',
    '## Commits made outside the workflow',
    '',
    externalCommitBlock(d),
    '',
    '## Files those commits touched',
    '',
    ...d.changedPaths.map((p) => `- ${p}`),
    ...(d.pathsOmitted > 0 ? [`- (+${d.pathsOmitted} further path(s) not listed)`] : []),
    '',
    '## What to propose',
    '',
    'Exactly three kinds of change, and nothing else:',
    '',
    '1. STATUS. Mark a node `done` when this work actually finished the thing it describes.',
    '   A node these commits merely touched is NOT finished, and marking one done when it',
    '   is not is worse than leaving it alone — the plan is what someone reads to decide',
    '   what is left.',
    '2. CODE LINKS. Add `codeLinks` for files above that belong to an existing node. Only',
    '   for a file you can see in the list, and say in `evidence` why it belongs. A guessed',
    '   path makes the impact view lie. Set `"role": "covers"` for a TEST file and leave the',
    '   default `implements` for production code.',
    '3. NEW NODES. Add a node only for a real capability this work built that the plan does',
    '   not describe anywhere. Check the plan above first — a node that duplicates an',
    '   existing one is worse than a missing one.',
    '',
    'You are reading commit subjects, not a specification: they say WHERE the work landed',
    'and rarely what it was for. Read the files before you claim a node is finished, and',
    'propose nothing where the subjects and the diff do not support a claim.',
    '',
    `Propose at most ${MAX_PROPOSED_OPS} operations. Propose NOTHING (an empty \`ops\` array)`,
    'if the plan already describes what happened — that is a good answer, and the common one',
    'for maintenance work.',
    '',
    'Every change you propose is shown to a developer who ticks the ones they want. Write',
    'each one so it can be judged on its own.',
    '',
    PLAN_PATCH_CONTRACT,
  ].join('\n');
}

export const externalPlanSyncStep: StepDefinition<ExternalPlanSyncDetect, ExternalPlanSyncApply> = {
  metadata: {
    id: '01f-external-plan-sync',
    workflowType: 'workflow',
    // Immediately after the knowledge-base catch-up (1.8) and before 02-pre-rag-sync (2).
    // 04-phase-0b reads the plan for its `## Affected components` section, so a plan
    // reconciled at the tail would leave this task resolving a blast radius against a plan
    // that predates the code.
    index: 1.9,
    title: 'Plan catch-up',
    description:
      'Proposes plan updates from commits that reached this repository outside the ' +
      'workflow — status, code links and any new component — for the developer to ' +
      'approve. Applies only what is ticked.',
    requiresCli: true,
    // Nothing here blocks the task; a plan one round behind is a smaller problem than a
    // task that cannot start.
    allowSkip: true,
  },

  async shouldRun(): Promise<boolean> {
    if ((await configService.getBoolean(CONFIG_KEYS.EXTERNAL_SYNC_ENABLED, true)) === false) {
      return false;
    }
    return (await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) !== false;
  },

  async detect(ctx: StepContext): Promise<ExternalPlanSyncDetect> {
    await ctx.emitProgress('Looking for commits made outside the workflow...');
    const drift = await resolveExternalDrift(ctx, 'plan');
    const empty: ExternalPlanSyncDetect = {
      repositoryId: drift.repositoryId,
      branchPoint: drift.branchPoint,
      since: drift.since,
      firstRun: drift.firstRun,
      measured: drift.measured,
      commits: drift.commits,
      changedPaths: drift.changedPaths,
      commitsOmitted: drift.commitsOmitted,
      pathsOmitted: drift.pathsOmitted,
      reason: drift.reason,
      planMarkdown: '',
      nodeTitles: {},
      nodeCount: 0,
      linksMarkedStale: 0,
    };
    if (!drift.repositoryId) return empty;
    const root = await findPlanRoot(ctx.db, drift.repositoryId);
    if (!root) return { ...empty, reason: drift.reason ?? 'this repository has no plan' };

    // Unconditional, and before anything is proposed: a link whose file has changed is of
    // uncertain age whatever the agent or the developer decides next. Idempotent — already
    // stale links are excluded by the update's own predicate — so a Retry re-runs it
    // safely.
    const { marked } = await markPlanCodeLinksStaleForPaths(
      ctx.db,
      drift.repositoryId,
      drift.changedPaths,
    );

    const [planMarkdown, nodes] = await Promise.all([
      renderPlanMarkdown(ctx.db, drift.repositoryId, { titlesOnly: true, maxDepth: 4 }),
      loadPlanSkeletons(ctx.db, drift.repositoryId),
    ]);
    return {
      ...empty,
      planMarkdown,
      nodeTitles: Object.fromEntries(nodes.map((n) => [n.id, n.title])),
      nodeCount: nodes.length,
      linksMarkedStale: marked,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    // It reads the plan, a commit list and a file list; it has no reason to drive a
    // browser or a container. Same profile as 11f, which asks the same question.
    toolProfile: 'rag_only',
    timeoutMs: 10 * 60 * 1000,
    // The proposal has to exist before the form can offer it.
    preForm: true,
    // A catch-up that failed or could not be dispatched must never stop a task starting.
    // The runner degrades to `llmOutput = null` and the form finds nothing to offer — the
    // staleness flagging in detect() has already happened either way.
    optional: true,
    skipIf: (args) => {
      const d = args.detected as ExternalPlanSyncDetect | null;
      return !d?.repositoryId || d.nodeCount === 0 || d.commits.length === 0;
    },
    buildPrompt: (args) => buildPrompt(args.detected as ExternalPlanSyncDetect),
    bypassStub: () => ({ ops: [] }),
  },

  form(_ctx, detected, llmOutput): FormSchema | null {
    if (!detected.repositoryId || detected.commits.length === 0) return null;
    const ops = proposedOps(llmOutput);
    // An empty proposal is the normal outcome for maintenance work. Parking a form on it
    // would ask the developer to confirm that nothing happened.
    if (ops.length === 0) return null;
    const titleById = new Map(Object.entries(detected.nodeTitles));
    const n = detected.commits.length;
    return {
      title: 'Plan updates from work done outside the workflow',
      description: [
        `${n} commit${n === 1 ? '' : 's'} reached this repository outside the workflow` +
          (detected.commitsOmitted > 0 ? ` (+${detected.commitsOmitted} not listed)` : '') +
          `, touching ${detected.changedPaths.length} file(s). The proposals below bring ` +
          'the plan in line with them. Everything is ticked; untick anything you disagree ' +
          'with, and clear them all to change nothing.',
        '',
        detected.linksMarkedStale > 0
          ? `${detected.linksMarkedStale} existing code link(s) were flagged stale because ` +
            'their files changed. That is recorded already and is not part of this ' +
            'approval — a link is cleared only when an agent re-asserts it.'
          : '',
        '',
        externalCommitBlock(detected),
      ]
        .filter(Boolean)
        .join('\n'),
      fields: [
        {
          id: 'applyOps',
          type: 'multi-select',
          label: 'Changes to apply to the plan',
          options: ops.map((op, i) => ({ value: String(i), label: describePlanOp(op, titleById) })),
          defaults: ops.map((_, i) => String(i)),
        },
      ],
      submitLabel: 'Apply to the plan',
    };
  },

  async apply(ctx, args): Promise<ExternalPlanSyncApply> {
    const d = args.detected;
    const base: ExternalPlanSyncApply = {
      decision: 'not_measured',
      commitsReviewed: 0,
      reviewedThrough: null,
      proposed: 0,
      applied: 0,
      created: 0,
      updated: 0,
      codeLinked: 0,
      linksMarkedStale: d.linksMarkedStale,
      summary: '',
    };

    // Same rule as the knowledge-base catch-up: only a MEASURED range may advance the
    // watermark, because "nothing changed" and "could not tell" are the same empty list.
    if (!d.repositoryId || !d.measured || !d.branchPoint) {
      return { ...base, summary: d.reason ?? 'external changes could not be measured' };
    }
    const stamp = async (): Promise<void> => {
      await stampExternalWatermark(ctx.db, d.repositoryId!, 'plan', d.branchPoint!);
    };

    if (d.firstRun) {
      await stamp();
      return {
        ...base,
        decision: 'tracking_started',
        reviewedThrough: d.branchPoint,
        summary:
          'No catch-up baseline existed for this repository, so plan tracking starts at ' +
          'the current commit. Earlier history is not reviewed.',
      };
    }
    if (d.commits.length === 0 || d.nodeCount === 0) {
      await stamp();
      return {
        ...base,
        decision: 'nothing_to_review',
        reviewedThrough: d.branchPoint,
        summary: d.reason ?? 'No commits reached this repository outside the workflow.',
      };
    }

    const ops = proposedOps(args.llmOutput);
    const values = (args.formValues ?? {}) as FormValues;
    const ticked = new Set(
      Array.isArray(values.applyOps)
        ? values.applyOps.filter((v): v is string => typeof v === 'string')
        : [],
    );
    const chosen = ops.filter((_, i) => ticked.has(String(i)));

    if (ops.length === 0 || chosen.length === 0) {
      await stamp();
      return {
        ...base,
        // No form parks when the agent proposed nothing, so that case is not a decline.
        decision: ops.length === 0 ? 'nothing_to_review' : 'declined',
        commitsReviewed: d.commits.length,
        reviewedThrough: d.branchPoint,
        proposed: ops.length,
        summary:
          ops.length === 0
            ? `Reviewed ${d.commits.length} external commit(s); the plan already described them.`
            : `Declined all ${ops.length} proposed plan change(s) for ${d.commits.length} external commit(s).`,
      };
    }

    // `origin: 'user'` and not `applyAgentPatch`: a developer read each of these and ticked
    // it, so the write is theirs. `derivedAtCommit` IS set here — unlike 11f, which has no
    // single commit to name — so a link written now can be dated, and later aged, against
    // the exact commit the evidence came from. `onUnresolvableRef: 'drop'` because a node
    // can be deleted by a plan chat while the form sits parked, and one stale id must lose
    // its own op rather than the developer's whole approved set.
    const applied = await applyPlanPatch(
      ctx.db,
      { ops: chosen, summary: 'plan catch-up for commits made outside the workflow' },
      {
        repositoryId: d.repositoryId,
        origin: 'user',
        sourceTaskId: ctx.taskId,
        derivedAtCommit: d.branchPoint,
        onUnresolvableRef: 'drop',
      },
    );
    if (applied.dropped.length > 0) {
      ctx.logger.warn({ dropped: applied.dropped }, 'external plan sync dropped stale ops');
    }
    try {
      await writePlanMirror(ctx.db, d.repositoryId, ctx.repoPath);
    } catch (err) {
      ctx.logger.warn({ err }, 'plan mirror write failed after external sync (non-fatal)');
    }

    await stamp();
    return {
      decision: 'applied',
      commitsReviewed: d.commits.length,
      reviewedThrough: d.branchPoint,
      proposed: ops.length,
      applied: chosen.length,
      created: applied.created.length,
      updated: applied.updated.length,
      codeLinked: applied.codeLinked,
      linksMarkedStale: d.linksMarkedStale,
      summary:
        `Applied ${chosen.length} of ${ops.length} proposed plan change(s) from ` +
        `${d.commits.length} external commit(s): ${applied.created.length} node(s) created, ` +
        `${applied.updated.length} updated, ${applied.codeLinked} code link(s) written.`,
    };
  },
};
