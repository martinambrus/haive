import type { FormField, FormSchema } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { applyKbWrites, type KbWrite } from './_kb-write.js';
import type { KnowledgeQaResolveApply } from './09_2-qa-resolve.js';

/* ------------------------------------------------------------------ */
/* Human review gate for the Q&A answers gathered in 09_2.            */
/*                                                                     */
/* 09_2 finds answers but writes nothing. Here the user confirms each  */
/* answer to their own questions or corrects the wrong ones, and may   */
/* answer questions 09_2 left unanswered. Confirmed code-derived       */
/* answers are written deterministically; corrections / new answers go */
/* to an LLM that re-checks them against the code, cites files, and    */
/* writes the KB directly. Answers to the agent's OWN questions are     */
/* the user's authored text (source `user`) — they pass straight       */
/* through to the write, unreviewed.                                   */
/* ------------------------------------------------------------------ */

const CONFIRM_VALUE = '__confirm__';
const SKIP_VALUE = '__skip__';
const REVIEW_PREFIX = 'review__';
const UNANSWERED_PREFIX = 'unanswered__';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface ReviewItem {
  key: string;
  question: string;
  answer: string;
  source: 'kb' | 'code';
  citedFile?: string;
  proposedWrite?: KbWrite;
}

interface UnansweredItem {
  key: string;
  question: string;
  reason: string;
}

export interface QaReviewDetect {
  reviewable: ReviewItem[];
  unanswered: UnansweredItem[];
  /** Proposed writes for the agent's own questions (source `user`) — written
   *  verbatim, not surfaced for review. */
  passthrough: KbWrite[];
}

export interface QaReviewApply {
  kbWritten: { relPath: string; section: string }[];
  kbSkipped: { relPath: string; reason: string }[];
  confirmedCount: number;
  correctedCount: number;
  newlyAnsweredCount: number;
  stillUnansweredCount: number;
}

/* ------------------------------------------------------------------ */
/* Form value parsing                                                  */
/* ------------------------------------------------------------------ */

interface Correction {
  question: string;
  originalAnswer: string;
  source: 'kb' | 'code';
  citedFile?: string;
  userAnswer: string;
}

interface NewAnswer {
  question: string;
  reason: string;
  userAnswer: string;
}

export interface ReviewResult {
  /** Reviewable answers the user marked wrong, with their correction. */
  corrections: Correction[];
  /** Previously unanswered questions the user supplied an answer for. */
  newAnswers: NewAnswer[];
  /** Confirmed code-derived answers' proposed writes (written deterministically).
   *  Confirmed kb-derived answers are already in the KB, so they produce no write. */
  confirmedWrites: KbWrite[];
  confirmedCount: number;
}

/** Read the per-question review controls. A `radio-with-textarea` value is a
 *  single string: the sentinel (confirm/skip) when untouched, or the user's
 *  free-text answer when they chose to correct/answer. Empty is treated as the
 *  sentinel (no change). */
export function collectReview(
  detected: QaReviewDetect,
  values: Record<string, unknown>,
): ReviewResult {
  const corrections: Correction[] = [];
  const confirmedWrites: KbWrite[] = [];
  let confirmedCount = 0;

  for (const r of detected.reviewable) {
    const raw = values[`${REVIEW_PREFIX}${r.key}`];
    const val = typeof raw === 'string' ? raw.trim() : '';
    if (val.length === 0 || val === CONFIRM_VALUE) {
      confirmedCount += 1;
      if (r.source === 'code' && r.proposedWrite) confirmedWrites.push(r.proposedWrite);
      continue;
    }
    corrections.push({
      question: r.question,
      originalAnswer: r.answer,
      source: r.source,
      ...(r.citedFile ? { citedFile: r.citedFile } : {}),
      userAnswer: val,
    });
  }

  const newAnswers: NewAnswer[] = [];
  for (const u of detected.unanswered) {
    const raw = values[`${UNANSWERED_PREFIX}${u.key}`];
    const val = typeof raw === 'string' ? raw.trim() : '';
    if (val.length === 0 || val === SKIP_VALUE) continue;
    newAnswers.push({ question: u.question, reason: u.reason, userAnswer: val });
  }

  return { corrections, newAnswers, confirmedWrites, confirmedCount };
}

/* ------------------------------------------------------------------ */
/* Form generation                                                     */
/* ------------------------------------------------------------------ */

export function buildReviewForm(detected: QaReviewDetect): FormSchema {
  const fields: FormField[] = [];

  if (detected.reviewable.length > 0) {
    fields.push({
      type: 'accordion',
      id: 'review-answers',
      label: `Review answers (${detected.reviewable.length})`,
      description:
        'Expand each question. If the answer is right, leave it. If it is wrong, choose "No" and type the correct answer — the LLM will re-check it against the code and save it.',
      items: detected.reviewable.map((r) => ({
        title: r.question,
        defaultOpen: true,
        description: [
          `Answer: ${r.answer}`,
          `Source: ${r.source}${r.citedFile ? ` (${r.citedFile})` : ''}`,
        ].join('\n\n'),
        fields: [
          {
            type: 'radio-with-textarea' as const,
            id: `${REVIEW_PREFIX}${r.key}`,
            label: 'Is this answer correct?',
            predefined: [{ value: CONFIRM_VALUE, label: 'Answer is correct — keep it' }],
            default: CONFIRM_VALUE,
            customLabel: 'No — provide the correct answer',
            placeholder: 'Type the correct or complete answer.',
            rows: 4,
          },
        ],
      })),
    });
  }

  if (detected.unanswered.length > 0) {
    fields.push({
      type: 'accordion',
      id: 'unanswered-questions',
      label: `Unanswered questions (${detected.unanswered.length})`,
      description:
        'The LLM could not answer these from the knowledge base or the code. Provide an answer to save it (the LLM will verify it and cite code), or leave it unanswered.',
      items: detected.unanswered.map((u) => ({
        title: u.question,
        defaultOpen: true,
        description: `No answer found: ${u.reason}`,
        fields: [
          {
            type: 'radio-with-textarea' as const,
            id: `${UNANSWERED_PREFIX}${u.key}`,
            label: 'Provide an answer?',
            predefined: [{ value: SKIP_VALUE, label: 'Leave unanswered' }],
            default: SKIP_VALUE,
            customLabel: 'Provide the answer',
            placeholder: 'Type the answer to save to the knowledge base.',
            rows: 4,
          },
        ],
      })),
    });
  }

  const nothingToDecide = detected.reviewable.length === 0 && detected.unanswered.length === 0;

  return {
    title: 'Knowledge base Q&A — review answers',
    description: nothingToDecide
      ? 'No answers need your review. Saving your agent-question answers to the knowledge base.'
      : 'Confirm each answer the LLM found, or correct the wrong ones. Corrections are re-checked against the code and saved to the knowledge base.',
    fields,
    submitLabel: 'Confirm and update KB',
    ...(nothingToDecide ? { autoSubmit: true } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* LLM prompt                                                          */
/* ------------------------------------------------------------------ */

function buildPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as QaReviewDetect;
  const values = args.formValues as Record<string, unknown>;
  const { corrections, newAnswers } = collectReview(detected, values);

  const correctionsBlock =
    corrections.length > 0
      ? corrections
          .map((c, i) =>
            [
              `### ${i + 1}. ${c.question}`,
              `LLM's original answer: ${c.originalAnswer}`,
              c.citedFile ? `Originally cited: ${c.citedFile}` : '',
              c.source === 'kb'
                ? `This answer was read from the knowledge base file ${c.citedFile ?? '(unknown)'} — that file is WRONG and must be corrected in place.`
                : '',
              `User's correct answer: ${c.userAnswer}`,
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n')
      : '(none)';

  const newAnswersBlock =
    newAnswers.length > 0
      ? newAnswers
          .map((n, i) =>
            [
              `### ${i + 1}. ${n.question}`,
              `Reason it was unanswered: ${n.reason}`,
              `User's answer: ${n.userAnswer}`,
            ].join('\n'),
          )
          .join('\n\n')
      : '(none)';

  return [
    'You are a senior software engineer finalizing the project knowledge base after a human review.',
    'The user reviewed the answers you produced earlier and (a) CORRECTED some of them and/or',
    '(b) supplied answers for questions you could not answer. Treat the user as authoritative.',
    '',
    'For EACH item below:',
    "  1. Use your file-reading tools to verify the user's answer against the actual code.",
    '  2. Write the answer into the knowledge base, citing the specific file paths you read so the',
    "     entry is grounded. Keep the user's meaning; add code references and detail.",
    '  3. Write the files DIRECTLY with your edit tools (you are inside the repository):',
    '     - Knowledge base files live under `.claude/knowledge_base/`.',
    '     - For a correction of an answer that came from an EXISTING knowledge base file, EDIT that',
    '       file in place (replace the stale content) — do NOT append a duplicate section.',
    '     - Otherwise append a new `## <section>` to a fitting file, or create one under',
    '       `.claude/knowledge_base/QA/<slug>.md`.',
    '',
    'Call your tools DIRECTLY — issue the actual tool calls; do NOT narrate intent and then stop.',
    '',
    '## (a) Corrected answers',
    correctionsBlock,
    '',
    '## (b) Newly answered questions',
    newAnswersBlock,
    '',
    '## Output format',
    '',
    'AFTER you have written the files, emit exactly ONE JSON object inside a ```json fenced block',
    'summarizing what you wrote:',
    '```',
    '{ "kbWrites": [ { "relPath": ".claude/knowledge_base/BUSINESS_LOGIC.md", "section": "Order delivery" } ] }',
    '```',
    '- relPath: the knowledge base file you wrote.',
    '- section: the H2 heading you added or edited.',
    '- Use an empty kbWrites array only if you genuinely wrote nothing.',
    '- Your FINAL message MUST be the ```json block — never narration or a tool result.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* LLM output parsing (lenient — the agent already wrote the files)    */
/* ------------------------------------------------------------------ */

interface ReviewWriteSummary {
  kbWrites: { relPath: string; section: string }[];
}

/** Parse the agent's write summary. LENIENT by design: the agent writes the KB
 *  files directly via its tools, so this summary is only for the done-card record.
 *  A parse failure must NOT trigger a retry (that would re-run the side-effecting
 *  agent and double-write), so we degrade to an empty summary instead of throwing. */
export function parseQaReviewOutput(raw: unknown): ReviewWriteSummary {
  let source: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'result' in (raw as Record<string, unknown>)) {
    source = (raw as Record<string, unknown>).result;
  }
  let parsed: unknown = null;
  if (typeof source === 'string') {
    parsed = parseJsonLoose(source);
  } else if (typeof source === 'object' && source !== null) {
    parsed = source;
  }
  if (!parsed || typeof parsed !== 'object') return { kbWrites: [] };
  const list = (parsed as Record<string, unknown>).kbWrites;
  if (!Array.isArray(list)) return { kbWrites: [] };
  const kbWrites: { relPath: string; section: string }[] = [];
  for (const item of list as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    if (typeof v.relPath !== 'string' || v.relPath.length === 0) continue;
    const section = typeof v.section === 'string' ? v.section : '';
    kbWrites.push({ relPath: v.relPath, section });
  }
  return { kbWrites };
}

/* ------------------------------------------------------------------ */
/* Detect                                                              */
/* ------------------------------------------------------------------ */

async function loadResolveOutput(ctx: StepContext): Promise<KnowledgeQaResolveApply | null> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '09_2-qa-resolve');
  return (prev?.output ?? null) as KnowledgeQaResolveApply | null;
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const knowledgeQaReviewStep: StepDefinition<QaReviewDetect, QaReviewApply> = {
  metadata: {
    id: '09_3-qa-review',
    workflowType: 'onboarding',
    index: 10.75,
    title: 'Knowledge base Q&A — review answers',
    description:
      'Confirm or correct the answers the LLM found for your questions before they are saved. Corrections (and answers you supply for unanswered questions) are re-checked against the code and written to the knowledge base.',
    requiresCli: true,
  },

  // Runs only when 09_2 gathered something to act on: an answer to one of the
  // user's own questions (source kb/code), an unanswered question, or an agent
  // answer to write through. Otherwise there is nothing to do.
  async shouldRun(ctx: StepContext): Promise<boolean> {
    const out = await loadResolveOutput(ctx);
    if (!out) return false;
    const hasReviewable = (out.answers ?? []).some((a) => a.source !== 'user');
    const hasUnanswered = (out.unanswered ?? []).length > 0;
    const hasPassthrough = (out.answers ?? []).some((a) => a.source === 'user' && a.proposedWrite);
    return hasReviewable || hasUnanswered || hasPassthrough;
  },

  async detect(ctx: StepContext): Promise<QaReviewDetect> {
    const out = await loadResolveOutput(ctx);
    const answers = out?.answers ?? [];
    const unansweredRaw = out?.unanswered ?? [];

    const reviewable: ReviewItem[] = [];
    const passthrough: KbWrite[] = [];
    for (const a of answers) {
      if (a.source === 'user') {
        if (a.proposedWrite) passthrough.push(a.proposedWrite);
        continue;
      }
      reviewable.push({
        key: String(reviewable.length),
        question: a.question,
        answer: a.answer,
        source: a.source,
        ...(a.citedFile ? { citedFile: a.citedFile } : {}),
        ...(a.proposedWrite ? { proposedWrite: a.proposedWrite } : {}),
      });
    }
    const unanswered: UnansweredItem[] = unansweredRaw.map((u, i) => ({
      key: String(i),
      question: u.question,
      reason: u.reason,
    }));

    ctx.logger.info(
      {
        reviewableCount: reviewable.length,
        unansweredCount: unanswered.length,
        passthroughCount: passthrough.length,
      },
      'qa-review detect complete',
    );
    return { reviewable, unanswered, passthrough };
  },

  form(_ctx, detected): FormSchema {
    return buildReviewForm(detected);
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    buildPrompt,
    timeoutMs: 60 * 60 * 1000,
    // Skip the LLM entirely when the user confirmed everything and answered no
    // unanswered questions — then there is nothing to re-check or write via the
    // agent; apply still writes the confirmed/passthrough proposals deterministically.
    skipIf: (args) => {
      const detected = args.detected as QaReviewDetect;
      const r = collectReview(detected, args.formValues as Record<string, unknown>);
      return r.corrections.length === 0 && r.newAnswers.length === 0;
    },
    // No retry: this agent WRITES the KB directly, so a re-roll would double-write.
    // parseQaReviewOutput is lenient and never throws.
    bypassStub: () => ({ kbWrites: [] }),
  },

  async apply(ctx, args): Promise<QaReviewApply> {
    const detected = args.detected as QaReviewDetect;
    const values = args.formValues as Record<string, unknown>;
    const review = collectReview(detected, values);

    // Deterministic writes: confirmed code-derived proposals + agent-question
    // answers (source user). Confirmed kb-derived answers are already in the KB.
    const deterministicWrites: KbWrite[] = [...review.confirmedWrites, ...detected.passthrough];
    const { written, skipped } = await applyKbWrites(
      ctx.repoPath,
      deterministicWrites,
      new Date().toISOString(),
    );

    // Corrections / new answers were written by the agent directly; record its
    // summary for the done card (best-effort — the writes themselves already ran).
    const llmWrites =
      args.llmOutput === undefined ? [] : parseQaReviewOutput(args.llmOutput).kbWrites;

    ctx.logger.info(
      {
        kbWritten: written.length + llmWrites.length,
        kbSkipped: skipped.length,
        confirmedCount: review.confirmedCount,
        correctedCount: review.corrections.length,
        newlyAnsweredCount: review.newAnswers.length,
      },
      'qa-review apply complete',
    );

    return {
      kbWritten: [...written, ...llmWrites],
      kbSkipped: skipped,
      confirmedCount: review.confirmedCount,
      correctedCount: review.corrections.length,
      newlyAnsweredCount: review.newAnswers.length,
      stillUnansweredCount: detected.unanswered.length - review.newAnswers.length,
    };
  },
};
