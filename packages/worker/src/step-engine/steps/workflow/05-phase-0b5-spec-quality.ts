import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { extractFencedJson } from '../_fenced-json.js';

interface SpecQualityDetect {
  specSummary: string;
  spec: string;
  specLength: number;
  /** Default for the form's max-iterations selector — sourced from
   *  tasks.step_loop_limits at detect time so retries reflect whatever
   *  budget the user previously chose for the task. */
  currentBudget: number;
}

const SPEC_QUALITY_DEFAULT_BUDGET = 10;
const SPEC_QUALITY_BUDGET_OPTIONS = [3, 5, 10, 15, 20] as const;

interface QualityFinding {
  dimension: string;
  severity: 'info' | 'warn' | 'error';
  comment: string;
}

type SpecVerdict = 'APPROVED' | 'NEEDS_REVISION' | 'BLOCKING_AMBIGUITY';

interface SpecQualityApply {
  /** Reviewer verdict driving the loop + gate 1: APPROVED stops as done,
   *  NEEDS_REVISION continues the amend loop, BLOCKING_AMBIGUITY stops and
   *  surfaces to the user (intent must be clarified; the writer cannot fix it). */
  verdict: SpecVerdict;
  score: number;
  findings: QualityFinding[];
  source: 'llm' | 'stub';
  /** Final spec body after this pass. Identical to the input spec when the
   *  LLM didn't produce an amendment (or when no fixable findings were
   *  present); otherwise the amended version. Gate 1 prefers this over
   *  the original 04-pre-planning spec. */
  spec: string;
}

interface PrePlanningOutput {
  summary?: string;
  spec?: string;
}

const QUALITY_DIMENSIONS = [
  'goal_clarity',
  'scope_boundaries',
  'acceptance_criteria',
  'risk_coverage',
  'dependency_mapping',
  'data_model_impact',
  'api_surface_impact',
  'test_strategy',
  'rollback_plan',
  'observability',
  'security_considerations',
  'performance_considerations',
  'migration_impact',
  'documentation_updates',
];

function coerceSeverity(value: unknown): QualityFinding['severity'] {
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  return 'info';
}

export interface SpecQualityParseResult {
  verdict: SpecVerdict;
  score: number;
  findings: QualityFinding[];
  amendedSpec: string | null;
}

export function parseSpecQualityOutput(raw: unknown): SpecQualityParseResult | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    if (typeof asObj.score === 'number' && Array.isArray(asObj.findings)) {
      return normaliseResult(
        asObj.score,
        asObj.findings,
        typeof asObj.amendedSpec === 'string' ? asObj.amendedSpec : null,
        asObj.verdict,
      );
    }
    return null;
  } else {
    return null;
  }
  const body = extractFencedJson(text);
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).score === 'number' &&
      Array.isArray((parsed as Record<string, unknown>).findings)
    ) {
      const obj = parsed as Record<string, unknown>;
      return normaliseResult(
        obj.score as number,
        obj.findings as unknown[],
        typeof obj.amendedSpec === 'string' ? (obj.amendedSpec as string) : null,
        obj.verdict,
      );
    }
  } catch {
    return null;
  }
  return null;
}

function coerceVerdict(value: unknown, hasFixable: boolean): SpecVerdict {
  if (value === 'APPROVED' || value === 'NEEDS_REVISION' || value === 'BLOCKING_AMBIGUITY') {
    return value;
  }
  // Derive when the model omitted an explicit verdict: warn/error findings mean
  // there is something to revise, otherwise the spec is clean enough to approve.
  return hasFixable ? 'NEEDS_REVISION' : 'APPROVED';
}

function normaliseResult(
  score: number,
  findings: unknown[],
  amendedSpec: string | null,
  rawVerdict: unknown,
): SpecQualityParseResult {
  const clamped = Math.max(0, Math.min(10, Math.round(score)));
  const items: QualityFinding[] = [];
  for (const raw of findings) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const dimension = typeof f.dimension === 'string' ? f.dimension : 'general';
    const comment = typeof f.comment === 'string' ? f.comment : '';
    items.push({
      dimension,
      severity: coerceSeverity(f.severity),
      comment,
    });
  }
  const hasFixable = items.some((f) => f.severity === 'warn' || f.severity === 'error');
  return {
    verdict: coerceVerdict(rawVerdict, hasFixable),
    score: clamped,
    findings: items,
    amendedSpec,
  };
}

function stubSpecQuality(): { score: number; findings: QualityFinding[] } {
  return {
    score: 5,
    findings: [
      {
        dimension: 'general',
        severity: 'info',
        comment: 'LLM synthesis skipped — default neutral score emitted.',
      },
    ],
  };
}

/** Pull the most recent amended-spec body from prior loop passes; falls
 *  back to the original spec from 04-pre-planning on the first pass.
 *  Iterations record the apply output (which carries `spec`), so the
 *  latest entry's spec is the cumulative working draft. */
function latestSpec(originalSpec: string, previous: StepLoopPassRecord[]): string {
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    const out = previous[i]?.applyOutput as SpecQualityApply | undefined;
    if (out && typeof out.spec === 'string' && out.spec.trim().length > 0) return out.spec;
  }
  return originalSpec;
}

const VERDICT_RANK: Record<SpecVerdict, number> = {
  APPROVED: 2,
  NEEDS_REVISION: 1,
  BLOCKING_AMBIGUITY: 0,
};

/** Rank an apply result so the regression guard can keep the better of two
 *  passes: verdict dominates (APPROVED beats NEEDS_REVISION beats
 *  BLOCKING_AMBIGUITY), score (0-10) breaks ties. */
function iterationRank(out: SpecQualityApply): number {
  const score = Math.max(0, Math.min(10, out.score));
  return VERDICT_RANK[out.verdict] * 100 + score;
}

/** Highest-ranked prior loop pass, or null on the first pass. */
function bestPriorIteration(previous: StepLoopPassRecord[]): SpecQualityApply | null {
  let best: SpecQualityApply | null = null;
  for (const p of previous) {
    const out = p.applyOutput as SpecQualityApply | undefined;
    if (!out || typeof out.score !== 'number' || typeof out.verdict !== 'string') continue;
    // Stubs are parse-failure placeholders with a fixed neutral score (5), not real
    // assessments. They must never win the regression guard: a genuine NEEDS_REVISION
    // can score below 5, and resurrecting the stub over it freezes the loop on the
    // stub forever (1 info finding, no amendment) until the budget is exhausted.
    if (out.source === 'stub') continue;
    if (!best || iterationRank(out) > iterationRank(best)) best = out;
  }
  return best;
}

/** Renders prior findings as a markdown bullet list to feed the next
 *  iteration's prompt. Helps the LLM target the same issues for amendment
 *  rather than drift onto unrelated dimensions each pass. */
function formatPriorFindings(previous: StepLoopPassRecord[]): string {
  if (previous.length === 0) return '';
  const last = previous[previous.length - 1]?.applyOutput as SpecQualityApply | undefined;
  if (!last || last.findings.length === 0) return '';
  const lines = last.findings.map((f) => `- [${f.severity}] ${f.dimension}: ${f.comment}`);
  return ['', `=== Findings from iteration ${previous.length} ===`, ...lines].join('\n');
}

const SPEC_QUALITY_PROMPT_RULES = [
  'You are the spec quality review phase of an engineering workflow. Review the draft',
  'specification as a senior engineer would before a human approves it.',
  `Score the spec against these dimensions: ${QUALITY_DIMENSIONS.join(', ')}.`,
  '',
  'Ambiguity hunt — scan the whole spec and raise a finding for each instance of: vague',
  'verbs ("improve", "optimize", "handle properly"); actorless passive voice; unconditioned',
  'conditionals ("if needed", "as appropriate"); unnamed references ("the form", "the table"',
  'without naming which); untestable acceptance criteria; implicit assumptions of an unstated',
  'rule; and internal contradictions.',
  '',
  'Codebase cross-check — for every file, function, or "follow the pattern from X" claim in',
  'the spec, use your read tools (Read, Grep, Glob) to confirm it actually exists and does',
  'what the spec says. A reference to code that does not exist is a BLOCKING_AMBIGUITY.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{',
  '  "verdict": "APPROVED" | "NEEDS_REVISION" | "BLOCKING_AMBIGUITY",',
  '  "score": <integer 0-10>,',
  '  "findings": [ { "dimension": "<dimension or \\"ambiguity\\">", "severity": "info|warn|error", "comment": "<text; cite the spec section or file:line>" } ],',
  '  "amendedSpec": "<full revised spec body, or omit when no fixable issues remain>"',
  '}',
  '',
  'Verdict rules:',
  '- APPROVED: no warn/error findings and no relevant dimension left unaddressed.',
  '- NEEDS_REVISION: fixable gaps exist and you CAN correct them now — you MUST emit',
  '  `amendedSpec` with the FULL corrected spec body (never a diff or partial snippet).',
  "- BLOCKING_AMBIGUITY: the spec's intent itself is unclear (references missing code, or",
  '  "which X?" with several candidates) so a human must clarify — do NOT amend; put the',
  '  blocking questions in findings.',
  'Score reflects overall readiness for gate 1. Cite a concrete spec section or file:line in',
  'every finding.',
] as const;

export const phase0b5SpecQualityStep: StepDefinition<SpecQualityDetect, SpecQualityApply> = {
  metadata: {
    id: '05-phase-0b5-spec-quality',
    workflowType: 'workflow',
    index: 5,
    title: 'Phase 0b.5: Spec quality review',
    description:
      'Evaluates the draft spec against 14 quality dimensions and surfaces a structured findings list ahead of gate 1.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<SpecQualityDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const output = (prev?.output as PrePlanningOutput | null) ?? {};
    const spec = output.spec ?? '';
    const taskRow = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { stepLoopLimits: true },
    });
    const limits = (taskRow?.stepLoopLimits ?? {}) as Record<string, number>;
    const taskBudget = limits['05-phase-0b5-spec-quality'];
    const currentBudget =
      typeof taskBudget === 'number' && taskBudget > 0 ? taskBudget : SPEC_QUALITY_DEFAULT_BUDGET;
    return {
      specSummary: output.summary ?? '',
      spec,
      specLength: spec.length,
      currentBudget,
    };
  },

  form(_ctx, detected): FormSchema {
    // Make sure the persisted budget always shows up in the dropdown even
    // when it falls outside the canonical option set (e.g. someone set
    // 7 via the API directly).
    const baseOptions = [...SPEC_QUALITY_BUDGET_OPTIONS] as number[];
    const allOptions = baseOptions.includes(detected.currentBudget)
      ? baseOptions
      : [...baseOptions, detected.currentBudget].sort((a, b) => a - b);
    return {
      title: 'Phase 0b.5: Spec quality review',
      description: [
        `Spec length: ${detected.specLength} chars`,
        '',
        detected.specSummary || '(no summary available)',
      ].join('\n'),
      fields: [
        {
          type: 'select',
          id: 'maxIterations',
          label: 'Max review/amend passes (loop budget)',
          options: allOptions.map((n) => ({
            value: String(n),
            label: n === SPEC_QUALITY_DEFAULT_BUDGET ? `${n} (default)` : String(n),
          })),
          default: String(detected.currentBudget),
          required: true,
        },
        {
          type: 'textarea',
          id: 'focusAreas',
          label: 'Focus areas for the review (optional)',
          rows: 3,
          placeholder: 'Dimensions to prioritise in the quality review.',
        },
      ],
      submitLabel: 'Review spec',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 60 * 60 * 1000,
    buildPrompt: (args) => {
      const detected = args.detected as SpecQualityDetect;
      const values = args.formValues as { focusAreas?: string };
      return [
        ...SPEC_QUALITY_PROMPT_RULES,
        '',
        `Focus areas: ${values.focusAreas ?? '(none)'}`,
        '',
        '=== Spec body ===',
        detected.spec || '(empty)',
      ].join('\n');
    },
  },

  loop: {
    maxIterations: SPEC_QUALITY_DEFAULT_BUDGET,
    shouldContinue: ({ applyOutput }) => {
      // Keep amending only while the reviewer says NEEDS_REVISION. APPROVED is
      // done; BLOCKING_AMBIGUITY stops the loop so the user clarifies intent at
      // gate 1 rather than the writer looping on an un-fixable spec.
      const out = applyOutput as SpecQualityApply;
      return out.verdict === 'NEEDS_REVISION';
    },
    buildIterationPrompt: ({ detected, formValues, iteration, previousIterations }) => {
      const det = detected as SpecQualityDetect;
      const values = formValues as { focusAreas?: string };
      const workingSpec = latestSpec(det.spec, previousIterations);
      return [
        ...SPEC_QUALITY_PROMPT_RULES,
        '',
        `This is review iteration ${iteration + 1}. Prior amendments are already`,
        'reflected in the spec body below — re-review the current draft and amend',
        'further only if warn/error findings remain.',
        '',
        `Focus areas: ${values.focusAreas ?? '(none)'}`,
        formatPriorFindings(previousIterations),
        '',
        '=== Current spec body (post-prior-amendments) ===',
        workingSpec || '(empty)',
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<SpecQualityApply> {
    const detected = args.detected as SpecQualityDetect;
    const workingSpec = latestSpec(detected.spec, args.previousIterations);
    const parsed = parseSpecQualityOutput(args.llmOutput ?? null);
    if (parsed) {
      const current: SpecQualityApply = {
        verdict: parsed.verdict,
        score: parsed.score,
        findings: parsed.findings,
        source: 'llm',
        spec: parsed.amendedSpec ?? workingSpec,
      };
      // Regression guard: a re-run or later iteration that ranks worse than a
      // prior pass must not lose the better earlier result. Rank by verdict then
      // score. This is the per-step fix for "a worse re-run wins" — it leaves the
      // global latest-wins resolver untouched.
      const best = bestPriorIteration(args.previousIterations);
      if (best && iterationRank(best) > iterationRank(current)) {
        ctx.logger.info(
          {
            iteration: args.iteration,
            verdict: current.verdict,
            score: current.score,
            keptVerdict: best.verdict,
            keptScore: best.score,
          },
          'spec quality review regressed — keeping the higher-ranked prior iteration',
        );
        return best;
      }
      ctx.logger.info(
        {
          iteration: args.iteration,
          verdict: current.verdict,
          score: current.score,
          findings: current.findings.length,
          amended: parsed.amendedSpec !== null,
          source: 'llm',
        },
        'spec quality review parsed',
      );
      return current;
    }
    const stub = stubSpecQuality();
    ctx.logger.info(
      {
        iteration: args.iteration,
        score: stub.score,
        findings: stub.findings.length,
        source: 'stub',
      },
      'spec quality review stubbed',
    );
    return {
      verdict: 'NEEDS_REVISION',
      score: stub.score,
      findings: stub.findings,
      source: 'stub',
      spec: workingSpec,
    };
  },
};
