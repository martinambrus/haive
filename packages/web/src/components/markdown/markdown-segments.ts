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
import { extractQuizSection, parseQuiz, type ParsedQuiz } from './quiz-parser';

export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'before-after'; before: string; after: string }
  | { kind: 'quiz'; quiz: ParsedQuiz };

const FENCE_OPEN_RE = /^\s*```(\S*)\s*$/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;

interface Fence {
  lang: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** Scans for complete top-level fences. An unterminated trailing fence is
 *  simply not collected, so it can never participate in a pair. */
function scanFences(lines: string[]): Fence[] {
  const fences: Fence[] = [];
  let open: { lang: string; startLine: number; content: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open === null) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m) open = { lang: m[1] ?? '', startLine: i, content: [] };
      continue;
    }
    if (FENCE_CLOSE_RE.test(line)) {
      fences.push({
        lang: open.lang,
        startLine: open.startLine,
        endLine: i,
        content: open.content.join('\n'),
      });
      open = null;
    } else {
      open.content.push(line);
    }
  }
  return fences;
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
      onlyBlankBetween(lines, a.endLine + 1, b.startLine)
    ) {
      pairs.push({ before: a, after: b });
      i += 1; // consume both fences
    }
  }
  if (pairs.length === 0) return [{ kind: 'markdown', text }];

  const segments: Segment[] = [];
  let cursor = 0;
  for (const pair of pairs) {
    const head = lines.slice(cursor, pair.before.startLine).join('\n');
    if (head.trim().length > 0) segments.push({ kind: 'markdown', text: head });
    segments.push({ kind: 'before-after', before: pair.before.content, after: pair.after.content });
    cursor = pair.after.endLine + 1;
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
