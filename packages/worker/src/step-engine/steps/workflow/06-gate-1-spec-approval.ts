import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { resolveDdevWorkspace } from './_task-meta.js';

interface SpecGateDetect {
  /** Full spec body (markdown). The renderer turns this into HTML inside
   *  the expandable "Full specification" section. */
  specBody: string;
  /** Short executive view derived from the spec — the first ~6 lines of
   *  meaningful prose. Falls back to a leading slice when no headings/
   *  paragraphs are present. */
  specSummary: string;
  qualityScore: number | null;
  qualityVerdict: string | null;
  qualityFindings: string[];
  iterationHistory: string[];
  exhaustedBudget: boolean;
  /** Whether the workspace has a .ddev config — gates the mcp/interactive
   *  browser-verification options (same probe 08a uses at its own detect). */
  ddevMode: boolean;
  /** Current task-level run-config columns, used as form defaults so an
   *  API-set value survives into the gate-1 picker. */
  taskSimplifyCode: boolean;
  taskAdversarialQaLevel: string | null;
}

/** Gate-1 "run configuration": the front-loaded answers for the hands-free
 *  stretch to gate 2 (browser/MCP mode, test action, verify slots, sprint
 *  mode). Recorded in the step output and written to tasks.pre_answers. */
interface SpecGateRunConfig {
  adversarialQaLevel: string;
  simplifyCode: boolean;
  sprintDecision: string;
  sprintAutoResolveConflicts: boolean;
  sprintReviewEnabled: boolean;
  verifyRunTest: boolean;
  verifyRunLint: boolean;
  verifyRunTypecheck: boolean;
  browserMode: string;
  browserCheckConsoleErrors: boolean;
  browserCheckNetworkErrors: boolean;
  testAction: string;
  testRunTests: boolean;
}

interface SpecGateApply {
  decision: 'approve' | 'reject';
  feedback: string;
  runConfig: SpecGateRunConfig | null;
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
  verdict?: string;
  score?: number;
  findings?: QualityFinding[];
  spec?: string;
}

interface IterationEntry {
  iteration?: number;
  applyOutput?: SpecQualityOutput;
  exhaustedBudget?: boolean;
}

function formatFinding(f: QualityFinding): string {
  const dim = f.dimension ?? 'general';
  const sev = f.severity ?? 'info';
  const comment = f.comment ?? '';
  return `[${sev.toUpperCase()}] ${dim}: ${comment}`;
}

function summariseIteration(entry: IterationEntry): string {
  const idx = (entry.iteration ?? 0) + 1;
  const out = entry.applyOutput;
  const verdict = typeof out?.verdict === 'string' ? out.verdict : '?';
  const score = typeof out?.score === 'number' ? `${out.score}/10` : '?/10';
  const fc = Array.isArray(out?.findings) ? out!.findings!.length : 0;
  const errs = Array.isArray(out?.findings)
    ? out!.findings!.filter((f) => f.severity === 'error').length
    : 0;
  const warns = Array.isArray(out?.findings)
    ? out!.findings!.filter((f) => f.severity === 'warn').length
    : 0;
  return `Iteration ${idx}: ${verdict}, score ${score}, ${fc} finding(s) (${errs} error / ${warns} warn)`;
}

/** Pick the first chunk of meaningful prose from a markdown spec body so
 *  the summary disclosure shows what the spec is about without forcing
 *  the user to expand the full doc. Walks lines, skipping leading blanks
 *  and code fences, and stops at the next blank line after we've collected
 *  6 non-empty lines (or hit a 1500-char budget). When the body has no
 *  obvious paragraphs, falls back to a head-of-file slice. */
export function buildSpecSummary(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  const lines = trimmed.split('\n');
  const out: string[] = [];
  let inFence = false;
  let kept = 0;
  let chars = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      // Skip fence boundaries themselves so the summary stays readable.
      continue;
    }
    if (inFence) continue;
    if (line.trim() === '') {
      if (kept >= 6) break;
      out.push('');
      continue;
    }
    out.push(line);
    kept += 1;
    chars += line.length;
    if (kept >= 12 || chars >= 1500) break;
  }
  const result = out.join('\n').trim();
  // Body had only fenced code or whitespace — fall back to a head slice.
  return result.length > 0 ? result : trimmed.slice(0, 1500);
}

/** Compose the markdown body for the "Specification summary" disclosure.
 *  Bundles the spec preview with the quality review snapshot and any
 *  iteration / budget warnings so the user has everything they need to
 *  decide without expanding the full spec. */
function buildSummarySection(detected: SpecGateDetect): string {
  const lines: string[] = [];
  if (detected.specSummary) {
    lines.push(detected.specSummary);
    lines.push('');
  } else {
    lines.push('_No specification was produced. The pre-planning step may have been skipped._');
    lines.push('');
  }
  lines.push('## Quality review');
  if (detected.qualityVerdict) {
    lines.push(`**Verdict:** ${detected.qualityVerdict}`);
  }
  lines.push(
    detected.qualityScore !== null
      ? `**Score:** ${detected.qualityScore}/10 _(final pass)_`
      : '_No quality score available._',
  );
  if (detected.qualityFindings.length > 0) {
    lines.push('');
    for (const f of detected.qualityFindings) lines.push(`- ${f}`);
  } else {
    lines.push('');
    lines.push('_No findings recorded._');
  }
  if (detected.iterationHistory.length > 0) {
    lines.push('');
    lines.push('## Iteration history');
    for (const h of detected.iterationHistory) lines.push(`- ${h}`);
  }
  if (detected.qualityVerdict === 'BLOCKING_AMBIGUITY') {
    lines.push('');
    lines.push(
      "> ⚠️ **Blocking ambiguity** — the spec quality reviewer could not resolve the spec's " +
        'intent (see findings above). Clarify the flagged questions and reject to re-run, ' +
        'rather than approving an ambiguous spec.',
    );
  }
  if (detected.exhaustedBudget) {
    lines.push('');
    lines.push(
      '> ⚠️ **Loop budget exhausted** — the spec quality reviewer still flagged ' +
        'warn/error issues on the final pass. You can approve as-is, or reject ' +
        'and re-run with a higher iteration budget.',
    );
  }
  return lines.join('\n');
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
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const planOutput = (plan?.output as PrePlanningOutput | null) ?? {};
    const qualityOutput = (quality?.output as SpecQualityOutput | null) ?? {};
    const resolvedOutput = (resolved?.output as { spec?: string } | null) ?? {};
    // Prefer the post-checkpoint spec (05a: user/agent warning fixes), then the
    // 05 amended body, then the original 04 spec/summary.
    const specBody =
      resolvedOutput.spec ?? qualityOutput.spec ?? planOutput.spec ?? planOutput.summary ?? '';
    const iterations = (quality?.iterations ?? []) as IterationEntry[];
    const exhaustedBudget = iterations.some((entry) => entry.exhaustedBudget === true);

    // ddev probe mirrors 08a's detect (01c's own output is unreliable when its
    // shouldRun skipped the step). Determines whether the mcp/interactive
    // browser options are offered in the run-config section.
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const ddevMode =
      ws !== null && (await pathExists(path.join(ws.workspace, '.ddev', 'config.yaml')));
    const taskRow = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { simplifyCode: true, adversarialQaLevel: true },
    });

    return {
      specBody,
      specSummary: buildSpecSummary(specBody),
      ddevMode,
      taskSimplifyCode: taskRow?.simplifyCode ?? false,
      taskAdversarialQaLevel: taskRow?.adversarialQaLevel ?? null,
      qualityScore: typeof qualityOutput.score === 'number' ? qualityOutput.score : null,
      qualityVerdict: typeof qualityOutput.verdict === 'string' ? qualityOutput.verdict : null,
      qualityFindings: Array.isArray(qualityOutput.findings)
        ? qualityOutput.findings.map((f) =>
            typeof f === 'object' && f !== null ? formatFinding(f) : String(f),
          )
        : [],
      iterationHistory: iterations.map(summariseIteration),
      exhaustedBudget,
    };
  },

  form(_ctx, detected): FormSchema {
    const summaryBody = buildSummarySection(detected);
    const fullSpecBody =
      detected.specBody.trim().length > 0
        ? detected.specBody
        : '_No specification was produced. The pre-planning step may have been skipped._';
    const summaryPreview =
      detected.qualityScore !== null
        ? `quality ${detected.qualityScore}/10` +
          (detected.exhaustedBudget ? ' • budget exhausted' : '')
        : detected.qualityFindings.length > 0
          ? `${detected.qualityFindings.length} finding(s)`
          : undefined;
    const fullPreview =
      detected.specBody.trim().length > 0
        ? `${detected.specBody.length.toLocaleString()} chars`
        : 'empty';
    const infoSections: InfoSection[] = [
      {
        title: 'Specification summary',
        ...(summaryPreview ? { preview: summaryPreview } : {}),
        body: summaryBody,
        defaultOpen: true,
      },
      {
        title: 'Full specification',
        preview: fullPreview,
        body: fullSpecBody,
      },
    ];
    return {
      title: 'Gate 1: Spec approval',
      description:
        'Review the spec drafted in phase 0b and approve it before implementation begins. Reject to halt the workflow with feedback.',
      infoSections,
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
        {
          type: 'note',
          id: 'runConfigNote',
          label: 'Run configuration',
          variant: 'warning',
          body:
            'Fill in the Run configuration below before continuing — these answers for the ' +
            'implementation and verification steps let them run hands-free in auto-continue mode ' +
            '(and arrive pre-filled otherwise). Applied from approval until Gate 2 (developer ' +
            'verification).',
        },
        {
          type: 'accordion',
          id: 'runConfig',
          label: 'Run configuration — used until Gate 2',
          items: [
            {
              title: 'Run configuration',
              fields: [
                {
                  type: 'select',
                  id: 'adversarialQaLevel',
                  label: 'Adversarial QA (Phase 7)',
                  description: '2/4/6 adversarial agents attack the implementation before Gate 2.',
                  options: [
                    { value: 'none', label: 'Skip adversarial QA' },
                    { value: 'poc', label: 'POC — 2 agents (quick)' },
                    { value: 'standard', label: 'Standard — 4 agents' },
                    { value: 'enterprise', label: 'Enterprise — 6 agents' },
                  ],
                  default: detected.taskAdversarialQaLevel ?? 'none',
                },
                {
                  type: 'checkbox',
                  id: 'simplifyCode',
                  label: 'AI code simplification pass after implementation (Phase 3.5)',
                  default: true,
                },
                {
                  type: 'radio',
                  id: 'sprintDecision',
                  label: 'Implementation mode',
                  options: [
                    {
                      value: 'proceed',
                      label: 'Follow the sprint plan (parallel DAG when planned)',
                    },
                    {
                      value: 'use_single_agent',
                      label: 'Always use a single implementation agent',
                    },
                  ],
                  default: 'proceed',
                },
                {
                  type: 'checkbox',
                  id: 'sprintAutoResolveConflicts',
                  label: 'Auto-resolve merge conflicts with AI (DAG mode)',
                  default: false,
                },
                {
                  type: 'checkbox',
                  id: 'sprintReviewEnabled',
                  label: 'AI-review each issue before merge (DAG mode)',
                  default: true,
                },
                {
                  type: 'checkbox',
                  id: 'verifyRunTest',
                  label: 'Verify: run tests',
                  default: true,
                },
                {
                  type: 'checkbox',
                  id: 'verifyRunLint',
                  label: 'Verify: run lint',
                  default: true,
                },
                {
                  type: 'checkbox',
                  id: 'verifyRunTypecheck',
                  label: 'Verify: run typecheck',
                  default: true,
                },
                {
                  type: 'radio',
                  id: 'browserMode',
                  label: 'Browser verification',
                  options: [
                    { value: 'headless', label: 'Headless probe — automated page-load check only' },
                    ...(detected.ddevMode
                      ? [
                          {
                            value: 'mcp',
                            label:
                              'Automated agent testing — the integration-tester drives the visible browser via Chrome DevTools (MCP)',
                          },
                          {
                            value: 'interactive',
                            label: 'Interactive probe — headed Chrome on the DDEV desktop',
                          },
                        ]
                      : []),
                    { value: 'manual', label: 'Manual checklist — verify by hand' },
                    { value: 'skip', label: 'Skip browser testing' },
                  ],
                  default: 'headless',
                },
                {
                  type: 'checkbox',
                  id: 'browserCheckConsoleErrors',
                  label: 'Browser: check for console errors',
                  default: true,
                },
                {
                  type: 'checkbox',
                  id: 'browserCheckNetworkErrors',
                  label: 'Browser: check for failed network requests',
                  default: true,
                },
                {
                  type: 'radio',
                  id: 'testAction',
                  label: 'Test management',
                  options: [
                    { value: 'update', label: 'Find & update tests affected by this change' },
                    { value: 'create_new', label: 'Write new tests for the new feature' },
                    { value: 'remove', label: 'Find & delete tests for removed functionality' },
                    { value: 'skip', label: 'No test changes needed' },
                  ],
                  default: 'update',
                },
                {
                  type: 'checkbox',
                  id: 'testRunTests',
                  label: 'Run the related tests after test changes',
                  default: true,
                },
              ],
            },
          ],
        },
      ],
      submitLabel: 'Record decision',
    };
  },

  async apply(ctx, args): Promise<SpecGateApply> {
    const values = args.formValues as Record<string, unknown> & {
      decision?: string;
      feedback?: string;
    };
    const decision: 'approve' | 'reject' = values.decision === 'reject' ? 'reject' : 'approve';
    ctx.logger.info({ decision }, 'spec gate decision recorded');
    if (decision === 'reject') {
      throw new Error(
        `spec gate rejected: ${typeof values.feedback === 'string' && values.feedback ? values.feedback : 'no feedback supplied'}`,
      );
    }

    const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
    const bool = (v: unknown, fallback: boolean): boolean =>
      typeof v === 'boolean' ? v : fallback;
    const runConfig: SpecGateRunConfig = {
      adversarialQaLevel: str(values.adversarialQaLevel, 'none'),
      simplifyCode: bool(values.simplifyCode, true),
      sprintDecision: str(values.sprintDecision, 'proceed'),
      sprintAutoResolveConflicts: bool(values.sprintAutoResolveConflicts, false),
      sprintReviewEnabled: bool(values.sprintReviewEnabled, true),
      verifyRunTest: bool(values.verifyRunTest, true),
      verifyRunLint: bool(values.verifyRunLint, true),
      verifyRunTypecheck: bool(values.verifyRunTypecheck, true),
      browserMode: str(values.browserMode, 'headless'),
      browserCheckConsoleErrors: bool(values.browserCheckConsoleErrors, true),
      browserCheckNetworkErrors: bool(values.browserCheckNetworkErrors, true),
      testAction: str(values.testAction, 'update'),
      testRunTests: bool(values.testRunTests, true),
    };

    // Map run-config answers to the downstream steps' exact field ids. The
    // runner auto-submits these in auto-continue mode and pre-fills the forms
    // otherwise. 06a/07 get fixed empty entries so their optional-only forms
    // auto-pass (detect-time defaults win); 08e gets an explicit empty
    // selection so the optional-insights triage never blocks the run.
    const preAnswers: Record<string, Record<string, unknown>> = {
      '06a-db-migrate': {},
      '06b-sprint-planning': {
        decision: runConfig.sprintDecision,
        autoResolveConflicts: runConfig.sprintAutoResolveConflicts,
        reviewEnabled: runConfig.sprintReviewEnabled,
      },
      '07-phase-2-implement': {},
      '08-phase-5-verify': {
        runTest: runConfig.verifyRunTest,
        runLint: runConfig.verifyRunLint,
        runTypecheck: runConfig.verifyRunTypecheck,
      },
      '08a-browser-verify': {
        mode: runConfig.browserMode,
        checkConsoleErrors: runConfig.browserCheckConsoleErrors,
        checkNetworkErrors: runConfig.browserCheckNetworkErrors,
      },
      '08b-test-management': {
        action: runConfig.testAction,
        runTests: runConfig.testRunTests,
      },
      '08e-insights-triage': { selectedInsights: [] },
    };

    await ctx.db
      .update(schema.tasks)
      .set({
        simplifyCode: runConfig.simplifyCode,
        adversarialQaLevel:
          runConfig.adversarialQaLevel !== 'none' ? runConfig.adversarialQaLevel : null,
        preAnswers,
        updatedAt: new Date(),
      })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info({ runConfig }, 'run configuration recorded for the hands-free stretch');

    return {
      decision,
      feedback: typeof values.feedback === 'string' ? values.feedback : '',
      runConfig,
    };
  },
};
