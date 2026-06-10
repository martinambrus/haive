'use client';

import { useMemo, useRef } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent } from 'hast';
import { segmentMarkdownBody, type Segment } from './markdown-segments';
import { QuizBlock } from './quiz-block';
import { MermaidBlock } from './mermaid-block';
import { BeforeAfterBlock, BeforeAfterPanel } from './before-after-block';

/** Heuristic markdown detection — true when the body contains at least one
 *  heading line or a fenced code block. Avoids false positives on plain "- "
 *  lists or "**" emphasis which appear in regular text outputs. */
export function looksLikeMarkdown(text: string): boolean {
  return /^\s*#{1,6}\s+\S/m.test(text) || /^\s*```/m.test(text);
}

/** Fenced code blocks longer than this render collapsed inside <details>. */
const COLLAPSE_LINES = 12;

function textOf(nodes: ElementContent[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'element') out += textOf(n.children);
  }
  return out;
}

function fenceLanguage(node: Element | undefined): string | null {
  const code = node?.children?.[0];
  if (!code || code.type !== 'element' || code.tagName !== 'code') return null;
  const className = code.properties?.className;
  if (!Array.isArray(className)) return null;
  for (const cls of className) {
    const m = /^language-(.+)$/.exec(String(cls));
    if (m) return m[1]!;
  }
  return null;
}

type PreProps = React.ComponentPropsWithoutRef<'pre'> & ExtraProps;

/** react-markdown v10 only produces <pre> for fenced code blocks, so this is
 *  the reliable interception point (there is no `inline` prop in v10).
 *  mermaid fences render as diagrams; unpaired before/after fences as a
 *  single tinted panel; long fences collapse into an UNCONTROLLED <details>
 *  (no `open` prop) so the expand/collapse-all DOM mutation doesn't fight
 *  React. */
function PreBlock({ node, children, ...rest }: PreProps) {
  const lang = fenceLanguage(node);
  const raw = textOf(node?.children).replace(/\n$/, '');
  if (lang === 'mermaid') return <MermaidBlock source={raw} />;
  if (lang === 'before' || lang === 'after') return <BeforeAfterPanel side={lang} code={raw} />;
  const lines = raw.length === 0 ? 0 : raw.split('\n').length;
  if (lines > COLLAPSE_LINES) {
    return (
      <details className="haive-code-details">
        <summary>
          Show code — {lines} lines{lang ? ` (${lang})` : ''}
        </summary>
        <pre {...rest}>{children}</pre>
      </details>
    );
  }
  return <pre {...rest}>{children}</pre>;
}

const MD_COMPONENTS: Components = { pre: PreBlock };

function hasCollapsibleContent(segments: Segment[]): boolean {
  return segments.some((segment) => {
    if (segment.kind !== 'markdown') return false;
    // Cheap line-count scan over fences in the raw text — mirrors PreBlock.
    const lines = segment.text.split('\n');
    let inFence = false;
    let count = 0;
    let lang = '';
    for (const line of lines) {
      const open = /^\s*```(\S*)\s*$/.exec(line);
      if (!inFence && open) {
        inFence = true;
        count = 0;
        lang = open[1] ?? '';
        continue;
      }
      if (inFence && /^\s*```\s*$/.test(line)) {
        inFence = false;
        if (count > COLLAPSE_LINES && lang !== 'mermaid' && lang !== 'before' && lang !== 'after')
          return true;
        continue;
      }
      if (inFence) count += 1;
    }
    return false;
  });
}

/** Markdown renderer for infoSection bodies. `enhanced` (default) upgrades
 *  the spec's authoring conventions: interactive comprehension quiz, mermaid
 *  diagrams, side-by-side before/after pairs, collapsed long code blocks
 *  with an expand/collapse-all toolbar. Non-spec bodies are unaffected —
 *  without those conventions this renders exactly like plain ReactMarkdown. */
export function MarkdownView({ body, enhanced = true }: { body: string; enhanced?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const segments = useMemo<Segment[]>(
    () => (enhanced ? segmentMarkdownBody(body) : [{ kind: 'markdown', text: body }]),
    [body, enhanced],
  );
  const collapsible = useMemo(
    () => enhanced && hasCollapsibleContent(segments),
    [segments, enhanced],
  );

  const setAll = (open: boolean) => {
    rootRef.current?.querySelectorAll('details').forEach((d) => {
      d.open = open;
    });
  };

  return (
    <div ref={rootRef} className="haive-md max-h-96 overflow-auto px-3 py-2">
      {collapsible && (
        <div className="mb-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setAll(true)}
            className="text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setAll(false)}
            className="text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            Collapse all
          </button>
        </div>
      )}
      {segments.map((segment, i) => {
        if (segment.kind === 'quiz') return <QuizBlock key={i} quiz={segment.quiz} />;
        if (segment.kind === 'before-after') {
          return <BeforeAfterBlock key={i} before={segment.before} after={segment.after} />;
        }
        return (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {segment.text}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}
