import path from 'node:path';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { resolveDdevWorkspace, loadAppBootOutput } from './_task-meta.js';
import {
  ensureDdevStarted,
  startBrowserDesktop,
  runnerExec,
  ddevPrimaryUrl,
} from '../../../sandbox/ddev-runner.js';
import {
  ensureAppRunnerStarted,
  appRunnerExec,
  startBrowserDesktop as startAppBrowserDesktop,
} from '../../../sandbox/app-runner.js';

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
    /** False when 07b's churn guard stopped the loop on a non-converging file. */
    converged: boolean;
    /** Files the validator/fixer kept re-flagging without resolving (empty when converged). */
    churnFiles: string[];
    report: string;
  } | null;
  /** Phase 5b test management summary line (null when the step didn't run). */
  testManagement: { line: string; testsPassed: boolean | null } | null;
  /** Phase 5a browser testing result (null when the step didn't run). */
  browser: {
    method: string;
    passed: boolean;
    failures: string[];
    visualVerdict: string | null;
    checklistMarkdown: string | null;
    skipped: boolean;
  } | null;
  /** Phase 6 code review result (null when the step didn't run / no reviews). */
  codeReview: {
    peerVerdict: string;
    securityVerdict: string;
    blocking: boolean;
    peerFindings: string[];
    securityFindings: string[];
    /** Findings from the level-gated extra review lenses (operational/performance). */
    lensFindings: string[];
    positives: string[];
  } | null;
  /** Phase 6b broad code audit (08c2) result — advisory; null when it didn't run. */
  codeAudit: { findings: string[] } | null;
  /** Phase 7 adversarial QA result (null when the step didn't run). */
  adversarial: {
    level: string;
    blocking: boolean;
    counts: { critical: number; high: number; total: number };
    findings: string[];
  } | null;
  /** In-page live browser for this gate: the per-task DDEV headed-browser
   *  desktop, brought up (idempotent) and pointed at the app URL so the user can
   *  test right here while the user-active timer keeps running. null when this
   *  isn't a DDEV + browser-testing task; available:false if bring-up failed. */
  liveBrowser: { available: boolean; appUrl: string | null; reason?: string } | null;
  /** Mandatory runtime HTTP smoke from 08-phase-5-verify (null when not probed).
   *  A failure defaults this gate to reject but never auto-reroutes to implement. */
  runtimeSmoke: {
    ran: boolean;
    passed: boolean;
    httpStatus: number | null;
    url: string | null;
    errorExcerpt: string;
  } | null;
}

interface Phase8dOutput {
  ran?: boolean;
  level?: string;
  blocking?: boolean;
  counts?: { critical?: number; high?: number; total?: number };
  findings?: {
    severity?: string;
    category?: string;
    location?: string;
    impact?: string;
    fix?: string;
  }[];
}

interface Phase8cOutput {
  reviewed?: boolean;
  blocking?: boolean;
  peer?: {
    verdict?: string;
    findings?: { severity?: string; path?: string; lines?: string; issue?: string; fix?: string }[];
    positives?: string[];
  };
  security?: {
    verdict?: string;
    findings?: {
      severity?: string;
      path?: string;
      line?: string | number;
      issue?: string;
      attack?: string;
      fix?: string;
    }[];
  };
  extraLenses?: {
    id?: string;
    title?: string;
    verdict?: string;
    findings?: { severity?: string; path?: string; lines?: string; issue?: string; fix?: string }[];
  }[];
}

interface Phase5aOutput {
  ran?: boolean;
  skipped?: boolean;
  method?: string;
  passed?: boolean;
  appUrl?: string | null;
  failures?: { description?: string; evidence?: string }[];
  visualVerdict?: string | null;
  checklistMarkdown?: string | null;
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
  converged?: boolean;
  churnFiles?: string[];
}

interface VerifyGateApply {
  decision: 'approve' | 'reject';
  feedback: string;
  /** Broad code-audit findings (08c2) carried into the restart diagnosis so the
   *  implementer validates each and acts on the valid, in-scope ones. */
  auditFindings: string[];
}

interface VerifyOutput {
  test?: { passed?: boolean; output?: string };
  lint?: { passed?: boolean; output?: string };
  typecheck?: { passed?: boolean; output?: string };
  passed?: boolean;
  runtimeSmoke?: {
    ran?: boolean;
    passed?: boolean;
    httpStatus?: number | null;
    url?: string | null;
    errorExcerpt?: string;
  } | null;
}

function fmtResult(label: string, entry?: { passed?: boolean; output?: string }): string {
  if (!entry) return `${label}: not run`;
  const status = entry.passed ? 'PASS' : 'FAIL';
  const output = (entry.output ?? '').toString().slice(0, 800);
  return `${label}: ${status}${output ? `\n${output}` : ''}`;
}

/** The diagnosis handed to the implementer when the developer rejects at Gate 2: their
 *  hands-on findings become the round-N fix request (see restartLoop / FIX_LOOP_REQUESTED). */
function formatRejectDiagnosis(feedback: string, auditFindings: string[] = []): string {
  const f = feedback.trim();
  const parts = [
    'Developer verification at Gate 2 rejected the implementation after hands-on testing.',
    '',
    'Findings to fix:',
    f.length > 0
      ? f
      : '(no specific findings provided — re-check the implementation against the spec and the reported errors)',
  ];
  if (auditFindings.length > 0) {
    parts.push(
      '',
      'Broad code-audit findings — validate EACH against the code and act ONLY on the valid,',
      'in-scope ones (ignore any that are wrong, already handled, or out of scope):',
      ...auditFindings.map((x) => `- ${x}`),
    );
  }
  return parts.join('\n');
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

  // Restart-loop: a developer reject at this gate (after hands-on browser/manual
  // verification) restarts from implementation with their findings attached — UNCAPPED
  // and human-driven, distinct from the automated fix loop on the verify/review/QA steps.
  // Approve returns normally and the forward walk continues to the commit gate.
  restartLoop: {
    evaluate: (out) =>
      out.decision === 'reject'
        ? { diagnosis: formatRejectDiagnosis(out.feedback, out.auditFindings) }
        : null,
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
        converged: p4.converged !== false,
        churnFiles: p4.churnFiles ?? [],
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

    // Phase 5a browser testing: surface the verdict (mcp fail / manual checklist
    // to confirm); skipped/headless probe contributes nothing blocking.
    const phase5a = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08a-browser-verify');
    const pa = phase5a?.output as Phase5aOutput | null;
    let browser: VerifyGateDetect['browser'] = null;
    if (pa?.ran && pa.method && pa.method !== 'skip') {
      browser = {
        method: pa.method,
        passed: pa.passed !== false,
        failures: (pa.failures ?? []).map((f) =>
          `${f.description ?? ''}${f.evidence ? ` (${f.evidence})` : ''}`.trim(),
        ),
        visualVerdict: pa.visualVerdict ?? null,
        checklistMarkdown: pa.checklistMarkdown ?? null,
        skipped: pa.skipped === true,
      };
    }

    // Phase 6 code review: peer + security verdicts, blocking on
    // REQUEST_CHANGES / VULNERABLE / critical-high security findings.
    const phase8c = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08c-code-review');
    const pc = phase8c?.output as Phase8cOutput | null;
    let codeReview: VerifyGateDetect['codeReview'] = null;
    if (pc?.reviewed) {
      codeReview = {
        peerVerdict: pc.peer?.verdict ?? 'DISCUSS',
        securityVerdict: pc.security?.verdict ?? 'NEEDS_FIXES',
        blocking: pc.blocking === true,
        peerFindings: (pc.peer?.findings ?? []).map((f) =>
          `[${f.severity ?? '?'}] ${f.path ?? ''}${f.lines ? `:${f.lines}` : ''} ${f.issue ?? ''}${f.fix ? ` → ${f.fix}` : ''}`.trim(),
        ),
        securityFindings: (pc.security?.findings ?? []).map((f) =>
          `[${f.severity ?? '?'}] ${f.path ?? ''}${f.line ? `:${f.line}` : ''} ${f.issue ?? ''}${f.attack ? ` (attack: ${f.attack})` : ''}${f.fix ? ` → ${f.fix}` : ''}`.trim(),
        ),
        lensFindings: (pc.extraLenses ?? []).flatMap((lens) =>
          (lens.findings ?? []).map((f) =>
            `[${lens.title ?? lens.id ?? 'lens'}] [${f.severity ?? '?'}] ${f.path ?? ''}${f.lines ? `:${f.lines}` : ''} ${f.issue ?? ''}${f.fix ? ` → ${f.fix}` : ''}`.trim(),
          ),
        ),
        positives: pc.peer?.positives ?? [],
      };
    }

    // Phase 6b broad code audit (08c2): advisory findings surfaced for the human.
    const phase8c2 = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08c2-code-audit');
    const pc2 = phase8c2?.output as {
      audited?: boolean;
      findings?: {
        severity?: string;
        path?: string;
        lines?: string;
        issue?: string;
        fix?: string;
      }[];
    } | null;
    let codeAudit: VerifyGateDetect['codeAudit'] = null;
    if (pc2?.audited) {
      codeAudit = {
        findings: (pc2.findings ?? []).map((f) =>
          `[${f.severity ?? '?'}] ${f.path ?? ''}${f.lines ? `:${f.lines}` : ''} ${f.issue ?? ''}${f.fix ? ` → ${f.fix}` : ''}`.trim(),
        ),
      };
    }

    // Phase 7 adversarial QA: surface findings; blocking on any critical/high.
    const phase8d = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08d-adversarial-qa');
    const pd = phase8d?.output as Phase8dOutput | null;
    let adversarial: VerifyGateDetect['adversarial'] = null;
    if (pd?.ran) {
      adversarial = {
        level: pd.level ?? 'poc',
        blocking: pd.blocking === true,
        counts: {
          critical: pd.counts?.critical ?? 0,
          high: pd.counts?.high ?? 0,
          total: pd.counts?.total ?? 0,
        },
        findings: (pd.findings ?? []).map((f) =>
          `[${f.severity ?? '?'}] ${f.category ?? ''} ${f.location ?? ''} ${f.impact ?? ''}${f.fix ? ` → ${f.fix}` : ''}`.trim(),
        ),
      };
    }

    // Live in-page browser for this gate: bring up the per-task headed-browser
    // desktop (idempotent) and point it at the app URL so the user tests here,
    // keeping the user-active timer running. Works for both runtimes — the DDEV
    // runner and the non-DDEV app-runner. Best-effort: any failure leaves the
    // gate fully functional, just without the browser panel.
    let liveBrowser: VerifyGateDetect['liveBrowser'] = null;
    try {
      const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
      const deps = (envTemplate?.declaredDeps as Record<string, unknown>) ?? {};
      const browserTesting = envTemplate?.status === 'ready' && !!deps.browserTesting;
      if (browserTesting) {
        // Select the runtime the same way 08a does — by `.ddev` presence, not
        // the template's containerTool — so an add-DDEV task (template non-DDEV
        // but the implementation added `.ddev`) brings up the DDEV runner here
        // too, matching where 08a started the desktop.
        const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
        const isDdev = !!ws && (await pathExists(path.join(ws.workspace, '.ddev', 'config.yaml')));
        if (isDdev && ws) {
          const handle = await ensureDdevStarted(ctx.taskId, ws.repoSubpath);
          await startBrowserDesktop(handle);
          const appUrl = pa?.appUrl || (await ddevPrimaryUrl(handle)) || 'http://localhost';
          liveBrowser = { available: true, appUrl };
          const nav = await runnerExec(handle, `node /opt/browser-probe-connect.js '${appUrl}'`, {
            timeoutMs: 30_000,
          });
          if (nav.exitCode !== 0)
            ctx.logger.warn({ appUrl }, 'gate-2 browser navigate returned non-zero');
        } else if (ws) {
          // Non-DDEV: the app + desktop run in the per-task app-runner container.
          const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
          if (boot?.containerized && boot.runtimeContainer && envTemplate?.imageTag) {
            const handle = await ensureAppRunnerStarted(
              ctx.taskId,
              ws.repoSubpath,
              envTemplate.imageTag,
            );
            await startAppBrowserDesktop(handle);
            const appUrl = boot.appUrl || `http://localhost:${boot.port ?? 3000}`;
            liveBrowser = { available: true, appUrl };
            const nav = await appRunnerExec(
              handle,
              `node /opt/browser/browser-probe-connect.js '${appUrl}'`,
              { timeoutMs: 30_000 },
            );
            if (nav.exitCode !== 0)
              ctx.logger.warn({ appUrl }, 'gate-2 browser navigate returned non-zero');
          }
        }
      }
    } catch (err) {
      ctx.logger.warn({ err }, 'gate-2 live browser bring-up failed');
      liveBrowser = { available: false, appUrl: null, reason: (err as Error).message };
    }

    const rsOut = output.runtimeSmoke ?? null;
    const runtimeSmoke = rsOut
      ? {
          ran: rsOut.ran === true,
          passed: rsOut.passed === true,
          httpStatus: rsOut.httpStatus ?? null,
          url: rsOut.url ?? null,
          errorExcerpt: rsOut.errorExcerpt ?? '',
        }
      : null;

    return {
      testResults: fmtResult('tests', output.test),
      lintResults: fmtResult('lint', output.lint),
      typecheckResults: fmtResult('typecheck', output.typecheck),
      allPassed: output.passed === true,
      validation,
      testManagement,
      browser,
      codeReview,
      codeAudit,
      adversarial,
      liveBrowser,
      runtimeSmoke,
    };
  },

  form(_ctx, detected): FormSchema {
    const v = detected.validation;
    const validationOk = v === null || v.verdict === 'VALID';
    const testsOk =
      detected.testManagement === null || detected.testManagement.testsPassed !== false;
    const b = detected.browser;
    const browserOk = b === null || b.passed;
    const browserLine = b
      ? `Browser testing (${b.method}): ${b.method === 'manual' ? 'checklist generated — verify below' : b.passed ? 'PASS' : 'FAIL'}${b.visualVerdict && b.visualVerdict !== 'SKIPPED' ? ` • visual ${b.visualVerdict}` : ''}`
      : '';
    const cr = detected.codeReview;
    const codeReviewOk = cr === null || !cr.blocking;
    const codeReviewLine = cr
      ? `Code review: peer ${cr.peerVerdict}, security ${cr.securityVerdict}${cr.lensFindings.length ? `, +${cr.lensFindings.length} operational/perf` : ''}${cr.blocking ? ' — BLOCKING' : ''}`
      : '';
    const cAudit = detected.codeAudit;
    const codeAuditLine =
      cAudit && cAudit.findings.length > 0
        ? `Code audit (broad): ${cAudit.findings.length} finding(s) — advisory`
        : '';
    const aq = detected.adversarial;
    const adversarialOk = aq === null || !aq.blocking;
    const adversarialLine = aq
      ? `Adversarial QA (${aq.level}): ${aq.counts.total} findings (${aq.counts.critical} critical, ${aq.counts.high} high)${aq.blocking ? ' — BLOCKING' : ''}`
      : '';
    const rs = detected.runtimeSmoke;
    const runtimeSmokeOk = !rs || !rs.ran || rs.passed;
    const runtimeSmokeLine =
      rs && rs.ran && !rs.passed
        ? `Runtime smoke: FAIL${rs.httpStatus !== null ? ` (HTTP ${rs.httpStatus})` : ''} — the app did not come up cleanly`
        : '';
    const summary = [
      detected.testResults,
      detected.lintResults,
      detected.typecheckResults,
      '',
      detected.allPassed
        ? 'All verification checks passed.'
        : 'One or more verification checks failed.',
      v
        ? `Implementation validation: ${v.verdict}${v.exhaustedBudget ? ' (fix budget exhausted)' : ''}`
        : '',
      browserLine,
      codeReviewLine,
      codeAuditLine,
      adversarialLine,
      runtimeSmokeLine,
      detected.testManagement ? detected.testManagement.line : '',
    ]
      .filter(Boolean)
      .join('\n');

    const infoSections: InfoSection[] = [];
    if (rs && rs.ran && !rs.passed) {
      infoSections.push({
        title: 'Runtime smoke failed',
        preview: rs.httpStatus !== null ? `HTTP ${rs.httpStatus}` : 'no response',
        body: [
          `The app was booted and probed at ${rs.url ?? 'its runtime URL'} but did not come up cleanly.`,
          rs.httpStatus !== null
            ? `HTTP status: ${rs.httpStatus}`
            : 'No HTTP response was received from the app.',
          '',
          '## Response excerpt',
          '```',
          rs.errorExcerpt || '(empty)',
          '```',
        ].join('\n'),
        defaultOpen: true,
      });
    }
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
      if (v.churnFiles.length > 0) {
        lines.push(
          '',
          `> ⚠️ **Validation did not converge** — the validator/fixer kept re-flagging ${v.churnFiles.join(', ')} across rounds without resolving it, so the loop stopped instead of burning more rounds. A human decision is needed.`,
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
        title: 'Implementation validation',
        preview:
          v.verdict +
          (v.exhaustedBudget ? ' • budget exhausted' : '') +
          (v.churnFiles.length > 0 ? ' • did not converge' : ''),
        body: lines.join('\n'),
        defaultOpen: !validationOk,
      });
    }

    if (b) {
      const lines: string[] = [`**Method:** ${b.method}`];
      if (b.method === 'manual' && b.checklistMarkdown) {
        lines.push(
          '',
          '> Verify the checklist below by hand. Approve = all passed; Reject = issues found.',
          '',
          b.checklistMarkdown.slice(0, 12_000),
        );
      } else {
        lines.push('', `**Result:** ${b.passed ? 'PASS' : 'FAIL'}`);
        if (b.visualVerdict) lines.push(`**Visual verdict:** ${b.visualVerdict}`);
        if (b.failures.length > 0) {
          lines.push('', '## Failures');
          for (const f of b.failures) lines.push(`- ${f}`);
        }
      }
      infoSections.push({
        title: 'Browser testing',
        preview: b.method === 'manual' ? 'manual checklist' : b.passed ? 'PASS' : 'FAIL',
        body: lines.join('\n'),
        defaultOpen: !browserOk || b.method === 'manual',
      });
    }

    if (cr) {
      const lines: string[] = [
        `**Peer review:** ${cr.peerVerdict}`,
        `**Security review:** ${cr.securityVerdict}`,
      ];
      if (cr.securityFindings.length > 0) {
        lines.push('', '## Security findings');
        for (const f of cr.securityFindings) lines.push(`- ${f}`);
      }
      if (cr.peerFindings.length > 0) {
        lines.push('', '## Peer findings');
        for (const f of cr.peerFindings) lines.push(`- ${f}`);
      }
      if (cr.lensFindings.length > 0) {
        lines.push('', '## Operational / performance review');
        for (const f of cr.lensFindings) lines.push(`- ${f}`);
      }
      if (cr.positives.length > 0) {
        lines.push('', '## Positives');
        for (const p of cr.positives) lines.push(`- ${p}`);
      }
      infoSections.push({
        title: 'Code review',
        preview: `peer ${cr.peerVerdict} • security ${cr.securityVerdict}${cr.lensFindings.length ? ` • +${cr.lensFindings.length} ops/perf` : ''}${cr.blocking ? ' • BLOCKING' : ''}`,
        body: lines.join('\n'),
        defaultOpen: cr.blocking,
      });
    }

    if (cAudit && cAudit.findings.length > 0) {
      const lines: string[] = ['## Findings'];
      for (const f of cAudit.findings) lines.push(`- ${f}`);
      infoSections.push({
        title: 'Code audit (broad)',
        preview: `${cAudit.findings.length} finding(s) • advisory`,
        body: lines.join('\n'),
        defaultOpen: false,
      });
    }

    if (aq) {
      const lines: string[] = [
        `**Level:** ${aq.level}`,
        `**Findings:** ${aq.counts.total} (${aq.counts.critical} critical, ${aq.counts.high} high)`,
      ];
      if (aq.findings.length > 0) {
        lines.push('', '## Findings');
        for (const f of aq.findings) lines.push(`- ${f}`);
      }
      infoSections.push({
        title: 'Adversarial QA',
        preview: `${aq.counts.total} findings${aq.blocking ? ' • BLOCKING' : ''}`,
        body: lines.join('\n'),
        defaultOpen: aq.blocking,
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
          default:
            detected.allPassed &&
            validationOk &&
            testsOk &&
            browserOk &&
            codeReviewOk &&
            adversarialOk &&
            runtimeSmokeOk
              ? 'approve'
              : 'reject',
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
    // Reject does NOT fail the task: the restartLoop hook above turns a reject into an
    // uncapped restart from implementation, handing the developer's findings to the
    // implementer. Approve finalizes and the forward walk proceeds to the commit gate.
    return {
      decision,
      feedback: values.feedback ?? '',
      auditFindings: args.detected.codeAudit?.findings ?? [],
    };
  },
};
