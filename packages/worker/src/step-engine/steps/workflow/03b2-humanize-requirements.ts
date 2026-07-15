import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { parseBizReqOutput } from './03b-business-requirements.js';
import { agentDefinitionGuidance } from '../_retrieval-guidance.js';

// Phase 1 humanization (legacy phase2-humanization). Between the business-
// requirements draft (03b) and its review (03c), a markdown-humanizer agent
// polishes the draft: fix grammar/spelling/punctuation and ALL missing diacritics
// (Slovak/Czech/Polish etc.), improve readability and structure — in the
// document's OWN language, never translating, never changing a requirement. The
// step auto-runs (no gate): the human review is at 03c, which reads the humanized
// version. Auto-skips when 03b produced nothing. Scope is the business-
// requirements doc only — the technical spec is intentionally not humanized.

interface HumanizeDetect {
  taskTitle: string;
  /** The raw business-requirements draft from 03b (the input to humanize). */
  sourceRequirements: string;
  sourceSummary: string;
}

interface HumanizeApply {
  requirements: string;
  summary: string;
  /** 'llm' = humanized; 'passthrough' = humanization was unusable so 03b's draft
   *  is passed through unchanged (never drop the doc). */
  source: 'llm' | 'passthrough';
}

/** Read 03b's raw draft directly (NOT loadBusinessRequirements, which prefers this
 *  step's own output and would be circular/stale here). */
async function loadSourceRequirements(
  ctx: StepContext,
): Promise<{ requirements: string; summary: string }> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03b-business-requirements');
  const out = prev?.output as { requirements?: string; summary?: string } | null;
  return { requirements: out?.requirements ?? '', summary: out?.summary ?? '' };
}

const PERSONA = [
  'You are the Markdown Humanizer. Rewrite the document into clear, readable prose in its OWN',
  'language — detect the language and NEVER translate. Correct grammar, orthography, punctuation,',
  'and case/declension, and add EVERY missing diacritic (e.g. Slovak, Czech, Polish). Improve the',
  'structure and explain the "why", but preserve every detail and never change the meaning.',
] as const;

export const humanizeRequirementsStep: StepDefinition<HumanizeDetect, HumanizeApply> = {
  metadata: {
    id: '03b2-humanize-requirements',
    workflowType: 'workflow',
    index: 3.55,
    title: 'Phase 1: Humanize requirements',
    description:
      'Polishes the business-requirements draft for grammar, spelling, diacritics, and readability in its own language (never translating, never changing requirements). Runs automatically; the result is reviewed at the next step. Auto-skips when no requirements were drafted.',
    requiresCli: false,
  },

  // Auto-skip when 03b produced no requirements (its gate was skipped or it
  // returned an empty/stub doc). Mirrors 03c's skip-both behaviour.
  async shouldRun(ctx: StepContext): Promise<boolean> {
    const src = await loadSourceRequirements(ctx);
    return src.requirements.trim().length > 0;
  },

  async detect(ctx: StepContext): Promise<HumanizeDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const src = await loadSourceRequirements(ctx);
    return {
      taskTitle: meta.title,
      sourceRequirements: src.requirements,
      sourceSummary: src.summary,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 30 * 60 * 1000,
    buildPrompt: (args) => {
      const d = args.detected as HumanizeDetect;
      return [
        agentDefinitionGuidance(
          'markdown-humanizer',
          [
            'If a `.claude/agents/markdown-humanizer.md` agent definition exists in the repo, follow it;',
            'otherwise follow the protocol below.',
          ].join('\n'),
        ),
        ...PERSONA,
        '',
        'Humanize the business-requirements document below. Fix ALL grammar, spelling, punctuation,',
        'and missing diacritics, and improve readability and structure. PRESERVE the original',
        'language — never translate. PRESERVE every requirement and acceptance criterion — do not',
        'add, drop, or change meaning. Do NOT edit code and do NOT run git.',
        '',
        '=== Business requirements to humanize ===',
        d.sourceRequirements || '(none)',
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "requirements": "<the humanized requirements document as markdown>", "summary": "<one-line summary>" }',
      ].join('\n');
    },
    bypassStub: (args) => {
      const d = args.detected as HumanizeDetect;
      return {
        requirements: d.sourceRequirements || '# Requirements\n\n(bypass stub)',
        summary: 'bypass stub',
      };
    },
    retry: { maxAttempts: 3, retryOn: (e) => e instanceof RetryableParseError },
  },

  form(_ctx, detected): FormSchema {
    const infoSections: InfoSection[] = [
      {
        title: 'Requirements being humanized',
        preview: detected.sourceSummary || `${detected.sourceRequirements.length} chars`,
        body: detected.sourceRequirements || '(none)',
      },
    ];
    return {
      title: 'Phase 1: Humanize requirements',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        'The business-requirements draft is being polished for grammar, diacritics, and readability',
        'in its own language. You review the result at the next step.',
      ].join('\n'),
      infoSections,
      fields: [],
      submitLabel: 'Continue',
      // No decision here — humanization is automatic and the review is at 03c. The
      // form auto-submits even in manual mode so the pass never blocks the pipeline.
      autoSubmit: true,
    };
  },

  async apply(ctx, args): Promise<HumanizeApply> {
    const parsed = parseBizReqOutput(args.llmOutput ?? null);
    if (parsed && parsed.requirements.trim().length > 0) {
      ctx.logger.info({ source: 'llm' }, 'business requirements humanized');
      return { requirements: parsed.requirements, summary: parsed.summary, source: 'llm' };
    }
    if (!args.isFinalLlmAttempt) {
      throw new RetryableParseError('humanized requirements output unparseable — retrying');
    }
    // Never drop the document: fall back to 03b's draft so 03c/04 still have it.
    ctx.logger.warn('humanization output unusable; passing the original requirements through');
    return {
      requirements: args.detected.sourceRequirements,
      summary: args.detected.sourceSummary,
      source: 'passthrough',
    };
  },
};
