import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

interface SpecGateDetect {
  specSummary: string;
  qualityScore: number | null;
  qualityFindings: string[];
}

interface SpecGateApply {
  decision: 'approve' | 'reject';
  feedback: string;
}

interface PrePlanningOutput {
  summary?: string;
  spec?: string;
}

interface QualityFinding {
  dimension?: string;
  severity?: string;
  comment?: string;
}

interface SpecQualityOutput {
  score?: number;
  findings?: QualityFinding[];
}

function formatFinding(f: QualityFinding): string {
  const dim = f.dimension ?? 'general';
  const sev = f.severity ?? 'info';
  const comment = f.comment ?? '';
  return `[${sev.toUpperCase()}] ${dim}: ${comment}`;
}

export const gate1SpecApprovalStep: StepDefinition<SpecGateDetect, SpecGateApply> = {
  metadata: {
    id: '06-gate-1-spec-approval',
    workflowType: 'workflow',
    index: 6,
    title: 'Gate 1: Spec approval',
    description:
      'Presents the drafted specification and its quality review so the user can approve the spec before implementation starts.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<SpecGateDetect> {
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const planOutput = (plan?.output as PrePlanningOutput | null) ?? {};
    const qualityOutput = (quality?.output as SpecQualityOutput | null) ?? {};
    const specSummary =
      planOutput.summary ??
      planOutput.spec ??
      'No specification was produced. The pre-planning step may have been skipped.';
    return {
      specSummary: specSummary.slice(0, 4000),
      qualityScore: typeof qualityOutput.score === 'number' ? qualityOutput.score : null,
      qualityFindings: Array.isArray(qualityOutput.findings)
        ? qualityOutput.findings.map((f) =>
            typeof f === 'object' && f !== null ? formatFinding(f) : String(f),
          )
        : [],
    };
  },

  form(_ctx, detected): FormSchema {
    const header = [
      '=== Specification ===',
      detected.specSummary,
      '',
      '=== Quality review ===',
      detected.qualityScore !== null
        ? `Score: ${detected.qualityScore}/10`
        : 'No quality score available.',
      detected.qualityFindings.length > 0
        ? detected.qualityFindings.map((f) => `- ${f}`).join('\n')
        : 'No findings recorded.',
    ].join('\n');
    return {
      title: 'Gate 1: Spec approval',
      description: header,
      fields: [
        {
          type: 'radio',
          id: 'decision',
          label: 'Approve the specification?',
          options: [
            { value: 'approve', label: 'Approve — proceed to implementation' },
            { value: 'reject', label: 'Reject — request changes and halt' },
          ],
          default: 'approve',
          required: true,
        },
        {
          type: 'textarea',
          id: 'feedback',
          label: 'Feedback for the implementation phase',
          rows: 4,
        },
      ],
      submitLabel: 'Record decision',
    };
  },

  async apply(ctx, args): Promise<SpecGateApply> {
    const values = args.formValues as { decision?: string; feedback?: string };
    const decision: 'approve' | 'reject' = values.decision === 'reject' ? 'reject' : 'approve';
    ctx.logger.info({ decision }, 'spec gate decision recorded');
    if (decision === 'reject') {
      throw new Error(`spec gate rejected: ${values.feedback ?? 'no feedback supplied'}`);
    }
    return { decision, feedback: values.feedback ?? '' };
  },
};
