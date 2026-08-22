'use client';

import { MarkdownView } from './markdown-view';

/** MarkdownView's own wrapper class for a body that sits INSIDE another styled
 *  block. Strips the standalone-body chrome (padding, scroll cap) and hands the
 *  colour and font-size back to the surrounding element via `.haive-md-inherit`,
 *  so a `text-xs` description stays small and an amber note stays amber. */
export const INLINE_MD_CLASS = 'haive-md-inherit max-h-none overflow-visible px-0 py-0';

/** Markdown typography for the short bodies that live inside another styled block —
 *  form, field and option descriptions. Same renderer as every other body, so a
 *  description reads the same whether or not it happens to contain a backtick.
 *
 *  The size/colour classes MUST sit on the wrapper rather than on MarkdownView's own
 *  element: `.haive-md-inherit` resolves `font-size: inherit` against the parent, so a
 *  `text-xs` on the same element would be what it inherits from, not what it applies.
 *
 *  `enhanced` is off — quizzes, before/after pairs and collapsible fences are spec-body
 *  conventions that never appear in a one-line description, and their toolbar would. */
export function InlineMarkdown({ body, className }: { body: string; className?: string }) {
  return (
    <div className={className}>
      <MarkdownView body={body} enhanced={false} className={INLINE_MD_CLASS} />
    </div>
  );
}
