import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormField, FormSchema } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from './_helpers.js';
import type { AgentQuestion, KbFileSummary, KnowledgeQaPrepApply } from './09-qa.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface KbWrite {
  /** Path relative to `.claude/knowledge_base/`. Sanitized in apply. */
  relPath: string;
  section: string;
  content: string;
}

export interface AnswerRecord {
  question: string;
  answer: string;
  source: 'kb' | 'code' | 'user';
  citedFile?: string;
}

export interface UnansweredRecord {
  question: string;
  reason: string;
}

export interface KnowledgeQaResolveDetect {
  agentQuestions: AgentQuestion[];
  explicitNoQuestions: boolean;
  kbFiles: KbFileSummary[];
}

export interface KnowledgeQaResolveApply {
  kbWritten: { relPath: string; section: string }[];
  kbSkipped: { relPath: string; reason: string }[];
  userQuestionCount: number;
  agentQuestionCount: number;
  answers: AnswerRecord[];
  unanswered: UnansweredRecord[];
}

const USER_QUESTIONS_FIELD = 'userQuestions';
const AGENT_ANSWER_PREFIX = 'agentAnswer__';
const KB_ROOT = path.join('.claude', 'knowledge_base');

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
      'For each question, the LLM will: (1) check the knowledge base; (2) if the answer is not there, scan the code; (3) write a knowledge-base section with the answer so every later task inherits it.',
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
      submitLabel: 'Submit and update KB',
    };
  }

  for (const q of detected.agentQuestions) {
    const desc = [
      q.question,
      '',
      `Context: ${q.context}`,
      q.suggestedKbFile ? `Suggested KB file: ${q.suggestedKbFile}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    fields.push({
      type: 'textarea',
      id: `${AGENT_ANSWER_PREFIX}${q.id}`,
      label: q.topic,
      description: desc,
      rows: 4,
      placeholder: 'Your answer (leave blank to skip this question).',
    });
  }
  fields.push(userQuestionsField(true));

  return {
    title: 'Knowledge base Q&A',
    description: `The LLM identified ${detected.agentQuestions.length} ambiguous areas. Answer any you have context for; leave the rest blank. Then ask your own questions in the bottom textarea.`,
    fields,
    submitLabel: 'Submit and update KB',
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
  question: AgentQuestion;
  answer: string;
}

export function collectAgentAnswers(
  questions: AgentQuestion[],
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
    'Your job is to update the knowledge base so that every later task inherits this knowledge.',
    'For (a): write the user-supplied answer into the appropriate KB file as a new section.',
    'For (b): for each user question, follow this lookup chain:',
    '  1. Search the KB files listed below. If the answer is already there, reference the file in your answer (no KB write needed).',
    '  2. If not in KB, use your file-reading tools to search the codebase. If found, write a new KB section with the answer.',
    '  3. If neither KB nor code can answer, mark the question as unanswered with a brief reason.',
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
    '  "kbWrites": [',
    '    {',
    '      "relPath": "BUSINESS_LOGIC.md",',
    '      "section": "Order partial-delivery semantics",',
    '      "content": "Multi-paragraph markdown content to APPEND under a new H2 heading."',
    '    }',
    '  ],',
    '  "answers": [',
    '    {',
    '      "question": "<the user question or agent question text>",',
    '      "answer": "<the actual answer>",',
    '      "source": "kb | code | user",',
    '      "citedFile": ".claude/knowledge_base/BUSINESS_LOGIC.md"',
    '    }',
    '  ],',
    '  "unanswered": [',
    '    { "question": "<question text>", "reason": "<why no answer was possible>" }',
    '  ]',
    '}',
    '```',
    '',
    'Field rules:',
    '- kbWrites.relPath: path RELATIVE to `.claude/knowledge_base/`. No `..`, no leading `/`.',
    '  Pick an existing file when possible (see list above); only create new files when no existing',
    '  file fits. New files belong under `QA/<slug>.md` unless a canonical home is obvious.',
    '- kbWrites.section: an H2 heading that will be appended to the file (do not include the `## ` prefix).',
    '- kbWrites.content: markdown body for that section. No leading/trailing blank lines.',
    '- answers.source: `kb` if the answer was already in the KB; `code` if you found it in the code',
    '  (and produced a kbWrites entry for it); `user` for agent questions answered by the user.',
    '- unanswered: include any user question for which neither KB nor code provided an answer.',
    '',
    'Constraints:',
    `- ${detected.agentQuestions.length} agent questions were posed; ${agentAnswers.length} were answered. Only the answered ones need processing.`,
    `- ${userQuestions.length} new user questions to process.`,
    '- Do not emit prose outside the fenced JSON block.',
    '- An empty JSON object (no kbWrites, no answers) is acceptable ONLY if both input lists were empty.',
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
  kbWrites: KbWrite[];
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
    const fenceRe = /```json\s*([\s\S]*?)```/;
    const match = fenceRe.exec(source);
    if (!match || !match[1]) {
      throw new QaResolveParseError('No ```json fenced block found in LLM output');
    }
    try {
      parsed = JSON.parse(match[1]);
    } catch (err) {
      throw new QaResolveParseError(
        `JSON parse error in LLM output: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (typeof source === 'object' && source !== null) {
    parsed = source;
  } else {
    throw new QaResolveParseError('LLM output is empty or not parseable');
  }
  return validateResolve(parsed);
}

function validateResolve(parsed: unknown): ParsedResolve {
  if (!parsed || typeof parsed !== 'object') {
    throw new QaResolveParseError('LLM output is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const kbWritesRaw = obj.kbWrites ?? [];
  const answersRaw = obj.answers ?? [];
  const unansweredRaw = obj.unanswered ?? [];
  if (!Array.isArray(kbWritesRaw) || !Array.isArray(answersRaw) || !Array.isArray(unansweredRaw)) {
    throw new QaResolveParseError('"kbWrites", "answers", and "unanswered" must be arrays');
  }

  const kbWrites: KbWrite[] = [];
  for (const item of kbWritesRaw as unknown[]) {
    if (!item || typeof item !== 'object') {
      throw new QaResolveParseError('kbWrites entry is not an object');
    }
    const v = item as Record<string, unknown>;
    if (typeof v.relPath !== 'string' || v.relPath.length === 0) {
      throw new QaResolveParseError('kbWrites.relPath missing or empty');
    }
    if (typeof v.section !== 'string' || v.section.length === 0) {
      throw new QaResolveParseError('kbWrites.section missing or empty');
    }
    if (typeof v.content !== 'string' || v.content.length === 0) {
      throw new QaResolveParseError('kbWrites.content missing or empty');
    }
    kbWrites.push({ relPath: v.relPath, section: v.section, content: v.content });
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
    answers.push({
      question: v.question,
      answer: v.answer,
      source: v.source,
      ...(typeof v.citedFile === 'string' ? { citedFile: v.citedFile } : {}),
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

  return { kbWrites, answers, unanswered };
}

/* ------------------------------------------------------------------ */
/* KB write execution                                                  */
/* ------------------------------------------------------------------ */

export interface SafeRelPath {
  ok: true;
  normalized: string;
}
export interface UnsafeRelPath {
  ok: false;
  reason: string;
}
export type RelPathCheck = SafeRelPath | UnsafeRelPath;

/** Reject paths that escape the KB dir or contain unsafe segments. */
export function sanitizeKbRelPath(rel: string): RelPathCheck {
  if (typeof rel !== 'string' || rel.length === 0) {
    return { ok: false, reason: 'empty path' };
  }
  if (rel.startsWith('/') || rel.startsWith('\\')) {
    return { ok: false, reason: 'absolute path not allowed' };
  }
  // Strip a leading `.claude/knowledge_base/` if the LLM included it.
  let normalized = rel.replace(/^\.claude[/\\]knowledge_base[/\\]/, '');
  if (normalized.length === 0) {
    return { ok: false, reason: 'empty after stripping KB prefix' };
  }
  const parts = normalized.split(/[\\/]/);
  if (parts.some((p) => p === '..' || p === '.')) {
    return { ok: false, reason: '"." or ".." segment not allowed' };
  }
  if (!normalized.endsWith('.md')) normalized += '.md';
  return { ok: true, normalized };
}

function appendSection(
  existing: string,
  section: string,
  content: string,
  isoStamp: string,
): string {
  const trimmedExisting = existing.endsWith('\n') ? existing : `${existing}\n`;
  const day = isoStamp.slice(0, 10);
  return [
    trimmedExisting.trimEnd(),
    '',
    `## ${section} (added ${day})`,
    '',
    content.trim(),
    '',
  ].join('\n');
}

async function applyKbWrites(
  repoRoot: string,
  writes: KbWrite[],
  nowIso: string,
): Promise<{
  written: { relPath: string; section: string }[];
  skipped: { relPath: string; reason: string }[];
}> {
  const written: { relPath: string; section: string }[] = [];
  const skipped: { relPath: string; reason: string }[] = [];
  const kbDir = path.join(repoRoot, KB_ROOT);

  for (const write of writes) {
    const check = sanitizeKbRelPath(write.relPath);
    if (!check.ok) {
      skipped.push({ relPath: write.relPath, reason: check.reason });
      continue;
    }
    const fullPath = path.join(kbDir, check.normalized);
    const dir = path.dirname(fullPath);
    await mkdir(dir, { recursive: true });
    let existing = '';
    if (await pathExists(fullPath)) {
      try {
        existing = await readFile(fullPath, 'utf8');
      } catch {
        existing = '';
      }
    }
    const next =
      existing.length === 0
        ? `# ${check.normalized.replace(/\.md$/, '').replace(/[/\\]/g, ' / ')}\n\n## ${write.section} (added ${nowIso.slice(0, 10)})\n\n${write.content.trim()}\n`
        : appendSection(existing, write.section, write.content, nowIso);
    await writeFile(fullPath, next, 'utf8');
    written.push({ relPath: path.join(KB_ROOT, check.normalized), section: write.section });
  }
  return { written, skipped };
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
    title: 'Knowledge base Q&A — answers',
    description:
      'You answer the LLM questions from the previous step (optional) and ask your own questions. The LLM checks the knowledge base, scans the code if needed, and writes new KB sections.',
    requiresCli: true,
  },

  async detect(ctx: StepContext): Promise<KnowledgeQaResolveDetect> {
    const prep = await loadPreviousStepOutput(ctx.db, ctx.taskId, '09-qa');
    const prepOutput = (prep?.output ?? null) as KnowledgeQaPrepApply | null;
    const agentQuestions = prepOutput?.agentQuestions ?? [];
    const explicitNoQuestions = prepOutput?.explicitNoQuestions ?? false;

    const prepDetect = (prep?.detect ?? null) as { kbFiles?: KbFileSummary[] } | null;
    const kbFiles = prepDetect?.kbFiles ?? [];

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
  },

  async apply(ctx, args): Promise<KnowledgeQaResolveApply> {
    const detected = args.detected as KnowledgeQaResolveDetect;
    const values = args.formValues as Record<string, unknown>;
    const parsed = parseQaResolveOutput(args.llmOutput);
    const userQuestionCount = splitUserQuestions(values[USER_QUESTIONS_FIELD]).length;
    const agentQuestionCount = collectAgentAnswers(detected.agentQuestions, values).length;

    const { written, skipped } = await applyKbWrites(
      ctx.repoPath,
      parsed.kbWrites,
      new Date().toISOString(),
    );

    ctx.logger.info(
      {
        kbWritten: written.length,
        kbSkipped: skipped.length,
        userQuestionCount,
        agentQuestionCount,
        answerCount: parsed.answers.length,
        unansweredCount: parsed.unanswered.length,
      },
      'qa-resolve apply complete',
    );

    return {
      kbWritten: written,
      kbSkipped: skipped,
      userQuestionCount,
      agentQuestionCount,
      answers: parsed.answers,
      unanswered: parsed.unanswered,
    };
  },
};
