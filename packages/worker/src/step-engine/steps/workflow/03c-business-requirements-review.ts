import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { recordBizReqDecision } from './_biz-req-feedback.js';

// Phase 1 review — human sign-off for the business-requirements doc that 03b
// drafts. Split from 03b so the agent mines ONLY after the user opts in at the
// 03b gate (no auto-draft), and the drafted doc then gets its own Approve/Reject
// screen. shouldRun is false when 03b produced nothing (its gate was skipped, or
// the agent returned an empty/stub doc), so skipping the business-requirements
// gate skips this review too — "skip the business documentation" skips BOTH
// steps as a unit. Reject halts; retry 03b to re-mine and revise.

interface BizReqReviewDetect {
  taskTitle: string;
  requirements: string;
  summary: string;
}

interface BizReqReviewApply {
  requirements: string;
  summary: string;
  decision: 'approve' | 'reject';
  feedback: string;
}

interface BizReqOutput {
  requirements?: string;
  summary?: string;
}

/** Load 03b's stored business-requirements output (empty object when 03b was
 *  skipped or never ran). */
async function loadBizReq(ctx: StepContext): Promise<BizReqOutput> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03b-business-requirements');
  return (prev?.output as BizReqOutput | null) ?? {};
}

/** The skip-both gate: 03c only runs when 03b actually produced a requirements
 *  doc, so skipping 03b's gate auto-skips this review too. */
export function hasRequirements(out: BizReqOutput): boolean {
  return typeof out.requirements === 'string' && out.requirements.trim().length > 0;
}

export const businessRequirementsReviewStep: StepDefinition<BizReqReviewDetect, BizReqReviewApply> =
  {
    metadata: {
      id: '03c-business-requirements-review',
      workflowType: 'workflow',
      index: 3.6,
      title: 'Phase 1: Review business requirements',
      description:
        'Review the business-requirements doc drafted in the previous step and approve it (to ground the technical spec) or reject it. Auto-skips when the business-requirements step was skipped, so skipping that step skips this review too.',
      requiresCli: false,
    },

    // Skip BOTH steps as a unit: when 03b produced no requirements (the user
    // skipped its gate, or the agent returned an empty/stub doc) there is nothing
    // to review, so this step auto-skips.
    async shouldRun(ctx: StepContext): Promise<boolean> {
      return hasRequirements(await loadBizReq(ctx));
    },

    async detect(ctx: StepContext): Promise<BizReqReviewDetect> {
      const meta = await loadTaskMeta(ctx.db, ctx.taskId);
      const out = await loadBizReq(ctx);
      return {
        taskTitle: meta.title,
        requirements: out.requirements ?? '',
        summary: out.summary ?? '',
      };
    },

    form(_ctx, detected): FormSchema {
      const infoSections: InfoSection[] = [
        {
          title: 'Drafted business requirements',
          preview: detected.summary || `${detected.requirements.length} chars`,
          body: detected.requirements || '(no requirements drafted — reject and revise)',
          defaultOpen: true,
        },
      ];
      return {
        title: 'Phase 1: Review business requirements',
        description: [
          `Task: ${detected.taskTitle || '(untitled)'}`,
          '',
          'Review the drafted requirements below and approve to proceed to the technical spec,',
          'or reject with feedback to halt (retry the previous step to re-mine and revise).',
        ].join('\n'),
        infoSections,
        fields: [
          {
            type: 'radio',
            id: 'decision',
            label: 'Approve these business requirements?',
            options: [
              { value: 'approve', label: 'Approve — proceed to the technical spec' },
              { value: 'reject', label: 'Reject — request changes and halt' },
            ],
            default: 'approve',
            required: true,
          },
          {
            type: 'textarea',
            id: 'feedback',
            label: 'Feedback / refinements (optional)',
            rows: 4,
            placeholder: 'What to add, remove, or clarify in the requirements.',
          },
        ],
        submitLabel: 'Record decision',
      };
    },

    async apply(ctx, args): Promise<BizReqReviewApply> {
      const detected = args.detected as BizReqReviewDetect;
      const values = args.formValues as { decision?: string; feedback?: string };
      const decision: 'approve' | 'reject' = values.decision === 'reject' ? 'reject' : 'approve';
      const feedback = values.feedback ?? '';

      if (decision === 'reject') {
        // Persist BEFORE throwing — the throw halts the task and the revise retry
        // resets these step rows, but the task_event survives so 03b can pre-fill
        // the feedback as guidance on the re-mine.
        await recordBizReqDecision(ctx, 'reject', feedback);
        ctx.logger.info('business requirements rejected');
        throw new Error(
          `business requirements rejected: ${feedback || 'no feedback supplied'}. ` +
            'Re-run the business-requirements step to revise — your feedback is pre-filled there.',
        );
      }

      // Clears any outstanding rejection so a later, unrelated re-mine starts clean.
      await recordBizReqDecision(ctx, 'approve', feedback);
      ctx.logger.info('business requirements approved');
      return {
        requirements: detected.requirements,
        summary: detected.summary,
        decision,
        feedback,
      };
    },
  };
