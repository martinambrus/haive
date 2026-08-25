import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, type FormSchema, type PlanNodeStatus } from '@haive/shared';
import { applyPlanPatch, loadPlanNode } from '@haive/shared/plan';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import type { AdvisoryFindings } from './01-advisory-research.js';

/**
 * The decision, made by the USER.
 *
 * The agent researched; it does not get to close the question. That asymmetry is
 * the whole reason `external` and `research` are their own kinds: an unsigned
 * contract or an unregistered domain is not resolved by an agent concluding that
 * it should be, and a step that marked such a node `done` on the agent's say-so
 * would quietly turn a real blocker into a green tick.
 *
 * So this step parks on a form and stays parked until a person submits it.
 */

interface DecisionDetect {
  repositoryId: string | null;
  nodeId: string | null;
  nodeTitle: string;
  nodeVersion: number;
  nodeBody: string;
  findings: string;
  options: { label: string; summary: string }[];
}

interface DecisionApply {
  status: PlanNodeStatus | null;
  bodyWritten: boolean;
  decision: string;
}

async function loadFindings(ctx: StepContext): Promise<AdvisoryFindings | null> {
  const [row] = await ctx.db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, ctx.taskId))
    .orderBy(schema.taskSteps.stepIndex);
  void row;
  const rows = await ctx.db
    .select({ stepId: schema.taskSteps.stepId, output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, ctx.taskId));
  const research = rows.find((r) => r.stepId === '01-advisory-research');
  return (research?.output ?? null) as AdvisoryFindings | null;
}

export const advisoryDecisionStep: StepDefinition<DecisionDetect, DecisionApply> = {
  metadata: {
    id: '02-advisory-decision',
    workflowType: 'advisory',
    index: 1,
    title: 'Decide',
    description:
      'Records the human decision on a researched blocker and writes the findings into the plan node. The agent never closes this.',
    requiresCli: false,
  },

  async shouldRun(): Promise<boolean> {
    return (await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) !== false;
  },

  async detect(ctx): Promise<DecisionDetect> {
    const [task] = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId, metadata: schema.tasks.metadata })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = task?.repositoryId ?? null;
    const nodeId = ((task?.metadata ?? {}) as { planNodeId?: string }).planNodeId ?? null;
    const findings = await loadFindings(ctx);

    const empty: DecisionDetect = {
      repositoryId,
      nodeId,
      nodeTitle: '',
      nodeVersion: 0,
      nodeBody: '',
      findings: findings?.findings ?? '',
      options: findings?.options ?? [],
    };
    if (!repositoryId || !nodeId) return empty;
    const node = await loadPlanNode(ctx.db, repositoryId, nodeId);
    if (!node) return empty;
    return {
      ...empty,
      nodeTitle: node.title,
      nodeVersion: node.version,
      nodeBody: node.body ?? '',
    };
  },

  form(_ctx, detected): FormSchema | null {
    if (!detected.nodeId) return null;
    return {
      title: `Decide: ${detected.nodeTitle}`,
      description: detected.findings || 'No research findings were produced.',
      fields: [
        ...(detected.options.length > 0
          ? [
              {
                type: 'note' as const,
                id: 'optionsInfo',
                label: 'Options the research found',
                body: detected.options.map((o) => `**${o.label}** — ${o.summary}`).join('\n\n'),
              },
            ]
          : []),
        {
          type: 'textarea' as const,
          id: 'decision',
          label: 'What did you decide?',
          description: 'Recorded on the node so the next person does not re-open the question.',
          required: false,
        },
        {
          type: 'select' as const,
          id: 'status',
          label: 'Where does this leave the node?',
          description:
            'Still blocked keeps it amber and keeps blocking everything above it, which is the honest answer while you are waiting on someone.',
          default: 'blocked_human',
          options: [
            { value: 'blocked_human', label: 'Still blocked — waiting on a person' },
            { value: 'in_progress', label: 'In progress — decided, now being done' },
            { value: 'done', label: 'Done — settled, nothing left to do' },
            { value: 'not_applicable', label: 'Not applicable — decided against' },
          ],
        },
        {
          type: 'checkbox' as const,
          id: 'writeFindings',
          label: 'Append the research findings to the node description',
          default: true,
        },
      ],
    };
  },

  async apply(ctx, args): Promise<DecisionApply> {
    const d = args.detected;
    const values = args.formValues as {
      decision?: string;
      status?: string;
      writeFindings?: boolean;
    };
    if (!d.repositoryId || !d.nodeId) {
      return { status: null, bodyWritten: false, decision: '' };
    }

    const decision = (values.decision ?? '').trim();
    const status = (values.status ?? 'blocked_human') as PlanNodeStatus;

    const parts = [d.nodeBody.trim()];
    if (values.writeFindings !== false && d.findings) {
      parts.push(`## Research\n\n${d.findings}`);
    }
    if (decision) parts.push(`## Decision\n\n${decision}`);
    const body = parts.filter(Boolean).join('\n\n');
    const bodyWritten = body !== d.nodeBody.trim();

    // Re-read the version rather than trusting detect's: this step parks on a
    // form, so an unbounded amount of time — and any number of plan chats — can
    // pass between the two.
    const fresh = await loadPlanNode(ctx.db, d.repositoryId, d.nodeId);
    await applyPlanPatch(
      ctx.db,
      {
        ops: [
          {
            op: 'upsert',
            nodeRef: d.nodeId,
            status,
            ...(bodyWritten ? { body } : {}),
            ...(fresh ? { expectedVersion: fresh.version } : {}),
          },
        ],
      },
      { repositoryId: d.repositoryId, origin: 'user', sourceTaskId: ctx.taskId },
    );

    try {
      await writePlanMirror(ctx.db, d.repositoryId, ctx.repoPath);
    } catch (err) {
      ctx.logger.warn({ err }, 'plan mirror write failed (non-fatal)');
    }

    return { status, bodyWritten, decision };
  },
};
