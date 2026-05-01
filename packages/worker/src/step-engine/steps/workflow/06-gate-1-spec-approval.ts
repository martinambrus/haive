import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

interface SpecGateDetect {
  /** Full spec body (markdown). The renderer turns this into HTML inside
   *  the expandable "Full specification" section. */
  specBody: string;
  /** Short executive view derived from the spec — the first ~6 lines of
   *  meaningful prose. Falls back to a leading slice when no headings/
   *  paragraphs are present. */
  specSummary: string;
  qualityScore: number | null;
  qualityFindings: string[];
  iterationHistory: string[];
  exhaustedBudget: boolean;
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
  const score = typeof out?.score === 'number' ? `${out.score}/10` : '?/10';
  const fc = Array.isArray(out?.findings) ? out!.findings!.length : 0;
  const errs = Array.isArray(out?.findings)
    ? out!.findings!.filter((f) => f.severity === 'error').length
    : 0;
  const warns = Array.isArray(out?.findings)
    ? out!.findings!.filter((f) => f.severity === 'warn').length
    : 0;
  return `Iteration ${idx}: score ${score}, ${fc} finding(s) (${errs} error / ${warns} warn)`;
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
    const planOutput = (plan?.output as PrePlanningOutput | null) ?? {};
    const qualityOutput = (quality?.output as SpecQualityOutput | null) ?? {};
    // Step 05 amends the spec across loop iterations; prefer its final
    // amended body when present, fall back to the original 04 spec/summary.
    const specBody = qualityOutput.spec ?? planOutput.spec ?? planOutput.summary ?? '';
    const iterations = (quality?.iterations ?? []) as IterationEntry[];
    const exhaustedBudget = iterations.some((entry) => entry.exhaustedBudget === true);
    return {
      specBody,
      specSummary: buildSpecSummary(specBody),
      qualityScore: typeof qualityOutput.score === 'number' ? qualityOutput.score : null,
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
