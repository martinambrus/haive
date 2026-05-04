import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import type { AgentQuestion, KnowledgeQaPrepApply } from './09-qa.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface EnrichedAgentQuestion extends AgentQuestion {
  suggestedAnswers: string[];
}

export interface KnowledgeQaSuggestionsDetect {
  framework: string | null;
  language: string | null;
  agentQuestions: AgentQuestion[];
}

export interface KnowledgeQaSuggestionsApply {
  enrichedQuestions: EnrichedAgentQuestion[];
}

interface SuggestionEntry {
  questionId: string;
  suggestedAnswers: string[];
}

const MAX_SUGGESTIONS_PER_QUESTION = 4;
const MAX_SUGGESTION_LENGTH = 160;

/* ------------------------------------------------------------------ */
/* LLM prompt                                                          */
/* ------------------------------------------------------------------ */

function buildPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as KnowledgeQaSuggestionsDetect;

  if (detected.agentQuestions.length === 0) {
    return [
      'No agent questions to enrich. Emit an empty suggestions array:',
      '```json',
      '{ "suggestions": [] }',
      '```',
    ].join('\n');
  }

  const questionsBlock = detected.agentQuestions
    .map((q, i) => {
      return [
        `### ${i + 1}. [${q.topic}] (id: ${q.id})`,
        `Question: ${q.question}`,
        `Context: ${q.context}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are a senior software engineer helping a user answer questions about their codebase.',
    'For each question below, propose 0 to 4 short candidate answers — phrasings the user could click instead of typing.',
    'The user always has a free-text fallback, so suggestions need not cover every case. Quality over quantity.',
    '',
    '## Project context',
    `Framework: ${detected.framework ?? 'unknown'}`,
    `Language: ${detected.language ?? 'unknown'}`,
    '',
    '## Questions',
    questionsBlock,
    '',
    '## Output format',
    '',
    'Emit exactly ONE JSON object inside a ```json fenced code block:',
    '```',
    '{',
    '  "suggestions": [',
    '    {',
    '      "questionId": "<id from above>",',
    '      "suggestedAnswers": ["short answer 1", "short answer 2"]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Constraints:',
    `- 0 to ${MAX_SUGGESTIONS_PER_QUESTION} suggestions per question (0 OK when no plausible candidates exist).`,
    `- Each suggestion should be a short clickable label, ideally under 80 chars and never over ${MAX_SUGGESTION_LENGTH}; over-length entries will be dropped.`,
    '- Distinct strings only (no duplicates within a question).',
    '- Use the exact `id` from each question header above.',
    '- Do not emit prose outside the fenced JSON block.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* LLM output parsing                                                  */
/* ------------------------------------------------------------------ */

export class QaSuggestionsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaSuggestionsParseError';
  }
}

export function parseQaSuggestionsOutput(raw: unknown): SuggestionEntry[] {
  let source: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'result' in (raw as Record<string, unknown>)) {
    source = (raw as Record<string, unknown>).result;
  }
  let parsed: unknown;
  if (typeof source === 'string') {
    const fenceRe = /```json\s*([\s\S]*?)```/;
    const match = fenceRe.exec(source);
    if (!match || !match[1]) {
      throw new QaSuggestionsParseError('No ```json fenced block found in LLM output');
    }
    try {
      parsed = JSON.parse(match[1]);
    } catch (err) {
      throw new QaSuggestionsParseError(
        `JSON parse error in LLM output: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (typeof source === 'object' && source !== null) {
    parsed = source;
  } else {
    throw new QaSuggestionsParseError('LLM output is empty or not parseable');
  }
  return validateSuggestions(parsed);
}

function validateSuggestions(parsed: unknown): SuggestionEntry[] {
  if (!parsed || typeof parsed !== 'object') {
    throw new QaSuggestionsParseError('LLM output is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const list = obj.suggestions ?? [];
  if (!Array.isArray(list)) {
    throw new QaSuggestionsParseError('"suggestions" must be an array');
  }
  const out: SuggestionEntry[] = [];
  for (const item of list as unknown[]) {
    if (!item || typeof item !== 'object') {
      throw new QaSuggestionsParseError('suggestion entry is not an object');
    }
    const v = item as Record<string, unknown>;
    if (typeof v.questionId !== 'string' || v.questionId.length === 0) {
      throw new QaSuggestionsParseError('suggestion.questionId missing or empty');
    }
    if (!Array.isArray(v.suggestedAnswers)) {
      throw new QaSuggestionsParseError(
        `suggestion.suggestedAnswers for "${v.questionId}" must be an array`,
      );
    }
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const ans of v.suggestedAnswers as unknown[]) {
      if (typeof ans !== 'string') continue;
      const trimmed = ans.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length > MAX_SUGGESTION_LENGTH) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleaned.push(trimmed);
      if (cleaned.length >= MAX_SUGGESTIONS_PER_QUESTION) break;
    }
    out.push({ questionId: v.questionId, suggestedAnswers: cleaned });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const knowledgeQaSuggestionsStep: StepDefinition<
  KnowledgeQaSuggestionsDetect,
  KnowledgeQaSuggestionsApply
> = {
  metadata: {
    id: '09_1-qa-suggestions',
    workflowType: 'onboarding',
    index: 10.25,
    title: 'Knowledge base Q&A — suggested answers',
    description:
      'For each agent question generated in the previous step, the LLM proposes short candidate answers the user can click instead of typing.',
    requiresCli: true,
  },

  async detect(ctx: StepContext): Promise<KnowledgeQaSuggestionsDetect> {
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (
      envPrev?.detect as {
        data?: { project?: { framework?: string; primaryLanguage?: string } };
      } | null
    )?.data;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;

    const prep = await loadPreviousStepOutput(ctx.db, ctx.taskId, '09-qa');
    const prepOutput = (prep?.output ?? null) as KnowledgeQaPrepApply | null;
    const agentQuestions = prepOutput?.agentQuestions ?? [];

    ctx.logger.info(
      { framework, language, questionCount: agentQuestions.length },
      'qa-suggestions detect complete',
    );
    return { framework, language, agentQuestions };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    buildPrompt,
    timeoutMs: 30 * 60 * 1000,
    skipIf: (args) => {
      const detected = args.detected as KnowledgeQaSuggestionsDetect;
      return detected.agentQuestions.length === 0;
    },
    bypassStub: (args) => {
      const detected = args.detected as KnowledgeQaSuggestionsDetect;
      return {
        suggestions: detected.agentQuestions.map((q) => ({
          questionId: q.id,
          suggestedAnswers: [],
        })),
      };
    },
  },

  async apply(ctx, args): Promise<KnowledgeQaSuggestionsApply> {
    const detected = args.detected as KnowledgeQaSuggestionsDetect;
    const suggestions =
      args.llmOutput === undefined ? [] : parseQaSuggestionsOutput(args.llmOutput);

    const byId = new Map(suggestions.map((s) => [s.questionId, s.suggestedAnswers]));
    const enrichedQuestions: EnrichedAgentQuestion[] = detected.agentQuestions.map((q) => ({
      ...q,
      suggestedAnswers: byId.get(q.id) ?? [],
    }));

    ctx.logger.info(
      {
        questionCount: enrichedQuestions.length,
        suggestionsTotal: enrichedQuestions.reduce((n, q) => n + q.suggestedAnswers.length, 0),
      },
      'qa-suggestions apply complete',
    );
    return { enrichedQuestions };
  },
};
