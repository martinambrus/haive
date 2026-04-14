import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

interface VerifyGateDetect {
  testResults: string;
  lintResults: string;
  typecheckResults: string;
  allPassed: boolean;
}

interface VerifyGateApply {
  decision: 'approve' | 'reject';
  feedback: string;
}

interface VerifyOutput {
  test?: { passed?: boolean; output?: string };
  lint?: { passed?: boolean; output?: string };
  typecheck?: { passed?: boolean; output?: string };
  passed?: boolean;
}

function fmtResult(label: string, entry?: { passed?: boolean; output?: string }): string {
  if (!entry) return `${label}: not run`;
  const status = entry.passed ? 'PASS' : 'FAIL';
  const output = (entry.output ?? '').toString().slice(0, 800);
  return `${label}: ${status}${output ? `\n${output}` : ''}`;
}

export const gate2VerifyApprovalStep: StepDefinition<VerifyGateDetect, VerifyGateApply> = {
  metadata: {
    id: '09-gate-2-verify-approval',
    workflowType: 'workflow',
    index: 9,
    title: 'Gate 2: Verification approval',
    description:
      'Presents the output of the verify phase (tests, lint, typecheck) so the user can approve the implementation before it is committed.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<VerifyGateDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08-phase-5-verify');
    const output = (prev?.output as VerifyOutput | null) ?? {};
    return {
      testResults: fmtResult('tests', output.test),
      lintResults: fmtResult('lint', output.lint),
      typecheckResults: fmtResult('typecheck', output.typecheck),
      allPassed: output.passed === true,
    };
  },

  form(_ctx, detected): FormSchema {
    const summary = [
      detected.testResults,
      detected.lintResults,
      detected.typecheckResults,
      '',
      detected.allPassed
        ? 'All verification checks passed.'
        : 'One or more verification checks failed.',
    ].join('\n');
    return {
      title: 'Gate 2: Verification approval',
      description: summary,
      fields: [
        {
          type: 'radio',
          id: 'decision',
          label: 'Approve the verification results?',
          options: [
            { value: 'approve', label: 'Approve — proceed to commit gate' },
            { value: 'reject', label: 'Reject — iterate on the implementation' },
          ],
          default: detected.allPassed ? 'approve' : 'reject',
          required: true,
        },
        {
          type: 'textarea',
          id: 'feedback',
          label: 'Feedback for the next iteration (optional)',
          rows: 4,
        },
      ],
      submitLabel: 'Record decision',
    };
  },

  async apply(ctx, args): Promise<VerifyGateApply> {
    const values = args.formValues as { decision?: string; feedback?: string };
    const decision: 'approve' | 'reject' = values.decision === 'reject' ? 'reject' : 'approve';
    ctx.logger.info({ decision }, 'verify gate decision recorded');
    if (decision === 'reject') {
      throw new Error(`verify gate rejected: ${values.feedback ?? 'no feedback supplied'}`);
    }
    return { decision, feedback: values.feedback ?? '' };
  },
};
