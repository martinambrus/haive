import type { FormField, FormSchema } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import { parseJsonLoose } from '../_fenced-json.js';
import type { KbWrite } from './_kb-write.js';
import type { KbFileSummary, KnowledgeQaPrepApply } from './09-qa.js';
import type { EnrichedAgentQuestion, KnowledgeQaSuggestionsApply } from './09_1-qa-suggestions.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface AnswerRecord {
  question: string;
  answer: string;
  source: 'kb' | 'code' | 'user';
  citedFile?: string;
  /** Proposed KB section to write for this answer. Present for source `code`
   *  and `user` (the new section to add); absent for `kb` (already in the KB).
   *  09_2 does NOT write it — 09_3-qa-review applies confirmed proposals after
   *  the human reviews the answers. */
  proposedWrite?: KbWrite;
}

export interface UnansweredRecord {
  question: string;
  reason: string;
}

export interface KnowledgeQaResolveDetect {
  agentQuestions: EnrichedAgentQuestion[];
  explicitNoQuestions: boolean;
  kbFiles: KbFileSummary[];
}

export interface KnowledgeQaResolveApply {
  userQuestionCount: number;
  agentQuestionCount: number;
  answers: AnswerRecord[];
  unanswered: UnansweredRecord[];
}

const USER_QUESTIONS_FIELD = 'userQuestions';
const AGENT_ANSWER_PREFIX = 'agentAnswer__';
const AGENT_QUESTIONS_ACCORDION_ID = 'agent-questions';

/* ------------------------------------------------------------------ */
/* Form generation                                                     */
/* ------------------------------------------------------------------ */

function userQuestionsField(hasAgentQuestions: boolean): FormField {
  const intro = hasAgentQuestions
    ? 'Now ask the LLM your own questions about the project.'
    : 'The LLM had no agent questions. You can still ask it about anything in the project.';
  return {
    type: 'textarea',
    id: USER_QUESTIONS_FIELD,
    label: 'Your questions for the LLM (one per line, no cap)',
    description: [
      intro,
      'For each question, the LLM will: (1) check the knowledge base; (2) if the answer is not there, scan the code; (3) propose a knowledge-base section with the answer. You review and confirm or correct every answer in the next step before anything is written.',
      '',
      'Examples of useful questions:',
      '- How will the state of an order change if only a single product in the order is marked as delivered?',
      '- Which records (with what attributes) get filtered out from the products table by the default scope?',
    ].join('\n'),
    rows: 8,
    placeholder:
      'How does X work? What happens when Y? Why is Z designed this way?\n(One question per line.)',
  };
}

export function buildResolveForm(detected: KnowledgeQaResolveDetect): FormSchema {
  const fields: FormField[] = [];

  if (detected.agentQuestions.length === 0) {
    fields.push(userQuestionsField(false));
    const noteSuffix = detected.explicitNoQuestions
      ? 'The LLM reviewed the repository and the existing knowledge base and reports it had no targeted questions for you. You can still ask it your own questions below.'
      : 'No agent questions were produced. Ask your own questions below.';
    return {
      title: 'Knowledge base Q&A',
      description: noteSuffix,
      fields,
      submitLabel: 'Find answers',
    };
  }

  const accordionItems = detected.agentQuestions.map((q) => {
    const itemDescription = [
      `Topic: ${q.topic}`,
      `Context: ${q.context}`,
      q.suggestedKbFile ? `Suggested KB file: ${q.suggestedKbFile}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const predefined = q.suggestedAnswers.map((text) => ({ value: text, label: text }));
    return {
      title: q.question,
      description: itemDescription,
      fields: [
        {
          type: 'radio-with-textarea' as const,
          id: `${AGENT_ANSWER_PREFIX}${q.id}`,
          label: 'Your answer',
          predefined,
          customLabel: 'Custom answer',
          placeholder: 'Type your answer (or leave blank to skip).',
          rows: 4,
        },
      ],
    };
  });

  fields.push({
    type: 'accordion',
    id: AGENT_QUESTIONS_ACCORDION_ID,
    label: `Agent questions (${detected.agentQuestions.length})`,
    description:
      'Click a row to expand. Answer any you have context for; leave the rest blank. All start collapsed.',
    items: accordionItems,
  });
  fields.push(userQuestionsField(true));

  return {
    title: 'Knowledge base Q&A',
    description: `The LLM identified ${detected.agentQuestions.length} ambiguous areas. Expand any to answer; leave the rest collapsed. Then ask your own questions in the bottom textarea.`,
    fields,
    submitLabel: 'Find answers',
  };
}

/* ------------------------------------------------------------------ */
/* User question parsing                                               */
/* ------------------------------------------------------------------ */

export function splitUserQuestions(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface AgentAnswerPair {
  question: EnrichedAgentQuestion;
  answer: string;
}

/** Reads the user's answer for each agent question. The form value is a single
 *  string — either one of the question's `suggestedAnswers` (picked via radio)
 *  or a free-text custom answer. Empty/whitespace strings are treated as
 *  skipped and excluded from the returned pairs. */
export function collectAgentAnswers(
  questions: EnrichedAgentQuestion[],
  values: Record<string, unknown>,
): AgentAnswerPair[] {
  const pairs: AgentAnswerPair[] = [];
  for (const q of questions) {
    const raw = values[`${AGENT_ANSWER_PREFIX}${q.id}`];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    pairs.push({ question: q, answer: trimmed });
  }
  return pairs;
}

/* ------------------------------------------------------------------ */
/* LLM prompt                                                          */
/* ------------------------------------------------------------------ */

function buildPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as KnowledgeQaResolveDetect;
  const values = args.formValues as Record<string, unknown>;
  const userQuestions = splitUserQuestions(values[USER_QUESTIONS_FIELD]);
  const agentAnswers = collectAgentAnswers(detected.agentQuestions, values);

  const kbList =
    detected.kbFiles.length > 0
      ? detected.kbFiles.map((f) => `- ${f.relPath} — ${f.title}`).join('\n')
      : '(no knowledge base files yet — create new ones as needed)';

  const userQuestionsBlock =
    userQuestions.length > 0 ? userQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(none)';

  const agentAnswersBlock =
    agentAnswers.length > 0
      ? agentAnswers
          .map(
            (p) =>
              `### Topic: ${p.question.topic}\nQuestion: ${p.question.question}\nUser answer:\n${p.answer}`,
          )
          .join('\n\n')
      : '(none)';

  return [
    'You are a senior software engineer resolving knowledge gaps in a project.',
    'Two inputs from the user are below: (a) answers to questions YOU asked in the previous step,',
    '(b) brand-new questions the user is asking YOU.',
    '',
    'For every question produce an ANSWER and, when the answer should be saved, a PROPOSED',
    'knowledge-base write. Do NOT write any files yourself — emit the proposed write inline. It is',
    'applied only AFTER the user reviews and confirms your answers in the next step.',
    '',
    'For (a): the user supplied the answer — echo it as the answer with source "user" and propose a',
    'KB section containing it.',
    'For (b): for each user question, follow this lookup chain:',
    '  1. Search the KB files listed below. If the answer is already there, set source "kb", reference',
    '     the file in citedFile, and OMIT proposedWrite (it is already saved).',
    '  2. If not in KB, use your file-reading tools to search the codebase. If found, set source',
    '     "code", cite the file you read in citedFile, and include a proposedWrite with the new section.',
    '  3. If neither KB nor code can answer, add the question to "unanswered" with a brief reason.',
    '',
    'Call your file-reading tools DIRECTLY — issue the actual tool calls; do NOT narrate intent',
    '("Let me check…") and then end your turn without a tool call or the final JSON.',
    '',
    '## Existing knowledge base files',
    kbList,
    '',
    '## (a) Agent questions answered by the user',
    agentAnswersBlock,
    '',
    '## (b) New questions from the user',
    userQuestionsBlock,
    '',
    '## Output format',
    '',
    'Emit exactly ONE JSON object inside a ```json fenced code block:',
    '```',
    '{',
    '  "answers": [',
    '    {',
    '      "question": "<the user question or agent question text>",',
    '      "answer": "<the actual answer>",',
    '      "source": "kb | code | user",',
    '      "citedFile": ".claude/knowledge_base/BUSINESS_LOGIC.md",',
    '      "proposedWrite": {',
    '        "relPath": "BUSINESS_LOGIC.md",',
    '        "section": "Order partial-delivery semantics",',
    '        "content": "Multi-paragraph markdown content to APPEND under a new H2 heading."',
    '      }',
    '    }',
    '  ],',
    '  "unanswered": [',
    '    { "question": "<question text>", "reason": "<why no answer was possible>" }',
    '  ]',
    '}',
    '```',
    '',
    'Field rules:',
    '- answers.source: `kb` if the answer was already in the KB (then OMIT proposedWrite); `code` if you',
    '  found it in the code; `user` for agent questions answered by the user.',
    '- answers.proposedWrite: REQUIRED for source `code` and `user`; OMITTED for source `kb`.',
    '- proposedWrite.relPath: path RELATIVE to `.claude/knowledge_base/`. No `..`, no leading `/`.',
    '  Pick an existing file when possible (see list above); only create new files when no existing',
    '  file fits. New files belong under `QA/<slug>.md` unless a canonical home is obvious.',
    '- proposedWrite.section: an H2 heading that will be appended to the file (do not include the `## ` prefix).',
    '- proposedWrite.content: markdown body for that section. No leading/trailing blank lines.',
    '- unanswered: include any user question for which neither KB nor code provided an answer.',
    '',
    'Constraints:',
    `- ${detected.agentQuestions.length} agent questions were posed; ${agentAnswers.length} were answered. Only the answered ones need processing.`,
    `- ${userQuestions.length} new user questions to process.`,
    '- Do not emit prose outside the fenced JSON block.',
    '- An empty JSON object (no answers) is acceptable ONLY if both input lists were empty.',
    '- Your FINAL message MUST be the ```json block — never narration or a tool result.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* LLM output parsing                                                  */
/* ------------------------------------------------------------------ */

export class QaResolveParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaResolveParseError';
  }
}

interface ParsedResolve {
  answers: AnswerRecord[];
  unanswered: UnansweredRecord[];
}

export function parseQaResolveOutput(raw: unknown): ParsedResolve {
  let source: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'result' in (raw as Record<string, unknown>)) {
    source = (raw as Record<string, unknown>).result;
  }
  let parsed: unknown;
  if (typeof source === 'string') {
    parsed = parseJsonLoose(source);
    if (parsed === null) {
      throw new QaResolveParseError('No parseable JSON object found in LLM output');
    }
  } else if (typeof source === 'object' && source !== null) {
    parsed = source;
  } else {
    throw new QaResolveParseError('LLM output is empty or not parseable');
  }
  return validateResolve(parsed);
}

/** Parse an answer's optional `proposedWrite`. Required for source `code`/`user`
 *  (the new section to add), absent/ignored for `kb` (already in the KB). */
function parseProposedWrite(raw: unknown, source: 'kb' | 'code' | 'user'): KbWrite | undefined {
  if (raw === undefined || raw === null) {
    if (source === 'kb') return undefined;
    throw new QaResolveParseError(`answers.proposedWrite required for source "${source}"`);
  }
  if (typeof raw !== 'object') {
    throw new QaResolveParseError('answers.proposedWrite must be an object');
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.relPath !== 'string' || v.relPath.length === 0) {
    throw new QaResolveParseError('answers.proposedWrite.relPath missing or empty');
  }
  if (typeof v.section !== 'string' || v.section.length === 0) {
    throw new QaResolveParseError('answers.proposedWrite.section missing or empty');
  }
  if (typeof v.content !== 'string' || v.content.length === 0) {
    throw new QaResolveParseError('answers.proposedWrite.content missing or empty');
  }
  return { relPath: v.relPath, section: v.section, content: v.content };
}

function validateResolve(parsed: unknown): ParsedResolve {
  if (!parsed || typeof parsed !== 'object') {
    throw new QaResolveParseError('LLM output is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const answersRaw = obj.answers ?? [];
  const unansweredRaw = obj.unanswered ?? [];
  if (!Array.isArray(answersRaw) || !Array.isArray(unansweredRaw)) {
    throw new QaResolveParseError('"answers" and "unanswered" must be arrays');
  }

  const answers: AnswerRecord[] = [];
  for (const item of answersRaw as unknown[]) {
    if (!item || typeof item !== 'object') {
      throw new QaResolveParseError('answers entry is not an object');
    }
    const v = item as Record<string, unknown>;
    if (typeof v.question !== 'string' || typeof v.answer !== 'string') {
      throw new QaResolveParseError('answers.question and answers.answer must be strings');
    }
    if (v.source !== 'kb' && v.source !== 'code' && v.source !== 'user') {
      throw new QaResolveParseError('answers.source must be one of kb|code|user');
    }
    if (v.citedFile !== undefined && typeof v.citedFile !== 'string') {
      throw new QaResolveParseError('answers.citedFile must be a string when present');
    }
    const proposedWrite = parseProposedWrite(v.proposedWrite, v.source);
    answers.push({
      question: v.question,
      answer: v.answer,
      source: v.source,
      ...(typeof v.citedFile === 'string' ? { citedFile: v.citedFile } : {}),
      ...(proposedWrite ? { proposedWrite } : {}),
    });
  }

  const unanswered: UnansweredRecord[] = [];
  for (const item of unansweredRaw as unknown[]) {
    if (!item || typeof item !== 'object') {
      throw new QaResolveParseError('unanswered entry is not an object');
    }
    const v = item as Record<string, unknown>;
    if (typeof v.question !== 'string' || typeof v.reason !== 'string') {
      throw new QaResolveParseError('unanswered.question and unanswered.reason must be strings');
    }
    unanswered.push({ question: v.question, reason: v.reason });
  }

  return { answers, unanswered };
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const knowledgeQaResolveStep: StepDefinition<
  KnowledgeQaResolveDetect,
  KnowledgeQaResolveApply
> = {
  metadata: {
    id: '09_2-qa-resolve',
    workflowType: 'onboarding',
    index: 10.5,
    title: 'Knowledge base Q&A — find answers',
    description:
      'You answer the LLM questions from the previous step (optional) and ask your own questions. The LLM checks the knowledge base, scans the code if needed, and PROPOSES KB sections. Nothing is written yet — you confirm or correct each answer in the next step.',
    requiresCli: true,
  },

  async detect(ctx: StepContext): Promise<KnowledgeQaResolveDetect> {
    const prep = await loadPreviousStepOutput(ctx.db, ctx.taskId, '09-qa');
    const prepOutput = (prep?.output ?? null) as KnowledgeQaPrepApply | null;
    const explicitNoQuestions = prepOutput?.explicitNoQuestions ?? false;

    const prepDetect = (prep?.detect ?? null) as { kbFiles?: KbFileSummary[] } | null;
    const kbFiles = prepDetect?.kbFiles ?? [];

    const enriched = await loadPreviousStepOutput(ctx.db, ctx.taskId, '09_1-qa-suggestions');
    const enrichedOutput = (enriched?.output ?? null) as KnowledgeQaSuggestionsApply | null;
    const agentQuestions: EnrichedAgentQuestion[] =
      enrichedOutput?.enrichedQuestions ??
      (prepOutput?.agentQuestions ?? []).map((q) => ({ ...q, suggestedAnswers: [] }));

    ctx.logger.info(
      { agentQuestionCount: agentQuestions.length, kbFileCount: kbFiles.length },
      'qa-resolve detect complete',
    );
    return { agentQuestions, explicitNoQuestions, kbFiles };
  },

  form(_ctx, detected): FormSchema {
    return buildResolveForm(detected);
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    buildPrompt,
    timeoutMs: 60 * 60 * 1000,
    retry: { maxAttempts: 3, retryOn: (err) => err instanceof QaResolveParseError },
    bypassStub: () => ({ answers: [], unanswered: [] }),
  },

  async apply(ctx, args): Promise<KnowledgeQaResolveApply> {
    const detected = args.detected as KnowledgeQaResolveDetect;
    const values = args.formValues as Record<string, unknown>;
    const parsed = parseQaResolveOutput(args.llmOutput);
    const userQuestionCount = splitUserQuestions(values[USER_QUESTIONS_FIELD]).length;
    const agentQuestionCount = collectAgentAnswers(detected.agentQuestions, values).length;

    ctx.logger.info(
      {
        userQuestionCount,
        agentQuestionCount,
        answerCount: parsed.answers.length,
        unansweredCount: parsed.unanswered.length,
        proposedWriteCount: parsed.answers.filter((a) => a.proposedWrite).length,
      },
      'qa-resolve apply complete (answers gathered; KB write deferred to 09_3-qa-review)',
    );

    return {
      userQuestionCount,
      agentQuestionCount,
      answers: parsed.answers,
      unanswered: parsed.unanswered,
    };
  },
};
