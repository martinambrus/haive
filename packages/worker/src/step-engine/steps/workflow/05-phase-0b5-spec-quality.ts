import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

interface SpecQualityDetect {
  specSummary: string;
  spec: string;
  specLength: number;
}

interface QualityFinding {
  dimension: string;
  severity: 'info' | 'warn' | 'error';
  comment: string;
}

interface SpecQualityApply {
  score: number;
  findings: QualityFinding[];
  source: 'llm' | 'stub';
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

export function parseSpecQualityOutput(raw: unknown): {
  score: number;
  findings: QualityFinding[];
} | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    if (typeof asObj.score === 'number' && Array.isArray(asObj.findings)) {
      return normaliseResult(asObj.score, asObj.findings);
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
      return normaliseResult(obj.score as number, obj.findings as unknown[]);
    }
  } catch {
    return null;
  }
  return null;
}

function normaliseResult(
  score: number,
  findings: unknown[],
): { score: number; findings: QualityFinding[] } {
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
  return { score: clamped, findings: items };
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
    return {
      specSummary: output.summary ?? '',
      spec,
      specLength: spec.length,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Phase 0b.5: Spec quality review',
      description: [
        `Spec length: ${detected.specLength} chars`,
        '',
        detected.specSummary || '(no summary available)',
      ].join('\n'),
      fields: [
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
    optional: true,
    buildPrompt: (args) => {
      const detected = args.detected as SpecQualityDetect;
      const values = args.formValues as { focusAreas?: string };
      return [
        'You are the spec quality review phase of an engineering workflow.',
        `Evaluate the draft specification against these dimensions: ${QUALITY_DIMENSIONS.join(', ')}.`,
        'Emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "score": <integer 0-10>, "findings": [ { "dimension": "<name>", "severity": "info|warn|error", "comment": "<text>" } ] }',
        'Score reflects overall readiness for gate 1 approval. Cite concrete gaps in findings.',
        '',
        `Focus areas: ${values.focusAreas ?? '(none)'}`,
        '',
        '=== Spec body ===',
        detected.spec || '(empty)',
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<SpecQualityApply> {
    const parsed = parseSpecQualityOutput(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info(
        { score: parsed.score, findings: parsed.findings.length, source: 'llm' },
        'spec quality review parsed',
      );
      return { score: parsed.score, findings: parsed.findings, source: 'llm' };
    }
    const stub = stubSpecQuality();
    ctx.logger.info(
      { score: stub.score, findings: stub.findings.length, source: 'stub' },
      'spec quality review stubbed',
    );
    return { score: stub.score, findings: stub.findings, source: 'stub' };
  },
};
