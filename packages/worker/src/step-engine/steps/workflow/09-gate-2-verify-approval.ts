import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

interface VerifyGateDetect {
  testResults: string;
  lintResults: string;
  typecheckResults: string;
  allPassed: boolean;
  /** Phase 4 pre-test validation result (null when the step didn't run). */
  validation: {
    verdict: string;
    summary: string;
    openIssues: string[];
    failedDimensions: string[];
    fixesApplied: number;
    exhaustedBudget: boolean;
    report: string;
  } | null;
  /** Phase 5b test management summary line (null when the step didn't run). */
  testManagement: { line: string; testsPassed: boolean | null } | null;
}

interface Phase5bOutput {
  action?: string;
  testsCreated?: string[];
  testsUpdated?: string[];
  testsDeleted?: string[];
  testRun?: { ran?: boolean; passed?: boolean } | null;
  testsPassed?: boolean | null;
}

interface Phase4Output {
  verdict?: string;
  summary?: string;
  issues?: { severity?: string; file?: string; description?: string; fix?: string }[];
  dimensions?: { name?: string; status?: string; note?: string }[];
  fixesApplied?: string[];
  report?: string;
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

    // Phase 4 pre-test validation: surface the verdict (the legacy "escalate to
    // user" lands here — exhausted budget / open issues / unparseable output).
    const phase4 = await loadPreviousStepOutput(ctx.db, ctx.taskId, '07b-phase-4-validate');
    const p4 = phase4?.output as Phase4Output | null;
    let validation: VerifyGateDetect['validation'] = null;
    if (p4?.verdict) {
      const iterations = (phase4?.iterations ?? []) as { exhaustedBudget?: boolean }[];
      validation = {
        verdict: p4.verdict,
        summary: p4.summary ?? '',
        openIssues: (p4.issues ?? []).map((i) =>
          `[${i.severity ?? 'unspecified'}] ${i.file ?? ''} ${i.description ?? ''}`.trim(),
        ),
        failedDimensions: (p4.dimensions ?? [])
          .filter((d) => d.status === 'FAIL')
          .map((d) => `${d.name}${d.note ? `: ${d.note}` : ''}`),
        fixesApplied: (p4.fixesApplied ?? []).length,
        exhaustedBudget: iterations.some((e) => e.exhaustedBudget === true),
        report: (p4.report ?? '').slice(0, 8000),
      };
    }

    // Phase 5b test management: one summary line + escalation on failed runs.
    const phase5b = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08b-test-management');
    const p5 = phase5b?.output as Phase5bOutput | null;
    let testManagement: VerifyGateDetect['testManagement'] = null;
    if (p5?.action) {
      const counts = `created ${(p5.testsCreated ?? []).length}, updated ${(p5.testsUpdated ?? []).length}, deleted ${(p5.testsDeleted ?? []).length}`;
      const runState =
        p5.testsPassed === true
          ? 'related tests PASS'
          : p5.testsPassed === false
            ? 'related tests FAIL'
            : 'tests not run';
      testManagement = {
        line: `Test management (${p5.action}): ${counts}; ${runState}`,
        testsPassed: p5.testsPassed ?? null,
      };
    }

    return {
      testResults: fmtResult('tests', output.test),
      lintResults: fmtResult('lint', output.lint),
      typecheckResults: fmtResult('typecheck', output.typecheck),
      allPassed: output.passed === true,
      validation,
      testManagement,
    };
  },

  form(_ctx, detected): FormSchema {
    const v = detected.validation;
    const validationOk = v === null || v.verdict === 'VALID';
    const testsOk =
      detected.testManagement === null || detected.testManagement.testsPassed !== false;
    const summary = [
      detected.testResults,
      detected.lintResults,
      detected.typecheckResults,
      '',
      detected.allPassed
        ? 'All verification checks passed.'
        : 'One or more verification checks failed.',
      v
        ? `Pre-test validation: ${v.verdict}${v.exhaustedBudget ? ' (fix budget exhausted)' : ''}`
        : '',
      detected.testManagement ? detected.testManagement.line : '',
    ]
      .filter(Boolean)
      .join('\n');

    const infoSections: InfoSection[] = [];
    if (v) {
      const lines: string[] = [`**Verdict:** ${v.verdict}`];
      if (v.summary) lines.push('', v.summary);
      if (v.fixesApplied > 0)
        lines.push('', `**Fixes applied by the fix loop:** ${v.fixesApplied}`);
      if (v.exhaustedBudget) {
        lines.push(
          '',
          '> ⚠️ **Fix budget exhausted** — the validator still reported issues on its final pass.',
          '> Review the open issues below before approving.',
        );
      }
      if (v.verdict === 'UNPARSEABLE') {
        lines.push(
          '',
          "> ⚠️ The validator's output could not be parsed — review the report excerpt below.",
        );
      }
      if (v.failedDimensions.length > 0) {
        lines.push('', '## Failed review dimensions');
        for (const d of v.failedDimensions) lines.push(`- ${d}`);
      }
      if (v.openIssues.length > 0) {
        lines.push('', '## Open issues');
        for (const i of v.openIssues) lines.push(`- ${i}`);
      }
      if (v.report) {
        lines.push('', '## Validator report (excerpt)', '', v.report);
      }
      infoSections.push({
        title: 'Pre-test validation',
        preview: v.verdict + (v.exhaustedBudget ? ' • budget exhausted' : ''),
        body: lines.join('\n'),
        defaultOpen: !validationOk,
      });
    }

    return {
      title: 'Gate 2: Verification approval',
      description: summary,
      ...(infoSections.length > 0 ? { infoSections } : {}),
      fields: [
        {
          type: 'radio',
          id: 'decision',
          label: 'Approve the verification results?',
          options: [
            { value: 'approve', label: 'Approve — proceed to commit gate' },
            { value: 'reject', label: 'Reject — iterate on the implementation' },
          ],
          default: detected.allPassed && validationOk && testsOk ? 'approve' : 'reject',
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
