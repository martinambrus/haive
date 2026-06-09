import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { STEP_CLI_ROLES, type FormSchema } from '@haive/shared';
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

// Budget is counted in ROUNDS; each round is 2 LLM passes (1 review + 1 correct),
// so a budget of 5 rounds is up to 10 CLI calls. See loop.passesPerRound below.
const SPEC_QUALITY_DEFAULT_BUDGET = 5;
const SPEC_QUALITY_BUDGET_OPTIONS = [3, 5, 10, 15, 20] as const;

// Alternating roles: even loop passes (0, 2, 4, ...) REVIEW with the reviewer
// CLI; odd passes (1, 3, ...) CORRECT with the corrector CLI. The runner asks
// `loop.resolveRole(iteration)` which provider to use, and resolves a per-role
// per-step preference (e.g. Codex reviews, Claude Code corrects).
const ROLE_REVIEWER = 'reviewer';
const ROLE_CORRECTOR = 'corrector';
function roleForIteration(iteration: number): string {
  return iteration % 2 === 0 ? ROLE_REVIEWER : ROLE_CORRECTOR;
}

interface QualityFinding {
  dimension: string;
  severity: 'info' | 'warn' | 'error';
  comment: string;
}

type SpecVerdict = 'APPROVED' | 'NEEDS_REVISION' | 'BLOCKING_AMBIGUITY';

interface SpecQualityApply {
  /** Reviewer verdict driving the loop + gate 1: APPROVED stops as done,
   *  NEEDS_REVISION continues the review/correct loop, BLOCKING_AMBIGUITY stops
   *  and surfaces to the user (intent must be clarified; the corrector can't fix it). */
  verdict: SpecVerdict;
  score: number;
  findings: QualityFinding[];
  /** Which pass produced this: a reviewer pass ('review'), a corrector pass
   *  ('correct'), or a parse-failure placeholder ('stub'). Only 'review' passes
   *  carry a real assessment and are ranked by the regression guard. */
  source: 'review' | 'correct' | 'stub';
  /** Spec body after this pass. Reviews leave it unchanged (review only);
   *  corrections set the amended body. Gate 1 prefers this over the original
   *  04-pre-planning spec. */
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

/** Parse a REVIEW pass output: a fenced/object JSON with verdict, score and
 *  findings. amendedSpec is accepted (and ignored by review apply) for
 *  backward compatibility. */
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

/** Parse a CORRECT pass output: a fenced/object JSON whose `amendedSpec` holds
 *  the full revised spec body. Returns null when no JSON is parseable. */
export function parseCorrectorOutput(raw: unknown): { amendedSpec: string | null } | null {
  if (!raw) return null;
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return { amendedSpec: typeof o.amendedSpec === 'string' ? o.amendedSpec : null };
  }
  if (typeof raw !== 'string') return null;
  const body = extractFencedJson(raw);
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      return { amendedSpec: typeof parsed.amendedSpec === 'string' ? parsed.amendedSpec : null };
    }
  } catch {
    return null;
  }
  return null;
}

function coerceVerdict(value: unknown, hasError: boolean): SpecVerdict {
  if (value === 'APPROVED' || value === 'NEEDS_REVISION' || value === 'BLOCKING_AMBIGUITY') {
    return value;
  }
  // Derive when the model omitted an explicit verdict: only ERROR findings (real
  // gaps/bugs) force a revision. Warn/info are non-blocking polish, so the spec is
  // clean enough to approve and the loop must not keep chasing them.
  return hasError ? 'NEEDS_REVISION' : 'APPROVED';
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
  const hasError = items.some((f) => f.severity === 'error');
  return {
    verdict: coerceVerdict(rawVerdict, hasError),
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

/** Pull the most recent spec body from prior loop passes (review passes keep it
 *  unchanged; correct passes carry the amended body); falls back to the original
 *  04-pre-planning spec on the first pass. */
function latestSpec(originalSpec: string, previous: StepLoopPassRecord[]): string {
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    const out = previous[i]?.applyOutput as SpecQualityApply | undefined;
    if (out && typeof out.spec === 'string' && out.spec.trim().length > 0) return out.spec;
  }
  return originalSpec;
}

/** Most recent REVIEW (or stub) pass, whose verdict/findings the corrector acts
 *  on and carries forward until the next review re-scores. */
function latestReview(previous: StepLoopPassRecord[]): SpecQualityApply | null {
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    const out = previous[i]?.applyOutput as SpecQualityApply | undefined;
    if (out && (out.source === 'review' || out.source === 'stub')) return out;
  }
  return null;
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

/** Highest-ranked prior REVIEW pass, or null when none yet. Only reviews carry a
 *  real assessment: corrector passes (amend-only) and stubs (parse-failure
 *  placeholders at a fixed neutral score 5) must never win the guard, or the
 *  loop freezes on a non-review state until the budget is spent. */
function bestPriorReview(previous: StepLoopPassRecord[]): SpecQualityApply | null {
  let best: SpecQualityApply | null = null;
  for (const p of previous) {
    const out = p.applyOutput as SpecQualityApply | undefined;
    if (!out || typeof out.score !== 'number' || typeof out.verdict !== 'string') continue;
    if (out.source !== 'review') continue;
    if (!best || iterationRank(out) > iterationRank(best)) best = out;
  }
  return best;
}

/** Renders the latest review's findings as a markdown bullet list to feed the
 *  corrector's prompt, so it validates and acts on those specific findings
 *  rather than re-reviewing from scratch. */
function formatPriorFindings(previous: StepLoopPassRecord[]): string {
  if (previous.length === 0) return '';
  const last = previous[previous.length - 1]?.applyOutput as SpecQualityApply | undefined;
  if (!last || last.findings.length === 0) return '';
  const lines = last.findings.map((f) => `- [${f.severity}] ${f.dimension}: ${f.comment}`);
  return ['', `=== Findings from iteration ${previous.length} ===`, ...lines].join('\n');
}

const REVIEW_RULES = [
  'You are the REVIEW phase of a spec quality workflow. A SEPARATE corrector agent',
  'applies the fixes — your job is ONLY to review, never to amend the spec.',
  'Review the draft specification as a senior engineer would before a human approves it.',
  `Score the spec against these dimensions: ${QUALITY_DIMENSIONS.join(', ')}.`,
  '',
  'Materiality bar — this review GATES implementation, it does not polish prose. Raise a',
  'finding ONLY when the issue would make the implementer build the WRONG thing, miss a',
  'requirement, or get blocked (e.g. missing/contradictory decisions, untestable acceptance',
  'criteria for core behavior, an ambiguity with several real candidates, a claim about code',
  'that is false). Do NOT raise findings for style, wording, tone, redundancy, formatting, or',
  '"could be clearer" polish — those burn the token budget on diminishing returns. When in',
  'doubt, leave it out.',
  '',
  'Severity — by IMPACT, not by how much you could nitpick:',
  '- error: a real gap or bug that would cause a wrong, incomplete, or blocked implementation.',
  '  These are the ONLY findings the review/correct loop keeps iterating on.',
  '- warn: a genuine but non-blocking gap worth a quick fix. Use sparingly; warns NEVER block',
  '  approval. Omit it rather than stretch to invent one.',
  '- Do NOT emit info / cosmetic / style findings at all.',
  '',
  'Codebase cross-check — for every file, function, or "follow the pattern from X" claim in',
  'the spec, confirm it actually exists and does what the spec says, in this order:',
  '1. `rag_search` FIRST — call the haive-rag tool with focused queries (symbol/component',
  '   names, the pattern referenced). It does a semantic + lexical search over the indexed',
  '   code AND knowledge base; prefer it over blind grepping.',
  '2. If rag_search returns nothing useful, READ the relevant `.claude/knowledge_base/` files.',
  '3. If still not enough, Grep / Read the codebase directly for the symbols you need.',
  'A reference to code that does not exist is a BLOCKING_AMBIGUITY.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{',
  '  "verdict": "APPROVED" | "NEEDS_REVISION" | "BLOCKING_AMBIGUITY",',
  '  "score": <integer 0-10>,',
  '  "findings": [ { "dimension": "<dimension or \\"ambiguity\\">", "severity": "warn|error", "comment": "<text; cite the spec section or file:line>" } ]',
  '}',
  'Do NOT include an amendedSpec — the corrector applies the fixes.',
  '',
  'Verdict rules — approve as soon as the spec is implementable; do not chase perfection:',
  '- APPROVED: no error findings and no blocking ambiguity — the spec can be implemented',
  '  without guessing wrong. Emit APPROVED even if minor warn notes remain; they must NOT',
  '  keep the loop running.',
  '- NEEDS_REVISION: at least one error-level gap exists that the corrector can fix.',
  "- BLOCKING_AMBIGUITY: the spec's intent itself is unclear (references missing code, or",
  '  "which X?" with several candidates) so a human must clarify — put the blocking',
  '  questions in findings.',
  'Score reflects overall readiness for gate 1. Cite a concrete spec section or file:line in',
  'every finding.',
] as const;

const CORRECT_RULES = [
  'You are the CORRECTION phase of a spec quality workflow. A SEPARATE reviewer agent',
  'produced the findings listed below against the current spec body.',
  '',
  'Do NOT blindly trust the reviewer. For EACH finding, FIRST validate it yourself against',
  'the actual spec text and the codebase: confirm the issue is real, correctly described,',
  'relevant to THIS spec, and not already addressed. To check the codebase, use this order:',
  '1. `rag_search` FIRST — query the haive-rag tool for the relevant symbols/patterns',
  '   (semantic + lexical search over the indexed code and knowledge base).',
  '2. If rag_search returns nothing useful, READ the relevant `.claude/knowledge_base/` files.',
  '3. If still not enough, Grep / Read the codebase directly.',
  'Apply a fix ONLY for findings you have validated as real and relevant. Ignore findings',
  'that are wrong, irrelevant, out of scope, or already handled — do not touch the spec for',
  'those. When you do fix something, edit the spec minimally and precisely; do not rewrite',
  'unrelated sections. Prioritize the error-level gaps (the real blockers); do not add',
  'stylistic polish, expand scope, or reword something that already works — that wastes',
  'budget without making the spec more implementable.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{',
  '  "amendedSpec": "<the FULL revised spec body — never a diff or partial snippet>",',
  '  "accepted": [ "<short ref to each finding you validated and fixed>" ],',
  '  "rejected": [ { "finding": "<short ref>", "reason": "<why you did not act on it>" } ]',
  '}',
  'If no finding is valid, return the current spec unchanged in amendedSpec with an empty',
  '"accepted" list. amendedSpec is REQUIRED.',
] as const;

export const phase0b5SpecQualityStep: StepDefinition<SpecQualityDetect, SpecQualityApply> = {
  metadata: {
    id: '05-phase-0b5-spec-quality',
    workflowType: 'workflow',
    index: 5,
    title: 'Phase 0b.5: Spec quality review',
    description:
      'Reviews the draft spec against 14 quality dimensions with one CLI, then corrects it with another (the corrector validates each finding before acting), looping until APPROVED or the budget.',
    requiresCli: false,
    cliRoles: STEP_CLI_ROLES['05-phase-0b5-spec-quality'],
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
        'Each round runs the Reviewer (detects issues) then the Corrector (validates and fixes',
        'the relevant ones), looping until APPROVED. Pick the two CLIs on the step card.',
        '',
        detected.specSummary || '(no summary available)',
      ].join('\n'),
      fields: [
        {
          type: 'select',
          id: 'maxIterations',
          label: 'Max review rounds (each round = 1 review + 1 correction)',
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
    // First pass (iteration 0) is always a REVIEW.
    buildPrompt: (args) => {
      const detected = args.detected as SpecQualityDetect;
      const values = args.formValues as { focusAreas?: string };
      return [
        ...REVIEW_RULES,
        '',
        `Focus areas: ${values.focusAreas ?? '(none)'}`,
        '',
        '=== Spec body ===',
        detected.spec || '(empty)',
      ].join('\n');
    },
  },

  loop: {
    // Budget in ROUNDS; each round = 2 passes (review + correct), so the runner
    // caps the loop at maxIterations * passesPerRound LLM passes.
    maxIterations: SPEC_QUALITY_DEFAULT_BUDGET,
    passesPerRound: 2,
    resolveRole: roleForIteration,
    shouldContinue: ({ applyOutput, iteration }) => {
      // After a correction (odd) always re-review (even) unless the runner's
      // budget stops us. After a review (even) keep going only while the reviewer
      // says NEEDS_REVISION; APPROVED is done, BLOCKING_AMBIGUITY needs a human.
      if (roleForIteration(iteration) === ROLE_CORRECTOR) return true;
      const out = applyOutput as SpecQualityApply;
      return out.verdict === 'NEEDS_REVISION';
    },
    buildIterationPrompt: ({ detected, formValues, iteration, previousIterations }) => {
      const det = detected as SpecQualityDetect;
      const values = formValues as { focusAreas?: string };
      const workingSpec = latestSpec(det.spec, previousIterations);
      if (roleForIteration(iteration) === ROLE_CORRECTOR) {
        return [
          ...CORRECT_RULES,
          '',
          `Focus areas: ${values.focusAreas ?? '(none)'}`,
          formatPriorFindings(previousIterations),
          '',
          '=== Current spec body ===',
          workingSpec || '(empty)',
        ].join('\n');
      }
      return [
        ...REVIEW_RULES,
        '',
        'Re-review the corrected spec below; assess only — amend nothing.',
        '',
        `Focus areas: ${values.focusAreas ?? '(none)'}`,
        '',
        '=== Current spec body (post-correction) ===',
        workingSpec || '(empty)',
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<SpecQualityApply> {
    const detected = args.detected as SpecQualityDetect;
    const workingSpec = latestSpec(detected.spec, args.previousIterations);

    // CORRECT pass: validate the latest review's findings and amend. The new
    // spec carries the prior review's verdict/findings forward as a placeholder
    // until the next review re-scores it.
    if (roleForIteration(args.iteration) === ROLE_CORRECTOR) {
      const correction = parseCorrectorOutput(args.llmOutput ?? null);
      const lastReview = latestReview(args.previousIterations);
      const amendedSpec =
        correction?.amendedSpec && correction.amendedSpec.trim().length > 0
          ? correction.amendedSpec
          : workingSpec;
      ctx.logger.info(
        {
          iteration: args.iteration,
          amended: Boolean(correction?.amendedSpec),
          source: 'correct',
        },
        'spec correction applied',
      );
      return {
        verdict: 'NEEDS_REVISION',
        score: lastReview?.score ?? 5,
        findings: lastReview?.findings ?? [],
        source: 'correct',
        spec: amendedSpec,
      };
    }

    // REVIEW pass: assess the working spec (never amends). Regression guard keeps
    // the higher-ranked prior REVIEW so a worse re-review can't lose better work.
    const parsed = parseSpecQualityOutput(args.llmOutput ?? null);
    if (parsed) {
      const current: SpecQualityApply = {
        verdict: parsed.verdict,
        score: parsed.score,
        findings: parsed.findings,
        source: 'review',
        spec: workingSpec,
      };
      const best = bestPriorReview(args.previousIterations);
      if (best && iterationRank(best) > iterationRank(current)) {
        ctx.logger.info(
          {
            iteration: args.iteration,
            verdict: current.verdict,
            score: current.score,
            keptVerdict: best.verdict,
            keptScore: best.score,
          },
          'spec quality review regressed — keeping the higher-ranked prior review',
        );
        return best;
      }
      ctx.logger.info(
        {
          iteration: args.iteration,
          verdict: current.verdict,
          score: current.score,
          findings: current.findings.length,
          source: 'review',
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
