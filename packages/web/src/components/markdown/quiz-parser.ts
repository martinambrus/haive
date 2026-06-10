/** Pure parser for the spec's `## Comprehension Quiz` markdown convention:
 *
 *   ## Comprehension Quiz
 *   ### Q1: <question text>
 *   - [ ] <wrong answer>
 *   - [x] <correct answer>
 *   - [ ] <wrong answer>
 *   > Explanation: <why, citing the spec section>
 *
 * Authored by the spec-writing LLM (04-phase-0b prompt), validated by the
 * spec-quality reviewer, rendered interactively by QuizBlock. Parsing is
 * best-effort: anything malformed degrades to plain markdown — the quiz must
 * never break the spec page.
 */

export interface QuizOption {
  text: string;
  correct: boolean;
}

export interface QuizQuestion {
  prompt: string;
  options: QuizOption[];
  explanation: string | null;
}

export interface ParsedQuiz {
  questions: QuizQuestion[];
}

const FENCE_RE = /^\s*```/;
const QUIZ_HEADING_RE = /^##\s+comprehension quiz\b/i;
const SECTION_HEADING_RE = /^##\s+/;
const OPTION_RE = /^[-*]\s+\[([ xX])\]\s+(.+)$/;
const QUESTION_HEADING_RE = /^###\s+(.+)$/;
const EXPLANATION_RE = /^>\s*Explanation:\s*(.*)$/i;
const BLOCKQUOTE_CONT_RE = /^>\s?(.*)$/;

/** Splits the body around the quiz section (fence-aware so a quiz heading
 *  quoted inside a code block is ignored). The section runs from its `## `
 *  heading to the next non-fenced `## ` heading or EOF. Returns null when no
 *  quiz heading exists. */
export function extractQuizSection(
  body: string,
): { before: string; quizMarkdown: string; after: string } | null {
  const lines = body.split('\n');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (start === -1) {
      if (QUIZ_HEADING_RE.test(line)) start = i;
    } else if (SECTION_HEADING_RE.test(line)) {
      end = i;
      break;
    }
  }
  if (start === -1) return null;
  return {
    before: lines.slice(0, start).join('\n'),
    quizMarkdown: lines.slice(start, end).join('\n'),
    after: lines.slice(end).join('\n'),
  };
}

/** Parses the quiz section markdown into questions. A question is valid with
 *  at least two options and exactly one correct ([x]) option; invalid
 *  questions are dropped. Returns null when no valid question remains so the
 *  caller can fall back to rendering the section as plain markdown. */
export function parseQuiz(quizMarkdown: string): ParsedQuiz | null {
  const lines = quizMarkdown.split('\n');
  const questions: QuizQuestion[] = [];

  let prompt: string | null = null;
  let options: QuizOption[] = [];
  let explanation: string | null = null;
  let inExplanation = false;
  let inFence = false;

  const flush = (): void => {
    if (prompt === null) return;
    const correctCount = options.filter((o) => o.correct).length;
    if (options.length >= 2 && correctCount === 1) {
      questions.push({ prompt, options, explanation });
    }
    prompt = null;
    options = [];
    explanation = null;
    inExplanation = false;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      inExplanation = false;
      continue;
    }
    if (inFence) continue;

    const heading = QUESTION_HEADING_RE.exec(line);
    if (heading) {
      flush();
      // Strip an optional leading "Q3:" / "Q3." marker from the prompt.
      prompt = heading[1]!.replace(/^Q\d+[:.]?\s*/i, '').trim();
      continue;
    }
    if (prompt === null) continue;

    const option = OPTION_RE.exec(line);
    if (option) {
      inExplanation = false;
      options.push({ text: option[2]!.trim(), correct: option[1]!.toLowerCase() === 'x' });
      continue;
    }

    const expl = EXPLANATION_RE.exec(line);
    if (expl) {
      explanation = expl[1]!.trim();
      inExplanation = true;
      continue;
    }
    if (inExplanation) {
      const cont = BLOCKQUOTE_CONT_RE.exec(line);
      if (cont && cont[1]!.trim().length > 0) {
        explanation = `${explanation ?? ''} ${cont[1]!.trim()}`.trim();
        continue;
      }
      inExplanation = false;
    }
  }
  flush();

  if (questions.length === 0) return null;
  return { questions };
}
