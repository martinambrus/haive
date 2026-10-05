import type { TaskEvent, TaskStep } from './api-client';

type Row = Record<string, unknown>;
export type HistoryTone = 'success' | 'warning' | 'error' | 'neutral';
export interface TaskHistoryEntry {
  id: string;
  title: string;
  round: number;
  timestamp: string;
  message: string;
  tone: HistoryTone;
}
export type HistoryStep = Pick<
  TaskStep,
  | 'id'
  | 'stepId'
  | 'title'
  | 'round'
  | 'status'
  | 'output'
  | 'usesCli'
  | 'cliInvocationCount'
  | 'degradedNote'
  | 'warningMessage'
  | 'startedAt'
  | 'endedAt'
>;

function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const SEVERITY: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const CHECKS = ['test', 'lint', 'typecheck', 'runtimeSmoke'];
// The implementation/verification segment of the workflow registry. Use IDs,
// not display titles, phase numbers from other workflows, or round positions.
const IMPLEMENTATION_STEPS = new Set([
  '07-phase-2-implement',
  '07a-code-simplify',
  '07b-phase-4-validate',
  '07c-ddev-reconcile',
  '08-phase-5-verify',
  '08a-browser-setup',
  '08a-browser-verify',
  '08b-test-management',
  '08c-code-review',
  '08c2-code-audit',
  '08d-adversarial-qa',
  '08d2-adversarial-qa-review',
  '08e-insights-triage',
  '09-gate-2-verify-approval',
]);
function failedChecks(output: Row): boolean {
  return CHECKS.some((key) => row(output[key]).ran === true && row(output[key]).passed === false);
}
function findings(output: Row): Row[] {
  return [
    ...list(output.issues).filter((f) => text(row(f).severity)),
    ...list(output.upstreamIssues),
    ...list(output.findings),
    ...list(row(output.peer).findings),
    ...list(row(output.security).findings),
    ...list(output.extraLenses).flatMap((lens) => list(row(lens).findings)),
  ]
    .map(row)
    .filter(
      (f) =>
        f.refuted !== true &&
        (text(f.severity) ||
          text(f.issue) ||
          text(f.description) ||
          text(f.comment) ||
          text(f.impact) ||
          text(f.category)),
    );
}

/** Count reported findings, not unique bugs: multiple reviewers may report the
 * same defect. Only the host's verdict/event says it requested a fix round. */
function findingHeadline(found: Row[], activity: string): string {
  const severities = [...new Set(found.map((f) => text(f.severity).toLowerCase()))]
    .filter((s) => SEVERITY[s])
    .sort((a, b) => SEVERITY[b]! - SEVERITY[a]!);
  const count = found.length;
  const noun = count === 1 ? 'finding' : 'findings';
  if (
    severities.length === 1 &&
    found.every((f) => text(f.severity).toLowerCase() === severities[0])
  ) {
    return `${activity} found ${count} ${severities[0]}-severity ${noun}.`;
  }
  return `${activity} found ${count} ${noun}${severities[0] ? ` (highest severity: ${severities[0]})` : ''}.`;
}

/** Deliberately generated headlines, never clipped finding/recap prose. Detail
 * belongs in the linked step; these messages describe the work and its outcome. */
function outcome(
  step: HistoryStep,
  fixEvent?: TaskEvent,
): { message: string; tone: HistoryTone } | null {
  const output = row(step.output);
  if (step.status === 'failed') return { message: 'This step failed.', tone: 'error' };
  if (step.stepId === '09-gate-2-verify-approval' && output.decision === 'reject') {
    return { message: 'Verification was rejected; fixes requested.', tone: 'error' };
  }
  if (step.stepId === '08d2-adversarial-qa-review' && output.decision === 'fix') {
    return { message: 'QA review requested fixes.', tone: 'error' };
  }
  const found = findings(output);
  const activity =
    output.audited === true || step.stepId.includes('audit')
      ? 'The audit'
      : ['VALID', 'ISSUES_FOUND', 'UNPARSEABLE'].includes(text(output.verdict))
        ? 'Validation'
        : 'The review';
  if (output.blocking === true || fixEvent) {
    return {
      message: found.length
        ? `${findingHeadline(found, activity)} Fix round requested.`
        : 'Another implementation pass was requested.',
      tone: 'error',
    };
  }
  if (failedChecks(output) || output.passed === false || output.testsPassed === false) {
    return { message: 'Verification found failing checks.', tone: 'warning' };
  }
  if (
    output.reviewIncomplete === true ||
    output.qaIncomplete === true ||
    output.reviewed === false ||
    output.audited === false ||
    row(output.coverage).truncated === true
  ) {
    return {
      message: found.length
        ? `Review incomplete; ${found.length} findings reported.`
        : 'Review incomplete; some changes were not checked.',
      tone: 'warning',
    };
  }
  if (found.length) return { message: findingHeadline(found, activity), tone: 'warning' };
  if (output.advisoryVerdict === true)
    return { message: 'Reviewers raised concerns.', tone: 'warning' };
  if (output.verdict === 'UNPARSEABLE')
    return { message: 'The validation result could not be read.', tone: 'warning' };
  if (step.degradedNote || text(output.degradedNote))
    return { message: 'This step finished with incomplete checks or results.', tone: 'warning' };
  if (step.warningMessage)
    return { message: 'This step finished with a warning.', tone: 'warning' };
  if (output.source === 'stub')
    return { message: 'No usable agent result was recorded.', tone: 'warning' };
  // Browser pass-through flags are not verdicts: manual mode prepares a
  // checklist, and an MCP pass without evidence explicitly remains incomplete.
  if (step.stepId === '08a-browser-verify') {
    if (output.verificationIncomplete === true) {
      return { message: 'Browser verification lacks test evidence.', tone: 'warning' };
    }
    if (output.method === 'manual' && output.ran === true && output.skipped === false) {
      return { message: 'A manual browser checklist was prepared.', tone: 'neutral' };
    }
  }
  const narrowed = list(output.excludedDimensions).length > 0;
  const fixes = list(output.fixesApplied).map(text).filter(Boolean).length;
  if (fixes)
    return {
      message: `Validation applied ${fixes} ${fixes === 1 ? 'fix' : 'fixes'}${narrowed ? '; some dimensions were excluded' : ''}.`,
      tone: narrowed ? 'warning' : 'success',
    };
  if (output.verdict === 'VALID') {
    return {
      message: narrowed
        ? 'Selected dimensions passed; some dimensions were excluded.'
        : 'No issues found; nothing to fix.',
      tone: narrowed ? 'warning' : 'success',
    };
  }
  if (output.verdict === 'ISSUES_FOUND')
    return { message: 'Validation found issues.', tone: 'warning' };
  // The audit producer also records audited:true for unparseable reports.
  if (output.audited === true)
    return { message: 'The audit recorded no findings.', tone: 'neutral' };
  if (output.reviewed === true) {
    const verdicts = [row(output.peer), row(output.security), ...list(output.extraLenses).map(row)];
    if (verdicts.every((v) => ['APPROVE', 'SECURE'].includes(text(v.verdict)))) {
      return {
        message:
          Number(output.refutedCount) > 0
            ? 'All reviewers approved; blocking findings were refuted.'
            : 'All reviewers approved; no issues found.',
        tone: 'success',
      };
    }
    return { message: 'The reviewers finished their assessment.', tone: 'neutral' };
  }
  const ranChecks = CHECKS.filter((key) => row(output[key]).ran === true);
  if (ranChecks.length && ranChecks.every((key) => row(output[key]).passed === true)) {
    const skipped = CHECKS.some((key) => output[key] != null && row(output[key]).ran === false);
    return {
      message: skipped ? 'Checks passed; some checks were skipped.' : 'All checks that ran passed.',
      tone: skipped ? 'warning' : 'success',
    };
  }
  if (output.testsPassed === true) return { message: 'Tests passed.', tone: 'success' };
  if (step.stepId === '09-gate-2-verify-approval' && output.decision === 'approve') {
    return { message: 'Verification approved.', tone: 'success' };
  }
  if (step.stepId === '07a-code-simplify' && output.ran === true) {
    const count = list(output.filesSimplified).length;
    return {
      message:
        output.noChangesNeeded === true
          ? 'The simplifier found no changes needed.'
          : count
            ? `The agent simplified ${count} ${count === 1 ? 'file' : 'files'}.`
            : 'The agent finished its simplification pass.',
      tone: 'neutral',
    };
  }
  if (
    step.stepId === '08a-browser-verify' &&
    output.ran === true &&
    output.skipped === false &&
    output.passed === true &&
    ['mcp', 'interactive', 'headless'].includes(text(output.method))
  ) {
    return { message: 'Browser verification passed.', tone: 'success' };
  }
  if (step.stepId === '08a-browser-verify' && output.ran === true && output.skipped === false) {
    return { message: 'No confirmed browser verdict was recorded.', tone: 'warning' };
  }
  if (step.stepId === '08d-adversarial-qa' && output.ran === true) {
    return {
      message:
        output.qaIncomplete === false
          ? 'Adversarial QA found no issues.'
          : 'Adversarial QA finished.',
      tone: output.qaIncomplete === false ? 'success' : 'neutral',
    };
  }
  if (step.stepId === '08b-test-management') {
    const count =
      list(output.testsCreated).length +
      list(output.testsUpdated).length +
      list(output.testsDeleted).length;
    if (count) return { message: 'Tests updated; no run result was recorded.', tone: 'warning' };
  }
  if (step.stepId === '08e-insights-triage' && output.implemented === true) {
    return { message: 'The agent implemented the selected insights.', tone: 'neutral' };
  }
  if (step.stepId === '07-phase-2-implement' || Array.isArray(output.filesTouched)) {
    const files = new Set(list(output.filesTouched).map(text).filter(Boolean)).size;
    const activity = step.round > 0 ? 'completed a fix pass' : 'implemented the changes';
    return {
      message: `The agent ${activity}${files ? ` (${files} ${files === 1 ? 'file' : 'files'} changed)` : ''}.`,
      tone: 'neutral',
    };
  }
  return null;
}

/** Implementation/verification agent work and errors, ordered first to last. Separate
 * rounds stay separate; a retry replaces the result in that step's row. */
export function buildTaskHistory(
  steps: readonly HistoryStep[],
  events: readonly TaskEvent[] = [],
): TaskHistoryEntry[] {
  const fixes = new Map<string, TaskEvent>();
  for (const event of events) {
    if (event.eventType !== 'fix_loop.requested' || !event.taskStepId) continue;
    const earlier = fixes.get(event.taskStepId);
    if (!earlier || event.createdAt > earlier.createdAt) fixes.set(event.taskStepId, event);
  }
  return steps
    .flatMap((step) => {
      if (
        !IMPLEMENTATION_STEPS.has(step.stepId) ||
        !['done', 'failed'].includes(step.status) ||
        !step.endedAt ||
        !Number.isFinite(Date.parse(step.endedAt))
      )
        return [];
      const event = fixes.get(step.id);
      // Retry resets startedAt, whereas completing an escalation gate only
      // advances endedAt. Keep requests recorded during the current attempt.
      const currentEvent =
        event && Date.parse(event.createdAt) >= Date.parse(step.startedAt ?? step.endedAt)
          ? event
          : undefined;
      const output = row(step.output);
      const hasError =
        step.status === 'failed' ||
        (step.stepId === '09-gate-2-verify-approval' && output.decision === 'reject') ||
        (step.stepId === '08d2-adversarial-qa-review' && output.decision === 'fix') ||
        currentEvent ||
        output.blocking === true ||
        failedChecks(output) ||
        output.passed === false ||
        output.testsPassed === false ||
        ['ISSUES_FOUND', 'UNPARSEABLE'].includes(text(output.verdict));
      if (!(step.usesCli && step.cliInvocationCount > 0) && !hasError) return [];
      const result = outcome(step, currentEvent);
      if (!result) return [];
      return [
        {
          id: step.id,
          title: step.title,
          round: step.round,
          timestamp: step.endedAt,
          message: result.message,
          tone: result.tone,
        },
      ];
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
}

/** Called once when opening. No separator on a first visit or without both
 * previous and new outcomes. Live appends must not recompute this boundary. */
export function historyDividerAfter(
  entries: readonly TaskHistoryEntry[],
  previousOpenThrough: number | null,
): string | null {
  if (previousOpenThrough === null || !Number.isFinite(previousOpenThrough)) return null;
  const boundary = entries.findLastIndex(
    (entry) => Date.parse(entry.timestamp) <= previousOpenThrough,
  );
  return boundary >= 0 && boundary < entries.length - 1 ? entries[boundary]!.id : null;
}
