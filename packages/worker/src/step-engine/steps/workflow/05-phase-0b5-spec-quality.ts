import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

interface SpecQualityDetect {
  specSummary: string;
  spec: string;
  specLength: number;
  /** Default for the form's max-iterations selector — sourced from
   *  tasks.step_loop_limits at detect time so retries reflect whatever
   *  budget the user previously chose for the task. */
  currentBudget: number;
}

const SPEC_QUALITY_DEFAULT_BUDGET = 3;
const SPEC_QUALITY_BUDGET_OPTIONS = [3, 5, 10, 15, 20] as const;

interface QualityFinding {
  dimension: string;
  severity: 'info' | 'warn' | 'error';
  comment: string;
}

interface SpecQualityApply {
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
      );
    }
    return null;
  } else {
    return null;
  }
  const fenceMatch = /```json\s*([\s\S]*?)```/.exec(text);
  const body = fenceMatch?.[1];
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
      );
    }
  } catch {
    return null;
  }
  return null;
}

function normaliseResult(
  score: number,
  findings: unknown[],
  amendedSpec: string | null,
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
  return { score: clamped, findings: items, amendedSpec };
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
  'You are the spec quality review phase of an engineering workflow.',
  `Evaluate the draft specification against these dimensions: ${QUALITY_DIMENSIONS.join(', ')}.`,
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{',
  '  "score": <integer 0-10>,',
  '  "findings": [ { "dimension": "<name>", "severity": "info|warn|error", "comment": "<text>" } ],',
  '  "amendedSpec": "<full revised spec body, or omit when no fixable issues remain>"',
  '}',
  'Score reflects overall readiness for gate 1 approval. Cite concrete gaps in findings.',
  'When any finding has severity "warn" or "error", you MUST also emit `amendedSpec`',
  'with the full corrected spec body that addresses those findings — do not return',
  'a diff or partial snippet. Omit `amendedSpec` only when no warn/error findings remain.',
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
    maxIterations: 3,
    shouldContinue: ({ applyOutput }) => {
      const out = applyOutput as SpecQualityApply;
      return out.findings.some((f) => f.severity === 'error' || f.severity === 'warn');
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
      const finalSpec = parsed.amendedSpec ?? workingSpec;
      ctx.logger.info(
        {
          iteration: args.iteration,
          score: parsed.score,
          findings: parsed.findings.length,
          amended: parsed.amendedSpec !== null,
          source: 'llm',
        },
        'spec quality review parsed',
      );
      return {
        score: parsed.score,
        findings: parsed.findings,
        source: 'llm',
        spec: finalSpec,
      };
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
    return { score: stub.score, findings: stub.findings, source: 'stub', spec: workingSpec };
  },
};
