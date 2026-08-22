import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { coerceReviewSeverity, isBlockingSeverity } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';

// Gate 1.5 — adversarial-QA review (legacy gate1-5-adversarial-qa-review.md).
// After 08d runs the adversarial agents, the HUMAN decides what to do with the
// findings: accept them as-is, or send all / critical+high / hand-picked findings
// back to implementation with optional instructions. This replaces 08d's old
// AUTOMATIC fix loop so the user controls both quality and the token cost of
// another implementation round. "Fix" routes back to implementation (restartLoop,
// uncapped/human-driven, like gate 2); "Accept" finalizes and the findings still
// surface advisorily at gate 2. Runs only when 08d produced findings.

interface QaFinding {
  /** Stable index-based key used as the multi-select option value. */
  key: string;
  severity: ReviewSeverity;
  /** Short label for the multi-select option. */
  label: string;
  /** Full formatted line handed to the implementer when this finding is chosen. */
  line: string;
  /** Verified as not reproducible AND non-blocking, so gate 1.5 folds it behind a count. */
  folded: boolean;
}

interface QaReviewDetect {
  ran: boolean;
  level: string;
  blocking: boolean;
  counts: { critical: number; high: number; total: number };
  /** How many findings were folded out of `findings` because a verifier ran their PoC and
   *  could not reproduce it. Stated at the gate so nothing vanishes silently. */
  filteredCount: number;
  findings: QaFinding[];
}

interface QaReviewApply {
  decision: 'fix' | 'accept';
  diagnosis: string;
  selectedCount: number;
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
    /** 08d's PoC-verifier panel verdict; absent on runs from before it existed and on
     *  findings that were never blocking (only those are verified). */
    verification?: string;
  }[];
}

/** Is this finding hidden from gate 1.5's list, behind the filtered count?
 *
 *  ONLY when a verifier actually executed its proof-of-concept and could not reproduce it,
 *  AND it was not blocking. Everything else is shown, and each exclusion is deliberate:
 *
 *  - a BLOCKING finding is never folded whatever its verdict — 08d downgrades it to advisory
 *    and keeps it visible, because the developer keeps that call;
 *  - `untestable` says the ENVIRONMENT failed, not the finding; folding on it would turn a
 *    tooling outage into silent data loss;
 *  - `unverified` means nobody looked, which is not evidence of anything.
 *
 *  Presentation only. The finding stays in 08d's output and in review_findings either way. */
export function foldsAtGate(verification: string | undefined, severity: ReviewSeverity): boolean {
  return verification === 'not_reproduced' && !isBlockingSeverity(severity);
}

/** Build the fix request handed to the implementer from the chosen findings +
 *  free-text instructions. Mirrors gate-2's formatRejectDiagnosis. Returns '' when
 *  there is genuinely nothing to act on, so a stray "fix" with no selection and no
 *  text finalizes instead of looping with an empty request. */
export function formatQaFixDiagnosis(lines: string[], feedback: string): string {
  if (lines.length === 0 && !feedback) return '';
  const parts = [
    'Adversarial QA review: the developer asked to fix the findings below before proceeding.',
  ];
  if (lines.length > 0) {
    parts.push('', 'Findings to fix:', ...lines);
  }
  if (feedback) {
    parts.push('', 'Reviewer instructions:', feedback);
  }
  return parts.join('\n');
}

export const adversarialQaReviewStep: StepDefinition<QaReviewDetect, QaReviewApply> = {
  metadata: {
    id: '08d2-adversarial-qa-review',
    workflowType: 'workflow',
    index: 8.92,
    title: 'Gate 1.5: Adversarial QA review',
    description:
      'Review the adversarial-QA findings and decide: accept them as-is, or send all / critical+high / selected findings back to implementation with optional instructions.',
    requiresCli: false,
  },

  // Restart-loop: a "fix" decision restarts from implementation with the chosen
  // findings + instructions (uncapped, human-driven — like gate 2). "accept"
  // returns null so the forward walk continues to insight triage / gate 2.
  restartLoop: {
    evaluate: (out) =>
      out.decision === 'fix' && out.diagnosis.length > 0 ? { diagnosis: out.diagnosis } : null,
  },

  // Only when 08d actually ran AND surfaced findings — nothing to review otherwise.
  async shouldRun(ctx: StepContext): Promise<boolean> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08d-adversarial-qa');
    const out = prev?.output as Phase8dOutput | null;
    return out?.ran === true && (out.findings?.length ?? 0) > 0;
  },

  async detect(ctx: StepContext): Promise<QaReviewDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08d-adversarial-qa');
    const out = (prev?.output as Phase8dOutput | null) ?? {};
    const findings: QaFinding[] = (out.findings ?? []).map((f, i) => {
      const cat = f.category ?? 'issue';
      const loc = f.location ? ` @ ${f.location}` : '';
      // What a machine made of the PoC, stated before the severity so it is the first
      // thing read. A developer's scarcest input here is deciding which findings are real,
      // and NOT REPRO is the one that used to cost an afternoon to discover by hand.
      // Unverified findings carry no marker at all — most findings are never blocking and
      // so are never verified, and marking those would drown the two labels that matter.
      // NOT TESTED is the third label rather than silence: it still blocks, like an
      // unverified finding, but the reason is an environment the panel could not reach, and
      // a developer deciding what to act on needs to know which of the two it was.
      const verdict =
        f.verification === 'reproduced'
          ? '[REPRODUCED] '
          : f.verification === 'not_reproduced'
            ? '[NOT REPRO] '
            : f.verification === 'untestable'
              ? '[NOT TESTED] '
              : '';
      // Coerce rather than read straight through: this reads 08d's persisted jsonb,
      // which for a task started before the ladder change holds the old vocabulary.
      const severity = coerceReviewSeverity(f.severity, 'low');
      return {
        key: String(i),
        severity,
        folded: foldsAtGate(f.verification, severity),
        label: `${verdict}[${severity}] ${cat}${loc}`,
        line: `- ${verdict}[${severity}] ${cat}${loc}: ${f.impact ?? ''}${f.fix ? ` — fix: ${f.fix}` : ''}`,
      };
    });
    // Fold the findings a verifier actually RAN and could not reproduce, but only the
    // non-blocking ones. Filtering here rather than in the form removes them from the
    // reading list AND from the choose-what-to-fix control below, which is the triage cost
    // this exists to cut — a round once handed 26 findings, none blocking, to be sorted by
    // hand.
    //
    // Three things are deliberately NOT folded. A blocking finding, whatever its verdict:
    // that stays advisory-but-visible, which is the contract 08d already ships. `untestable`,
    // which says the ENVIRONMENT failed rather than the finding — hiding on it would turn a
    // tooling outage into silent data loss. And `unverified`, which means nobody looked.
    //
    // Presentation only: 08d's own output, its counts and every review_findings row keep all
    // of them, so nothing here is unrecoverable.
    const shown = findings.filter((f) => !f.folded);
    return {
      ran: out.ran === true,
      level: out.level ?? 'poc',
      blocking: out.blocking === true,
      filteredCount: findings.length - shown.length,
      counts: {
        critical: out.counts?.critical ?? 0,
        high: out.counts?.high ?? 0,
        total: out.counts?.total ?? findings.length,
      },
      findings: shown,
    };
  },

  form(_ctx, detected): FormSchema {
    // The folded line is part of the body, not a footnote: a count with no explanation
    // reads as findings going missing, which is the thing folding must not feel like.
    const foldedNote =
      detected.filteredCount > 0
        ? [
            '',
            `_${detected.filteredCount} further finding(s) are hidden: a verifier executed their`,
            'proof-of-concept against the running app and could not reproduce it. They remain',
            'recorded and queryable — only this list is filtered._',
          ].join('\n')
        : '';
    const infoSections: InfoSection[] = [
      {
        title: 'Adversarial QA findings',
        preview:
          `${detected.findings.length} shown` +
          (detected.filteredCount > 0 ? `, ${detected.filteredCount} filtered` : '') +
          ` (${detected.counts.critical} critical, ${detected.counts.high} high)`,
        body: (detected.findings.map((f) => f.line).join('\n') || '(no findings)') + foldedNote,
        defaultOpen: detected.blocking,
      },
    ];
    return {
      title: 'Gate 1.5: Adversarial QA review',
      description: [
        `Adversarial QA (${detected.level}): ${detected.counts.total} findings — ${detected.counts.critical} critical, ${detected.counts.high} high.` +
          (detected.filteredCount > 0
            ? ` ${detected.filteredCount} hidden as not reproducible.`
            : ''),
        '',
        'Decide what to do. "Fix" sends the chosen findings back to implementation (another round);',
        '"Accept as-is" proceeds — the findings still appear at the verification gate.',
      ].join('\n'),
      infoSections,
      fields: [
        {
          type: 'radio',
          id: 'decision',
          label: 'How do you want to handle these findings?',
          options: [
            { value: 'fix', label: 'Fix — send findings back to implementation' },
            { value: 'accept', label: 'Accept as-is — proceed without fixing' },
          ],
          default: detected.blocking ? 'fix' : 'accept',
          required: true,
        },
        {
          type: 'select',
          id: 'scope',
          label: 'Which findings to fix?',
          options: [
            { value: 'all', label: 'All findings' },
            { value: 'critical_high', label: 'Critical & high only' },
            { value: 'selected', label: 'Only the ones I pick below' },
          ],
          default: 'all',
          visibleWhen: { field: 'decision', equals: 'fix' },
        },
        {
          type: 'multi-select',
          id: 'findingKeys',
          label: 'Findings to fix',
          options: detected.findings.map((f) => ({ value: f.key, label: f.label })),
          visibleWhen: { field: 'scope', equals: 'selected' },
        },
        {
          type: 'textarea',
          id: 'feedback',
          label: 'Instructions for the implementer (optional)',
          rows: 4,
          placeholder: 'Anything to emphasise, or extra fixes to make in this round.',
          visibleWhen: { field: 'decision', equals: 'fix' },
        },
      ],
      submitLabel: 'Record decision',
    };
  },

  async apply(ctx, args): Promise<QaReviewApply> {
    const values = args.formValues as {
      decision?: string;
      scope?: string;
      findingKeys?: string[];
      feedback?: string;
    };
    const feedback = (values.feedback ?? '').trim();
    if (values.decision !== 'fix') {
      ctx.logger.info('adversarial QA findings accepted as-is');
      return { decision: 'accept', diagnosis: '', selectedCount: 0 };
    }
    const scope = values.scope ?? 'all';
    let chosen = args.detected.findings;
    if (scope === 'critical_high') {
      chosen = chosen.filter((f) => isBlockingSeverity(f.severity));
    } else if (scope === 'selected') {
      const keys = new Set(values.findingKeys ?? []);
      chosen = chosen.filter((f) => keys.has(f.key));
    }
    const diagnosis = formatQaFixDiagnosis(
      chosen.map((f) => f.line),
      feedback,
    );
    ctx.logger.info(
      { scope, count: chosen.length },
      'adversarial QA findings sent back to implementation',
    );
    return { decision: 'fix', diagnosis, selectedCount: chosen.length };
  },
};
