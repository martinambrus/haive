/** Heuristic markdown detection — true when the body has a heading line, a fenced
 *  code block, an inline code span `` `x` ``, a bold run `**x**`, or a Markdown link
 *  `[text](url)`. Stays conservative on bare "- " lists and single `*`/`_` emphasis
 *  (which collide with plain text — bullet-looking prose, arithmetic, snake_case
 *  names) to avoid false positives; paired backticks / `**bold**` / a full link with
 *  parens are specific enough to be safe signals.
 *
 *  This decides the LINE-BREAK POLICY, nothing else. It used to gate whether a body
 *  was rendered as markdown at all, which made an identical block of prose jump
 *  between monospace-12px and the `.haive-md` sans-14px depending on whether it
 *  happened to contain a backtick. Every body now renders through MarkdownView;
 *  a false answer only means the soft-break plugin runs, so plain text keeps its
 *  newlines while hard-wrapped markdown prose still reflows to the column width. */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^\s*#{1,6}\s+\S/m.test(text) ||
    /^\s*```/m.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /\*\*[^\n]+?\*\*/.test(text) ||
    /\[[^\]\n]+\]\([^)\s]+\)/.test(text)
  );
}
