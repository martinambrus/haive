/** Pure pre-processing for MarkdownView: splits a spec markdown body into
 *  renderable segments BEFORE react-markdown sees it. Two conventions need
 *  source-level handling because react-markdown's component overrides see one
 *  hast node at a time (no reliable sibling adjacency):
 *
 *  1. The `## Comprehension Quiz` section becomes a `quiz` segment
 *     (interactive QuizBlock); on parse failure the text stays markdown.
 *  2. Two ADJACENT fenced blocks with info-strings exactly `before` and
 *     `after` (only blank lines between) become a `before-after` segment
 *     rendered side-by-side. Unpaired fences stay in the markdown stream.
 *
 *  Known trade-off: a body becomes multiple react-markdown instances, so
 *  reference-style links spanning a segment boundary would break — not a
 *  realistic shape for LLM-authored specs.
 */
import { scanFences, type Fence } from '@haive/shared/markdown-fences';
import { extractQuizSection, parseQuiz, type ParsedQuiz } from './quiz-parser';

export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'before-after'; before: string; after: string }
  | { kind: 'quiz'; quiz: ParsedQuiz };

/** PreBlock collapses a code block longer than this. */
export const COLLAPSE_LINES = 12;

/** Whether PreBlock will collapse any block here, so the expand/collapse-all toolbar has work. */
export function hasCollapsibleContent(segments: Segment[]): boolean {
  return segments.some(
    (segment) =>
      segment.kind === 'markdown' &&
      scanFences(segment.text.split('\n')).some(
        (f) =>
          f.content.length > COLLAPSE_LINES &&
          f.lang !== 'mermaid' &&
          f.lang !== 'before' &&
          f.lang !== 'after',
      ),
  );
}

function onlyBlankBetween(lines: string[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (lines[i]!.trim() !== '') return false;
  }
  return true;
}

/** Replaces adjacent ```before + ```after fence pairs with segments. */
function splitBeforeAfter(text: string): Segment[] {
  const lines = text.split('\n');
  const fences = scanFences(lines);
  const pairs: { before: Fence; after: Fence }[] = [];
  for (let i = 0; i < fences.length - 1; i++) {
    const a = fences[i]!;
    const b = fences[i + 1]!;
    if (
      a.lang === 'before' &&
      b.lang === 'after' &&
      a.close !== null &&
      b.close !== null &&
      onlyBlankBetween(lines, a.close + 1, b.open)
    ) {
      pairs.push({ before: a, after: b });
      i += 1; // consume both fences
    }
  }
  if (pairs.length === 0) return [{ kind: 'markdown', text }];

  const segments: Segment[] = [];
  let cursor = 0;
  for (const pair of pairs) {
    const head = lines.slice(cursor, pair.before.open).join('\n');
    if (head.trim().length > 0) segments.push({ kind: 'markdown', text: head });
    segments.push({
      kind: 'before-after',
      before: pair.before.content.join('\n'),
      after: pair.after.content.join('\n'),
    });
    cursor = pair.after.close! + 1;
  }
  const tail = lines.slice(cursor).join('\n');
  if (tail.trim().length > 0) segments.push({ kind: 'markdown', text: tail });
  return segments;
}

export function segmentMarkdownBody(body: string): Segment[] {
  // 1. Quiz split (fence-aware inside the extractor). Parse failure leaves
  //    the quiz text in the markdown stream — never break the page.
  const quizSplit = extractQuizSection(body);
  let chunks: { text: string; quiz: ParsedQuiz | null }[];
  if (quizSplit) {
    const parsed = parseQuiz(quizSplit.quizMarkdown);
    chunks = parsed
      ? [
          { text: quizSplit.before, quiz: null },
          { text: '', quiz: parsed },
          { text: quizSplit.after, quiz: null },
        ]
      : [{ text: body, quiz: null }];
  } else {
    chunks = [{ text: body, quiz: null }];
  }

  // 2. Before/after pairing within each remaining markdown chunk.
  const segments: Segment[] = [];
  for (const chunk of chunks) {
    if (chunk.quiz) {
      segments.push({ kind: 'quiz', quiz: chunk.quiz });
    } else if (chunk.text.trim().length > 0) {
      segments.push(...splitBeforeAfter(chunk.text));
    }
  }
  return segments.length > 0 ? segments : [{ kind: 'markdown', text: body }];
}
