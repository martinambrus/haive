'use client';

import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Markdown } from './markdown';
import { remarkSoftBreaks } from './remark-soft-breaks';
import { MarkdownView } from './markdown-view';

/** MarkdownView's own wrapper class for a body that sits INSIDE another styled
 *  block. Strips the standalone-body chrome (padding, scroll cap) and hands the
 *  colour and font-size back to the surrounding element via `.haive-md-inherit`,
 *  so a `text-xs` description stays small and an amber note stays amber. */
export const INLINE_MD_CLASS = 'haive-md-inherit max-h-none overflow-visible px-0 py-0';

// One-line UI copy must stay phrasing content, including when an error contains
// block markdown. The shared Markdown renderer still applies image/link policy.
const PHRASING_ELEMENTS = ['a', 'em', 'strong', 'code', 'del', 'br'];
const INLINE_COMPONENTS: Components = {
  a({ node: _node, children, ...rest }) {
    return (
      <a {...rest} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

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
export function InlineMarkdown({
  body,
  className,
  inline = false,
}: {
  body: string;
  className?: string;
  /** Keep short row copy inside spans, without block descendants. */
  inline?: boolean;
}) {
  if (inline) {
    return (
      <span className={className}>
        <span className={`haive-md ${INLINE_MD_CLASS}`}>
          <Markdown
            remarkPlugins={[remarkGfm, remarkSoftBreaks]}
            allowedElements={PHRASING_ELEMENTS}
            unwrapDisallowed
            components={INLINE_COMPONENTS}
          >
            {body}
          </Markdown>
        </span>
      </span>
    );
  }
  return (
    <div className={className}>
      <MarkdownView body={body} enhanced={false} className={INLINE_MD_CLASS} />
    </div>
  );
}
